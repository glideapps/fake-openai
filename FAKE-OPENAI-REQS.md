# Fake OpenAI Service — Requirements

> **Status:** Proposal. This document specifies a mock ("fake OpenAI") service that lets pi-orb run fully hermetic end-to-end tests with no real OpenAI account, no outbound network, and no real LLM. It is a requirements/spec document, not an implementation. All endpoint URLs, header names, JSON field names, and SSE event-type strings below were extracted from the vendored Pi stack (`@earendil-works/pi-coding-agent` → `@earendil-works/pi-ai`) as embedded in this repo; where the sources contradicted prior assumptions, the sources win and the surprise is called out. Keep this file synchronized when the pinned Pi version changes the OAuth or Codex Responses surface.

Source files this document is derived from (all under `node_modules/@earendil-works/pi-coding-agent`):

- `node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js` — OAuth (device-code + browser).
- `node_modules/@earendil-works/pi-ai/dist/auth/oauth/device-code.js` — shared device-flow poller.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js` — Codex model transport (SSE + WebSocket).
- `node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js` — the streaming event parser.
- `node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js` + `openai-codex.models.js` — provider composition and baked-in model catalog.
- `dist/core/model-runtime.js`, `dist/core/provider-composer.js`, `dist/core/model-config.js`, `dist/core/remote-catalog-provider.js`, `dist/config.js` — ModelRuntime, `models.json` override path, catalog refresh.

pi-orb consumers: `apps/control-plane/src/adapters/pi-auth/gate.ts` (device-flow auth gate) and `apps/orb-runtime/src/pi/agent.ts` (session + streaming). DESIGN.md §15.1 defines the credential model; §11.2 / §14 define what E2E must demonstrate.

---

## 1. Problem and purpose

pi-orb embeds Pi, which talks to OpenAI exclusively through Pi's built-in `openai-codex` provider — a **ChatGPT Plus/Pro subscription OAuth** flow, **not** an API key. Every meaningful E2E path therefore depends on two live external surfaces:

1. **`auth.openai.com`** — the OAuth device-code login and token refresh. Exercised by the control-plane auth gate (`PiAuthGate` → `ModelRuntime.login`/`getAuth`) and by every orb-runtime boot (`ModelRuntime.getAuth("openai-codex")`).
2. **`chatgpt.com/backend-api`** — the Codex **Responses** streaming backend. Exercised by orb-runtime when Pi runs a turn (`createAgentSession` → `session.sendUserMessage` → streaming events → tool calls → abort).

The fake OpenAI service replaces both so that CI and local E2E can:

- drive the control-plane device-login gate (challenge issuance, polling, auto-/manual-approve, expiry, failure);
- drive token refresh under Pi's credential-store lock (success, failure, rotation);
- drive Pi streaming turns with **scripted** text, reasoning, and tool calls, including multi-turn tool loops where the *real* Pi tool executes inside the orb container and its result comes back in the next request;
- exercise abort, usage accounting, stop reasons, retries, rate-limit handling, and mid-stream errors;

all deterministically, offline, with no real credential.

The mock supplies **only the model + auth side**. Tool execution (bash, file edits, git) still runs for real inside the orb container — the mock just decides *which tool the model asks for* and *what final text it emits*.

## 2. Goals

- Serve the exact OAuth device-code + token endpoints pi-ai calls, with faithful polling and error semantics.
- Serve the exact Codex Responses streaming endpoint with the full SSE event vocabulary pi-ai's parser consumes.
- Let tests declare, per scenario, what the "model" answers, matched to requests by predicates.
- Be deterministic: stable IDs, byte-identical reruns for the same scenario + inputs, no wall-clock dependence beyond explicitly configured delays.
- Expose a test-only control API for approval, reset, and request assertions.

## 3. Non-goals

- No real inference of any kind. The mock never "understands" a prompt; it only matches predicates and replays scripted steps.
- No fidelity to OpenAI semantics beyond what pi-ai actually exercises (fields pi-ai ignores may be omitted or stubbed).
- **No browser-login (authorization-code + localhost:1455 redirect) flow.** `PiAuthGate` in `apps/control-plane/src/adapters/pi-auth/gate.ts` unconditionally selects the `device_code` login method (it resolves the `select` prompt to the option whose `id === "device_code"` and rejects anything else). The browser endpoints (`/oauth/authorize`, the `http://localhost:1455/auth/callback` server) are therefore **out of scope**. They are documented in §4.1 only for completeness.
- No persistence across process runs. All state is in-memory and reset per test.
- No WebSocket *implementation* is required (see §4.3): the mock may simply refuse WS so pi-ai falls back to SSE.

---

## 4. Endpoint inventory

Two hosts are involved. Constants are quoted verbatim from the sources.

- OAuth host: `AUTH_BASE_URL = "https://auth.openai.com"` (hardcoded in `openai-codex.js`; **not** env-overridable — see §5).
- Model host: `DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api"` (hardcoded default in `openai-codex-responses.js` and baked into every model's `baseUrl`; **is** overridable via `models.json` — see §5).
- Public OAuth client id (safe to hardcode in the mock): `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`.

### 4.1 OAuth — device-code flow (MUST implement faithfully)

**(a) Start device authorization**

```
POST https://auth.openai.com/api/accounts/deviceauth/usercode
Content-Type: application/json
Body: { "client_id": "app_EMoamEEZ73f0CkXaXp7hrann" }
```

Success response (200, JSON) — required fields validated by pi-ai:

```json
{ "device_auth_id": "<opaque>", "user_code": "ABCD-1234", "interval": 5 }
```

- `interval` may be a number **or** a numeric string (pi-ai does `Number(json.interval.trim())` for strings). It must parse to a finite number ≥ 0.
- `404` from this endpoint is specially mapped to "device code login is not enabled" — the mock returns 200.
- pi-ai then notifies the caller with `verificationUri = "https://auth.openai.com/codex/device"`, the `userCode`, `intervalSeconds`, and `expiresInSeconds = 900` (`DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60`). The control-plane surfaces these in `OrbView.actionRequired`.

**(b) Poll for authorization**

```
POST https://auth.openai.com/api/accounts/deviceauth/token
Content-Type: application/json
Body: { "device_auth_id": "<from (a)>", "user_code": "<from (a)>" }
```

Response semantics pi-ai's poller (`pollOpenAICodexDeviceAuth`) understands:

| Condition | HTTP | Body | pi-ai interpretation |
|---|---|---|---|
| Approved | 200 | `{ "authorization_code": "<code>", "code_verifier": "<verifier>" }` | **complete** — both fields required, else "failed" |
| Not yet approved | 403 **or** 404 | (any) | **pending** (keep polling) |
| Not yet approved | other non-2xx | `{ "error": { "code": "deviceauth_authorization_pending" } }` or `{ "error": "deviceauth_authorization_pending" }` | **pending** |
| Back off | other non-2xx | `{ "error": { "code": "slow_down" } }` (or string form) | **slow_down** (interval += 5s per RFC 8628) |
| Failed | other non-2xx | any other `error.code` | **failed** (surfaces error text) |

Poller timing (`device-code.js`): first poll happens immediately (no `waitBeforeFirstPoll` in the Codex path); minimum interval is 1000 ms; on `slow_down` the interval increases by 5000 ms (or to a server-provided `interval` if supplied). Overall deadline is 900 s (`expiresInSeconds`), after which pi-ai throws "Device flow timed out".

**(c) Exchange the device authorization code for tokens**

After a `complete` poll, pi-ai calls the token endpoint with the device redirect URI:

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded
Body:
  grant_type=authorization_code
  client_id=app_EMoamEEZ73f0CkXaXp7hrann
  code=<authorization_code from (b)>
  code_verifier=<code_verifier from (b)>
  redirect_uri=https://auth.openai.com/deviceauth/callback
```

Success (200, JSON) — required fields (`readTokenResponse` throws if any missing):

```json
{ "access_token": "<JWT>", "refresh_token": "<opaque>", "expires_in": 3600 }
```

- `access_token` **MUST be a parseable JWT** — see §6 (hard requirement).
- `expires_in` must be a `number` (seconds); pi-ai stores `expires = Date.now() + expires_in*1000`.

### 4.2 OAuth — token refresh (MUST implement faithfully)

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded
Body:
  grant_type=refresh_token
  refresh_token=<stored refresh token>
  client_id=app_EMoamEEZ73f0CkXaXp7hrann
```

Success response shape is identical to §4.1(c): `{ access_token, refresh_token, expires_in }`. pi-ai's `refreshAccessToken` requires all three; the new `refresh_token` may be rotated (different value) — the mock must be able to rotate it to test rotation, and must be able to return a 4xx/5xx to test refresh failure. This endpoint is hit both by the control-plane gate (`ModelRuntime.getAuth` when the access token is expired) and by every orb-runtime boot that resolves auth with an expired token.

### 4.3 Model — Codex Responses streaming (MUST implement faithfully)

**Endpoint** (`resolveCodexUrl`): the model `baseUrl` (default `https://chatgpt.com/backend-api`), trailing slashes stripped, then:
- if it already ends `/codex/responses` → used as-is;
- else if it ends `/codex` → `+ "/responses"`;
- else → `+ "/codex/responses"`.

So with the default base the request is:

```
POST https://chatgpt.com/backend-api/codex/responses
```

**Transport (important surprise):** the default `transport` is `"auto"`, which makes pi-ai attempt a **WebSocket first** (`wss://…/codex/responses`, `OpenAI-Beta: responses_websockets=2026-02-06`, sending a `{"type":"response.create", …body}` frame and reading the same event JSON as text messages). On any WebSocket connect/transport failure it records a per-session fallback and **retries over SSE**. Therefore the mock does **not** need to implement WebSocket: **refusing / immediately closing the WS connection is sufficient to force the SSE path**, which is the path the mock implements faithfully. (If a test explicitly wants to assert no WS attempt, it can set `transport: "sse"`, but pi-orb does not currently plumb that option, so the default is "auto" and the mock must tolerate a WS connect attempt by rejecting it.)

**Required request headers** (`buildSSEHeaders`):

| Header | Value |
|---|---|
| `Authorization` | `Bearer <access_token>` (the OAuth access token is used as the "apiKey" — `toAuth` returns `{ apiKey: credential.access }`) |
| `chatgpt-account-id` | the `chatgpt_account_id` extracted from the access-token JWT (§6) |
| `originator` | `pi` |
| `User-Agent` | e.g. `pi (linux 6.x; x64)` |
| `OpenAI-Beta` | `responses=experimental` |
| `accept` | `text/event-stream` |
| `content-type` | `application/json` |
| `session-id`, `x-client-request-id` | present only when a session id is set |
| `content-encoding` | `zstd` **when the request body is zstd-compressed** |

**Surprise — request body may be zstd-compressed.** On the SSE path pi-ai zstd-compresses the JSON body (Node `zlib.zstdCompressSync`, level 3) and sets `content-encoding: zstd`. The mock's request handler **must accept a zstd-encoded body** (decompress when `content-encoding: zstd` is present) — otherwise it cannot read the prompt to match predicates. (Compression is skipped in environments without `zstd`; handle both.)

**Request body shape** (`buildRequestBody`) — fields the mock may read for predicate matching:

```jsonc
{
  "model": "gpt-5.4",                       // model.id
  "store": false,                            // always false (backend rejects store:true)
  "stream": true,
  "instructions": "<system prompt>",
  "input": [ /* Responses-API items: input_text, output_text, function_call, function_call_output, … */ ],
  "text": { "verbosity": "low" },
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "<session id or undefined>",
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "tools": [ { "type": "function", "name": "...", "description": "...", "parameters": {…}, "strict": null } ],  // only if tools present
  "reasoning": { "effort": "medium", "summary": "auto" }   // only if reasoning effort set
}
```

The `input` array is where the mock finds the latest user message and prior tool results (for multi-turn matching). User text arrives as `{ "role": "user", "content": [{ "type": "input_text", "text": "…" }] }`; a tool result from a previous turn arrives as `{ "type": "function_call_output", "call_id": "…", "output": "…" }`.

**Response — SSE stream.** `Content-Type: text/event-stream`. pi-ai's parser splits on `\n\n`, reads `data:` lines, ignores `data: [DONE]`, and `JSON.parse`s each event. The mock emits events as:

```
data: {"type":"response.created","response":{"id":"resp_..."}}

data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_..."}}

...

data: {"type":"response.completed","response":{...}}

```

### 4.3.1 SSE event vocabulary the mock must be able to produce

Every event pi-ai's parser (`processResponsesStream` + `mapCodexEvents`) handles, with the JSON shape it reads. `output_index` ties deltas to the item they belong to (a "slot"). The mock must emit `response.output_item.added` (or a matching `.done`) to open a slot **before** emitting deltas for that index.

**Lifecycle / response**

| `type` | Shape read by pi-ai | Effect |
|---|---|---|
| `response.created` | `{ response: { id } }` | sets `output.responseId` |
| `response.output_item.added` | `{ output_index, item: { type, id, call_id?, name?, arguments? } }` | opens a slot; `item.type` ∈ `reasoning` \| `message` \| `function_call` |
| `response.output_item.done` | `{ output_index, item }` | finalizes the slot (item shape depends on type; see below) |
| `response.completed` | `{ response: { id, status, usage?, service_tier?, output?[] } }` | terminal; maps stop reason |
| `response.incomplete` | same as completed | terminal; stop reason `length` |
| `response.done` | same | normalized to `response.completed` by `mapCodexEvents` |
| `response.failed` | `{ response: { error?: { code, message }, incomplete_details?: { reason } } }` | throws → stream error |
| `error` | `{ code, message }` or `{ error: { code, message } }` | throws `CodexApiError` → stream error |

**Reasoning (thinking) deltas**

| `type` | Shape | Effect |
|---|---|---|
| `response.reasoning_summary_text.delta` | `{ output_index, delta }` | append `delta` to thinking |
| `response.reasoning_text.delta` | `{ output_index, delta }` | append `delta` to thinking |
| `response.reasoning_summary_part.done` | `{ output_index }` | appends `"\n\n"` between parts |

`response.output_item.done` for a reasoning item reads `{ item: { type:"reasoning", id, summary?:[{text}], content?:[{text}], encrypted_content? } }`. The final thinking text is `summary[].text` joined by `\n\n`, else `content[].text`, else the accumulated deltas. The whole item is JSON-stringified and stored as the block's `thinkingSignature` (replayed verbatim next turn), so the mock should emit a stable, self-consistent reasoning item.

**Text / refusal deltas**

| `type` | Shape | Effect |
|---|---|---|
| `response.output_text.delta` | `{ output_index, delta }` | append to text block |
| `response.refusal.delta` | `{ output_index, delta }` | append to text block (treated as text) |

`response.output_item.done` for a message reads `{ item: { type:"message", id, phase?, content:[{ type:"output_text", text } | { refusal }] } }`.

**Tool / function-call deltas**

| `type` | Shape | Effect |
|---|---|---|
| `response.function_call_arguments.delta` | `{ output_index, delta }` | append raw JSON fragment to the call's argument buffer (parsed incrementally) |
| `response.function_call_arguments.done` | `{ output_index, arguments }` | set final arguments string |

The opening `response.output_item.added` for a tool call carries `{ item: { type:"function_call", id, call_id, name, arguments? } }`. pi-ai forms the internal tool-call id as `` `${call_id}|${id}` ``. The `.done` item reads `{ item: { type:"function_call", id, call_id, name, arguments } }` with `arguments` a JSON string. **The `name` must match a tool the orb actually has** (e.g. `bash`), and `arguments` must be JSON the real tool accepts, because the tool executes for real inside the orb.

**Usage accounting** (from `response.completed.response.usage`):

```jsonc
{
  "input_tokens": 1200,
  "output_tokens": 340,
  "total_tokens": 1540,
  "input_tokens_details": { "cached_tokens": 200, "cache_write_tokens": 0 },
  "output_tokens_details": { "reasoning_tokens": 128 }
}
```

pi-ai computes `input = input_tokens - cached_tokens - cache_write_tokens`, `cacheRead = cached_tokens`, `output = output_tokens`, `reasoning = reasoning_tokens`, `totalTokens = total_tokens`, then applies model pricing. All fields are optional (default 0); the mock should let scenarios set them.

**Stop reasons.** `response.status` maps: `completed → stop`, `incomplete → length`, `failed`/`cancelled → error`, `in_progress`/`queued → stop`. If the message contains any tool call and the mapped reason is `stop`, pi-ai upgrades it to `toolUse`. If the client aborts (§8) the reason becomes `aborted`. Terminal reasons the mock scenario declares: `stop | length | toolUse | error | aborted`.

**Terminal-event requirement.** The stream **must** end with exactly one terminal response event (`response.completed` / `response.incomplete` / `response.done`, or `response.failed` / `error`). If the stream closes without one, pi-ai throws "OpenAI Responses stream ended before a terminal response event". This is the mechanism the mock uses for the "hanging / truncated stream" fault-injection case.

**Error responses (pre-stream).** A non-2xx status with a JSON body `{ "error": { "code"|"type", "message", "plan_type"?, "resets_at"? } }` is parsed for a friendly message. Retryable statuses (`429`, `500`, `502`, `503`, `504`) may be retried by pi-ai depending on `maxRetries` (default 0), honoring `retry-after` / `retry-after-ms` headers. A `429` whose body matches usage-limit patterns (e.g. `usage_limit_reached`, `insufficient_quota`) is treated as terminal (non-retryable). The mock must be able to emit these to test retry/rate-limit/usage-limit handling.

### 4.4 Model catalog (can be stubbed trivially / avoided)

Codex model definitions are **baked into pi-ai** (`OPENAI_CODEX_MODELS`, e.g. `gpt-5.4`, `gpt-5.3-codex-spark`) — Pi already has a usable model list and default without any network call. Separately, `withRemoteCatalog` may refresh a provider's catalog from `GET https://pi.dev/api/models/providers/openai-codex`, but only when `allowModelNetwork` is true. `allowModelNetwork` defaults to **`process.env.PI_OFFLINE === undefined`**, so **setting `PI_OFFLINE` (to any value) disables the catalog fetch entirely** and the baked-in models are used. `404`/`501` from the catalog are tolerated anyway.

**Recommendation:** set `PI_OFFLINE` in the E2E environment so no `pi.dev` request is made. The mock does **not** need a catalog endpoint. (If a test insists on network-on, the mock can serve `GET /api/models/providers/openai-codex` returning `[]` or `404`.)

---

## 5. Pointing the stack at the mock

There are two independent redirection problems, with very different difficulty.

### 5.1 Model endpoint — overridable with zero code changes (recommended path)

The Codex model `baseUrl` can be overridden through Pi's `models.json` **without patching pi-ai**. `provider-composer.js` (`applyModelsJson`) rewrites every `openai-codex` model's `baseUrl` to the config value:

```jsonc
// ~/.pi/agent/models.json  (path = getModelsPath(); relocatable via env, see below)
{
  "providers": {
    "openai-codex": {
      "baseUrl": "http://127.0.0.1:8899/backend-api"
    }
  }
}
```

- `resolveCodexUrl` then targets `http://127.0.0.1:8899/backend-api/codex/responses`.
- **HTTP is allowed for the model side** — the scheme follows `baseUrl` (`http:` → `ws:` for the WS attempt), so the model endpoint can be plain HTTP and needs no TLS.
- Where the file lives: orb-runtime creates `ModelRuntime` with the **default** `modelsPath` = `getAgentDir()/models.json`. `getAgentDir()` is `~/.pi/agent` by default but is relocatable via the env var **`PI_CODING_AGENT_DIR`** (`ENV_AGENT_DIR = ${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`, `APP_NAME = "pi"`). E2E can point that env var at a fixture dir containing the `models.json` above, inside the orb container.
- The **control-plane** creates `ModelRuntime` with `modelsPath: null` (no `models.json` read). That is fine: the control plane only does auth (`getAuth`/`login`), never streams, so it never needs the model `baseUrl` override. **Only orb-runtime needs the `models.json`.**
- Alternative (programmatic): `runtime.registerProvider("openai-codex", { baseUrl: "…" })` also overrides the base URL, but pi-orb does not currently call it, so `models.json` is the zero-code path.

### 5.2 Auth host — NOT overridable; needs DNS + TLS interception

`auth.openai.com` is a set of hardcoded constants in `openai-codex.js` with **no env override** (`PI_OAUTH_CALLBACK_HOST` only affects the unused browser-login localhost callback server, not the auth host). Both device-code login *and* token refresh hit `https://auth.openai.com`. To redirect them without patching pi-ai:

- **DNS / hosts override:** map `auth.openai.com` to the mock's address (Docker `--add-host auth.openai.com:<mock-ip>` for the orb and control-plane containers, or `/etc/hosts`).
- **TLS:** pi-ai calls `fetch("https://auth.openai.com/…")`; Node verifies TLS. The mock must serve **HTTPS with a certificate for `auth.openai.com` signed by a test CA that the Node process trusts** via `NODE_EXTRA_CA_CERTS=<test-ca.pem>`. There is no way to make the auth calls plain HTTP.

**Recommendation:** run a single mock process that serves **both** hosts over HTTPS behind a test CA, with `auth.openai.com` and `chatgpt.com` both mapped (via `--add-host`) to the mock. `NODE_EXTRA_CA_CERTS` and the two host mappings then cover every call. (The model side can alternatively stay plain-HTTP via the §5.1 `models.json` override, letting the mock serve only `auth.openai.com` over TLS — the simplest split.)

**Recommended upstream change (see Open Questions):** teach pi-ai to read `AUTH_BASE_URL` from a provider env var (e.g. `PI_OPENAI_CODEX_AUTH_BASE_URL`). That would eliminate the DNS+TLS requirement for the auth side and make the whole mock a plain-HTTP, env-pointed service.

---

## 6. JWT / accountId requirements (HARD)

The mock's issued **access tokens must be JWTs**, because pi-ai derives the account id from a JWT claim and *fails login/refresh/streaming* if it cannot:

- `decodeJwt` / `extractAccountId` split the token on `.`, require **exactly 3 parts**, `atob`-decode **part 1 (payload)**, and `JSON.parse` it. The header and signature segments are **never decoded or verified** — any non-empty placeholder works, and **no signature validity is checked**.
- The payload JSON must contain a claim at key **`"https://api.openai.com/auth"`** whose value is an object with a **non-empty string `chatgpt_account_id`**:

```json
{
  "https://api.openai.com/auth": { "chatgpt_account_id": "acct_mock_0001" },
  "exp": 9999999999,
  "sub": "user_mock"
}
```

- If the claim / account id is missing, pi-ai throws `"Failed to extract accountId from token"` and the credential is rejected. `chatgpt_account_id` is echoed back as the `chatgpt-account-id` request header, so the mock's model endpoint can assert it round-trips.
- **Encoding caveat:** pi-ai uses `atob` (forgiving-base64), which does not accept base64url-only characters. The mock should encode the payload as **standard base64** (padded) so `atob` reliably decodes it. The stored credential shape pi-ai persists (matching DESIGN.md §15.1) is:

```ts
{ type: "oauth", access: "<JWT>", refresh: "<opaque>", expires: <ms epoch>, accountId: "acct_mock_0001" }
```

Because tokens are unsigned-from-the-mock's-perspective, the mock can freely mint tokens with arbitrary future `expires` (skip refresh) or near-past `expires` (force refresh) to steer the refresh path.

---

## 7. Scripted-response specification (the heart of the mock)

The mock has no LLM. Every answer is declared by the test as a **scenario**: a declarative document (JSON / YAML / TS) loaded at mock startup and/or POSTed to a test-only control endpoint (§9) at runtime.

### 7.1 Model scenarios

A scenario is an ordered list of **rules**. Each rule has a **matcher** and an ordered list of **streaming steps** (one model turn). On each incoming `POST …/codex/responses`, the mock decompresses the body, finds the first unconsumed rule whose matcher predicate is satisfied, and replays its steps as an SSE stream.

**Matchers** (predicates over the request):

- `userMessage`: substring or `regex` match against the latest `input` user `input_text`.
- `turnIndex`: match the Nth request within a session.
- `session`: match on `prompt_cache_key` / `session-id` / `x-client-request-id`.
- `toolResultContains`: substring/regex over the most recent `function_call_output` in `input` (to branch on what the real tool returned).
- `default`: fallback when nothing else matches.

Matched rules are consumed in order so multi-turn tool loops are expressible as a sequence of rules.

**Streaming steps** (a rule's ordered payload, each producing one or more SSE events):

- `reasoning`: emits `response.output_item.added` (reasoning) + `response.reasoning_*` deltas + `response.output_item.done`. Text may be chunked into multiple deltas.
- `text`: emits `response.output_item.added` (message) + `response.output_text.delta`(s) + `response.output_item.done`.
- `toolCall`: emits `response.output_item.added` (function_call with `name` + `call_id`) + `response.function_call_arguments.delta`(s) + `.done`. `name` must be a real orb tool; `arguments` is a JSON object the tool accepts. After a tool call the mock stops the stream with stop reason `toolUse`; the orb runs the tool for real and the *next* request (carrying the `function_call_output`) is matched against the next rule.
- `usage`: numbers to place in the terminal `response.completed.response.usage`.
- `stop`: terminal reason / status (`completed`, `incomplete`, `failed`) → drives `stop | length | toolUse | error | aborted`.
- `delay`: optional inter-event delays (ms) — used to test pi-orb's streaming UI (`output_patch` cadence) and abort timing. Delays are the **only** permitted wall-clock dependence and are explicit per step.

**Fault injection** (per rule / per step):

- `httpError`: respond with a non-2xx status + JSON error body before streaming (e.g. `429` with `retry-after`, `usage_limit_reached`, `500`).
- `midStreamError`: emit some deltas then an `error` / `response.failed` event.
- `truncate` / `hang`: end (or never end) the stream **without** a terminal event to exercise the "stream ended before terminal event" path and idle timeouts.
- `rateLimitThenSucceed`: return `429`/`5xx` for the first N attempts, then stream normally (tests pi-ai retry when `maxRetries > 0`).

### 7.2 Auth scenarios

Scriptable auth behavior, so both control-plane gate tests and Playwright browser tests can drive login:

- `deviceApprove`: auto-approve the device code after N poll attempts (return `pending` N−1 times, then `authorization_code` + `code_verifier`).
- `deviceApproveViaControl`: keep returning `pending` until a test-only control call "approves" the code (§9) — lets a Playwright test literally click an "approve" affordance mid-flow.
- `deviceSlowDown`: return `slow_down` once/several times to test backoff.
- `deviceExpire`: keep `pending` past the 900 s deadline (using virtual time / short-circuit) to test the expiry → `failed` path.
- `refreshSuccess` / `refreshRotate`: refresh returns a new access token (and optionally a rotated refresh token) with a controllable `expires_in`.
- `refreshFail`: refresh returns 4xx/5xx to test the "cannot refresh → start new device flow / fail" path.
- Token minting: every issued `access_token` is a JWT per §6 with a configurable `chatgpt_account_id` and `expires_in` (future = no refresh; near-past = force refresh on next `getAuth`).

### 7.3 Worked example scenario

Goal: user says "run the tests" → assistant thinks, calls the real `bash` tool, receives the (real) tool result from the orb, then emits final text. Two model turns, two rules.

```yaml
auth:
  method: device_code
  device:
    approveAfterPolls: 2          # 1st poll pending, 2nd poll approved
    accountId: acct_mock_0001
    accessTokenExpiresIn: 3600    # future → no refresh during the test

model:
  rules:
    # ---- Turn 1: reasoning + a bash tool call ----
    - match: { userMessage: { regex: "run the tests" } }
      steps:
        - reasoning:
            text: "The user wants the test suite run. I'll invoke bash."
            deltas: 3                 # split into 3 reasoning_summary_text.delta events
        - toolCall:
            name: bash
            callId: call_run_tests_1
            itemId: fc_run_tests_1
            arguments: { command: "npm test" }
        - usage: { input_tokens: 1200, output_tokens: 90, total_tokens: 1290,
                   input_tokens_details: { cached_tokens: 0 } }
        - stop: { status: completed }  # → toolUse (message contains a tool call)

    # ---- Turn 2: after the real bash result comes back ----
    - match: { toolResultContains: { regex: "(passing|passed|Tests:)" } }
      steps:
        - text:
            content: "All tests passed. The suite is green."
            deltas: 4
        - usage: { input_tokens: 1450, output_tokens: 60, total_tokens: 1510,
                   input_tokens_details: { cached_tokens: 1200 } }
        - stop: { status: completed }  # → stop
```

Corresponding SSE for **Turn 1** (abbreviated; each `data:` block ends with a blank line):

```
data: {"type":"response.created","response":{"id":"resp_mock_1"}}
data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_mock_1"}}
data: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"The user wants "}
data: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"the test suite run. "}
data: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"I'll invoke bash."}
data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_mock_1","summary":[{"text":"The user wants the test suite run. I'll invoke bash."}],"encrypted_content":"enc_mock_1"}}
data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_run_tests_1","call_id":"call_run_tests_1","name":"bash"}}
data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"command\":"}
data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"\"npm test\"}"}
data: {"type":"response.function_call_arguments.done","output_index":1,"arguments":"{\"command\":\"npm test\"}"}
data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_run_tests_1","call_id":"call_run_tests_1","name":"bash","arguments":"{\"command\":\"npm test\"}"}}
data: {"type":"response.completed","response":{"id":"resp_mock_1","status":"completed","usage":{"input_tokens":1200,"output_tokens":90,"total_tokens":1290,"input_tokens_details":{"cached_tokens":0}}}}
```

The orb runs `npm test` for real; the harness sends Turn 2's request containing a `function_call_output` for `call_run_tests_1`; the second rule matches on the real output and streams the final text with stop reason `stop`.

---

## 8. Abort

pi-orb calls `session.abort()`, which aborts the request `AbortSignal`. On the SSE path pi-ai cancels the reader and marks `stopReason = "aborted"`. To test abort meaningfully the mock must be able to **stream slowly** (via `delay` steps) so the test can abort mid-stream and assert the orb emits `aborted`. The mock should detect the client disconnect (request aborted) and stop emitting; it must not require a terminal event once the client has gone away. Abort during a scripted `hang` step is the canonical abort test.

## 9. Test-only control API

A separate control surface (distinct path prefix, e.g. `/__mock__/…`, never part of the OpenAI surface) that E2E drives directly:

- `POST /__mock__/reset` — clear all in-memory state (rules, consumed cursors, recorded requests, device-code state).
- `POST /__mock__/scenario` — load / replace the active scenario (model rules + auth config) at runtime.
- `POST /__mock__/deviceauth/approve` — approve a pending device code by `user_code` (drives `deviceApproveViaControl`; lets a Playwright test "click approve").
- `GET /__mock__/requests` — list received requests (method, path, decompressed body, matched rule, timestamps) for assertions.
- `GET /__mock__/state` — current cursor positions, issued tokens, device-code status.

The control API is the mechanism for both determinism assertions (§10) and interactive browser tests.

## 10. Determinism requirements

- **No wall-clock dependence beyond explicit `delay` steps.** Event ordering and content are fixed by the scenario; the only timing is what a step declares.
- **Stable IDs.** `response.id`, `rs_*`/`msg_*`/`fc_*` item ids, `call_id`s, `device_auth_id`, `user_code`, and account id are either scenario-provided or generated by a **seeded, deterministic** sequence — never `Math.random`/UUID/`Date.now`.
- **Byte-identical reruns.** Given the same scenario + the same sequence of incoming requests, the mock emits byte-identical SSE and JSON (same chunk boundaries, same field order). Chunk boundaries follow the scenario's `deltas` splitting, not I/O timing.
- **Assertable.** `GET /__mock__/requests` lets a test assert exactly which requests the stack made (e.g. "orb-runtime sent Turn 2 with a `function_call_output` for `call_run_tests_1`", "token refresh was called once with the stored refresh token", "`chatgpt-account-id` header equalled `acct_mock_0001`").
- **Virtual time for expiry.** Device-code expiry (900 s) and refresh-expiry tests must not wait real seconds; the mock exposes controls (or honors an injected clock) so "expire" is triggered by a control call, not elapsed wall time. This aligns with pi-orb's deterministic-simulation constraint (CLAUDE.md, DETERMINED-REQ.md).

## 11. Non-goals (restated, concrete)

- No real inference, no model weights, no semantic understanding.
- No browser-login authorization-code flow, no `localhost:1455` callback (device_code only — §3).
- No WebSocket transport implementation (refuse WS → SSE fallback — §4.3).
- No `pi.dev` catalog dependency (set `PI_OFFLINE` — §4.4).
- No OpenAI fields pi-ai ignores; no rate-limit/billing accuracy beyond triggering the code paths.
- No cross-run persistence; all state resets per test.

---

## 12. Open questions

1. **Upstream auth-host override.** Should we land an upstream pi-ai change making `AUTH_BASE_URL` env-overridable (e.g. `PI_OPENAI_CODEX_AUTH_BASE_URL`)? That removes the DNS+TLS-interception requirement (§5.2) and lets the entire mock be plain-HTTP and env-pointed. Without it, tests must run with `NODE_EXTRA_CA_CERTS` + `--add-host auth.openai.com` (and, if the model side is also HTTPS, `chatgpt.com`).
2. **JWT payload encoding.** Confirm on the target Node version that `atob` reliably decodes the mock's standard-base64 payload (§6), and decide whether the mock should sign tokens at all (pi-ai never verifies the signature — an unsigned placeholder segment suffices, but a real signature costs nothing and future-proofs against upstream verification).
3. **zstd request bodies.** Confirm the E2E Node/Bun runtime actually compresses (it depends on `zlib.zstdCompressSync` availability); the mock must handle both compressed and uncompressed bodies regardless (§4.3). Is there a way to disable compression from pi-orb to simplify assertions, or must the mock always decompress?
4. **WebSocket assertion.** Is refusing the WS connect and relying on SSE fallback acceptable for all tests, or do some flows need `transport: "sse"` plumbed through pi-orb to avoid the (logged) WS failure/fallback noise? Should pi-orb expose a transport override for tests?
5. **Where does the mock live?** As a workspace package in this repo (shared TypeBox schemas, determined-friendly clock injection, reused by unit + E2E) versus a standalone fixture server. A workspace package aligns with pi-orb's simulation-testing posture but adds surface to maintain against pinned-Pi drift.
6. **models.json placement in the orb container.** Confirm the E2E harness can set `PI_CODING_AGENT_DIR` (or otherwise place `models.json`) inside the orb runtime container so the model `baseUrl` override reaches the streaming path (§5.1), and that this does not collide with the shared `auth.json` location (DESIGN.md §15.1).
7. **Refresh-trigger timing.** Confirm the exact expiry threshold at which `ModelRuntime.getAuth` decides to refresh (proactive skew vs. hard expiry), so `accessTokenExpiresIn` values in scenarios reliably force / avoid the refresh path. Not fully determinable from the vendored `openai-codex.js` alone (the decision lives in the credential-store/`getAuth` layer).
```
