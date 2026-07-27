# fake-openai

A [Fling](https://flingit.io) app that impersonates the two OpenAI surfaces a
Pi-based coding agent depends on, so end-to-end tests run **offline**,
**deterministically**, and with **no real OpenAI account**:

1. **OAuth device-code login + token refresh** (`auth.openai.com` in production).
2. **Codex Responses streaming** (`chatgpt.com/backend-api` in production).

The mock has **no LLM**. Every answer is declared up front by the test as a
**scenario**; the mock matches each incoming request to a rule and replays
scripted Server-Sent Events. Tool execution still happens for real inside the
agent's container — the mock only decides *which tool the model asks for* and
*what text it emits*.

Live instance: **https://fake-openai.flingit.run**

---

## Contents

- [How it works](#how-it-works)
- [Pointing the agent at the mock](#pointing-the-agent-at-the-mock)
- [Quick start](#quick-start)
- [Control API](#control-api)
- [OpenAI-surface endpoints](#openai-surface-endpoints)
- [Scenario reference](#scenario-reference)
- [Failure matrix](#failure-matrix)
- [Determinism, IDs, and JWTs](#determinism-ids-and-jwts)
- [The inspector UI](#the-inspector-ui)
- [Development](#development)
- [Deployment & security](#deployment--security)

---

## How it works

1. A test creates a **session** and loads a **scenario** into it (control API).
2. The agent is pointed at the session's per-session base URLs.
3. The agent runs the OAuth device flow and streams model turns; the mock serves
   both, driven entirely by the scenario.
4. Everything the mock receives and emits is recorded in a per-session **request
   log**, visible in the inspector UI and queryable via the control API.

Each session is isolated by a `sessionKey` embedded in the URL path
(`/oai/<sessionKey>/...`), so many test runs can share one deployed instance
without colliding. State is reset per test via the control API.

---

## Pointing the agent at the mock

The agent registers a **custom pi-ai provider** whose inference and OAuth base
URLs point at a session on the mock:

| Provider setting | Value |
|---|---|
| inference `baseUrl` | `https://<host>/oai/<sessionKey>/backend-api` |
| OAuth base URL | `https://<host>/oai/<sessionKey>` |

Both URLs are returned when you create a session. Also set the `PI_OFFLINE`
environment variable so the agent skips the remote model-catalog fetch. No
DNS/TLS interception and no library patching are required — it's all plain HTTPS
configuration.

---

## Quick start

```bash
BASE=https://fake-openai.flingit.run

# 1. Create a session with a scenario.
curl -sX POST $BASE/api/__mock__/sessions \
  -H 'content-type: application/json' \
  -d '{
    "name": "my-e2e",
    "scenario": {
      "auth": { "accountId": "acct_mock_0001", "accessTokenExpiresIn": 3600,
                "device": { "approveAfterPolls": 1 } },
      "model": { "rules": [
        { "match": { "userMessage": { "regex": "hello" } },
          "steps": [ { "type": "text", "content": "Hi there!" },
                     { "type": "stop", "status": "completed" } ] }
      ] }
    }
  }'
# -> { "sessionKey": "sess_…", "inferenceBaseUrl": "…", "oauthBaseUrl": "…" }
```

Point the agent's custom provider at `inferenceBaseUrl` / `oauthBaseUrl`, run the
test, then inspect or reset:

```bash
curl -s  $BASE/api/__mock__/sessions/<key>/requests   # full request log
curl -sX POST $BASE/api/__mock__/sessions/<key>/reset  # clear state between tests
```

There is a runnable end-to-end example in [`scripts/exercise.mjs`](scripts/exercise.mjs)
(`npm run exercise -- <baseUrl>`), which drives the whole service — OAuth
auto-approve, token exchange, refresh, a two-turn tool loop over zstd-compressed
requests, and every failure mode — with zero manual intervention.

---

## Control API

Test-only, unauthenticated, under `/api/__mock__`. All JSON.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/sessions` | Create a session. Body `{ name?, scenario? }`. Returns `sessionKey` + `inferenceBaseUrl` + `oauthBaseUrl`. |
| `GET` | `/sessions` | List sessions (newest first). |
| `GET` | `/sessions/:key` | Session detail incl. the loaded scenario and cursor. |
| `DELETE` | `/sessions/:key` | Delete a session and all its state. |
| `POST` | `/sessions/:key/scenario` | Load / replace the scenario. Body is the scenario object. |
| `POST` | `/sessions/:key/reset` | Clear cursors, device codes, tokens, and log; reset the id seed. Body `{ keepScenario?: boolean }` (default `true`). |
| `POST` | `/sessions/:key/deviceauth/approve` | Approve a pending device code. Body `{ user_code }`. |
| `POST` | `/sessions/:key/expire` | Expire pending device codes (virtual time). |
| `GET` | `/sessions/:key/requests` | Full request log incl. the per-event SSE transcript. |
| `GET` | `/sessions/:key/state` | Cursors, issued tokens, device-code status, fault counters. |
| `GET` | `/health` | Health check → `{ ok: true }`. |

A request-log entry looks like:

```jsonc
{
  "id": 6,
  "surface": "model",                 // "auth" | "model" | "control"
  "method": "POST",
  "path": "/oai/sess_…/backend-api/codex/responses",
  "status": 200,
  "headers": { "...": "..." },        // includes chatgpt-account-id for round-trip asserts
  "body": { "model": "gpt-5.4", "input": [ ... ] },  // decompressed
  "matchedRuleIndex": 0,
  "stopReason": "toolUse",            // stop | length | toolUse | error | aborted | truncated
  "aborted": false,
  "finalized": true,
  "events": [ /* every SSE event emitted, verbatim */ ]
}
```

---

## OpenAI-surface endpoints

Served per session under `/oai/:key`. These mimic OpenAI and are what the agent
calls.

### OAuth — device-code flow

```
POST /oai/:key/api/accounts/deviceauth/usercode
  body: { "client_id": "app_EMoamEEZ73f0CkXaXp7hrann" }
  200:  { "device_auth_id": "...", "user_code": "...", "interval": 1 }

POST /oai/:key/api/accounts/deviceauth/token          # poll
  body: { "device_auth_id": "...", "user_code": "..." }
  200:  { "authorization_code": "...", "code_verifier": "..." }   # approved
  403:  { "error": { "code": "deviceauth_authorization_pending" } } # keep polling
  429:  { "error": { "code": "slow_down" } }                        # back off
```

The flow is **fully scriptable with no human step** — by default the code is
auto-approved on the first poll (`approveAfterPolls: 1`).

### OAuth — token exchange & refresh

```
POST /oai/:key/oauth/token        # application/x-www-form-urlencoded
  grant_type=authorization_code  &code=...&code_verifier=...
  grant_type=refresh_token       &refresh_token=...
  200: { "access_token": "<JWT>", "refresh_token": "...", "expires_in": 3600 }
```

The `access_token` is a real (unsigned) JWT carrying the `chatgpt_account_id`
claim — see [Determinism, IDs, and JWTs](#determinism-ids-and-jwts).

### Model — Codex Responses streaming

```
POST /oai/:key/backend-api/codex/responses
  headers: authorization: Bearer <JWT>, accept: text/event-stream,
           content-encoding: zstd  (optional — body may be zstd-compressed)
  200: text/event-stream           # scripted SSE per the matched rule
```

The handler decompresses the body (zstd or plain), matches the first unconsumed
rule, and streams that rule's steps. WebSocket upgrades are refused, so the agent
falls back to SSE automatically.

---

## Scenario reference

A scenario is loaded per session and drives both surfaces.

```jsonc
{
  "auth":  { /* … */ },
  "model": { "rules": [ /* … */ ] }
}
```

### `auth`

| Field | Type | Meaning |
|---|---|---|
| `accountId` | string | `chatgpt_account_id` baked into minted JWTs (default `acct_mock_0001`). |
| `accessTokenExpiresIn` | number | `expires_in` for issued tokens. Far-future avoids refresh; near-past forces it. |
| `omitAccountClaim` | boolean | Mint tokens **without** the account claim, to drive the "failed to extract accountId" case. |
| `device.approveAfterPolls` | number | Return `pending` for N−1 polls, then approve (default `1` = approve on first poll). |
| `device.slowDownPolls` | number | Return `slow_down` for the first N polls. |
| `device.manualApprove` | boolean | Never auto-approve; wait for the control `deviceauth/approve` call. |
| `device.expire` | boolean | Never approve (drives the login-timeout path). |
| `refresh.rotate` | boolean | Return a new, different `refresh_token` on refresh. |
| `refresh.failStatus` | number | Return this HTTP status (4xx/5xx) on refresh, to test refresh failure. |

### `model.rules[]`

Each rule has a `match`, an ordered list of `steps` (one model turn), an optional
`responseId`, and an optional `fault`. Rules are consumed **in order**: each
incoming request is matched to the first rule at or after the cursor whose matcher
is satisfied; the cursor then advances past it. Multi-turn tool loops are just a
sequence of rules.

**Matchers** (`match`):

| Field | Example | Matches when |
|---|---|---|
| `userMessage` | `"hi"` or `{ "regex": "run the tests?" }` | the latest user message text contains / matches. |
| `toolResultContains` | `{ "regex": "(passed|Tests:)" }` | the most recent `function_call_output` contains / matches. |
| `turnIndex` | `2` | it is the Nth model request in the session (0-based). |
| `session` | `"abc"` | `prompt_cache_key` / `session-id` / `x-client-request-id` equals this. |
| `default` | `true` | always (fallback). |

Multiple fields are AND-ed. An empty `match` object matches nothing (use
`{ "default": true }` for a catch-all).

**Steps** (`steps`), each producing SSE events:

| `type` | Fields | Emits |
|---|---|---|
| `reasoning` | `text`, `deltas?`, `chunks?`, `itemId?`, `encryptedContent?`, `variant?` | reasoning item + `reasoning_summary_text.delta`(s) (or `reasoning_text.delta` when `variant:"text"`). |
| `text` | `content`, `deltas?`, `chunks?`, `itemId?`, `refusal?` | message item + `output_text.delta`(s) (or `refusal.delta` when `refusal:true`). |
| `toolCall` | `name`, `arguments`, `callId?`, `itemId?`, `deltas?`, `argumentChunks?` | function-call item + `function_call_arguments.delta`(s) + `.done`. `name` must be a real tool the agent has; `arguments` must be JSON it accepts. |
| `usage` | `input_tokens?`, `output_tokens?`, `total_tokens?`, `input_tokens_details?`, `output_tokens_details?` | fills `response.completed.usage`. |
| `stop` | `status?` (`completed` \| `incomplete` \| `failed` \| `cancelled`) | the terminal event; maps to stop reason `stop` / `length` / `error` (a tool call upgrades `stop` → `toolUse`). |
| `delay` | `ms` | pauses before the next event (the only wall-clock dependence). |

Text splitting: `chunks` gives explicit delta boundaries (verbatim); otherwise
`deltas: N` splits evenly; otherwise the whole string is one delta.

**Faults** (`fault`, per rule):

| Field | Shape | Effect |
|---|---|---|
| `httpError` | `{ status, code?, type?, message?, plan_type?, resets_at?, retryAfterSeconds?, retryAfterMs? }` | Non-2xx + JSON error body **before** streaming. A `429` with a usage-limit `code` is terminal (non-retryable). |
| `rateLimitThenSucceed` | `{ attempts, status? }` | Fail the first `attempts` requests (default `429`) **without** consuming the rule, then stream normally. |
| `midStreamError` | `{ code?, message?, via? }` | Emit the rule's deltas, then an `error` event (or `response.failed` when `via:"response.failed"`) instead of a terminal event. |
| `truncate` | `true` | End the stream with **no** terminal event. |
| `hang` | `true` | Emit the deltas, then hold the stream open until the client disconnects (abort testing). |

### Worked example (two-turn tool loop)

```jsonc
{
  "auth": { "accountId": "acct_mock_0001", "accessTokenExpiresIn": 3600,
            "device": { "approveAfterPolls": 2 } },
  "model": { "rules": [
    { "match": { "userMessage": { "regex": "run the tests" } },
      "steps": [
        { "type": "reasoning", "text": "The user wants the tests run. I'll use bash.", "deltas": 3 },
        { "type": "toolCall", "name": "bash", "arguments": { "command": "npm test" } },
        { "type": "usage", "input_tokens": 1200, "output_tokens": 90, "total_tokens": 1290 },
        { "type": "stop", "status": "completed" }        // → toolUse (has a tool call)
      ] },
    { "match": { "toolResultContains": { "regex": "(passed|Tests:)" } },
      "steps": [
        { "type": "text", "content": "All tests passed. The suite is green.", "deltas": 4 },
        { "type": "stop", "status": "completed" }         // → stop
      ] }
  ] }
}
```

---

## Failure matrix

Every failure the mock can emulate, all scenario-declarable and visible in the log:

**Auth — device flow:** pending, `slow_down` backoff, manual approve (control call),
login timeout (`expire`), and generic `failed`.

**Auth — token / refresh:** missing-field exchange, refresh success, refresh
rotation, refresh failure (4xx/5xx), bad JWT with no account claim, and
force-refresh via a near-past `accessTokenExpiresIn`.

**Model — pre-stream HTTP:** retryable `429`/`5xx` with `retry-after` /
`retry-after-ms`, non-retryable usage-limit `429`, and `rateLimitThenSucceed`.

**Model — mid/terminal stream:** `midStreamError`, `truncate` (no terminal
event), `hang` + client abort, `length` (`incomplete`), `error` (`failed`), and
refusals.

---

## Determinism, IDs, and JWTs

- **Byte-identical reruns.** Given the same scenario and request sequence, the
  mock emits byte-identical SSE and JSON. Field order and delta boundaries are
  fixed by the scenario, not by I/O timing.
- **Seeded IDs.** All ids the mock mints (`resp_*`, `rs_*`, `msg_*`, `fc_*`,
  `call_*`, device auth id, user code, refresh tokens) come from a per-session
  counter — never `Math.random`/`Date.now`. `reset` returns the counter to 0, so
  a reused session reproduces identical ids.
- **Virtual time.** The only wall-clock dependence is explicit `delay` steps.
  Device-code expiry is triggered by the `expire` control call; refresh timing is
  steered by minting tokens with a near-past `expires_in`.
- **JWTs.** Access tokens are real 3-part JWTs whose payload is standard-base64
  and carries `{"https://api.openai.com/auth":{"chatgpt_account_id":"…"}}`. The
  agent reads the account id from this claim and echoes it back as the
  `chatgpt-account-id` request header (captured in the log for round-trip asserts).
  The signature is a non-verified placeholder.

---

## The inspector UI

The site is a **read-only** debugging inspector. A **Sessions** list drills into a
session with four tabs:

- **Requests** — every request with its decompressed body, matched rule, status,
  stop reason, and the **SSE stream event-by-event**.
- **Auth** — device-code state and issued tokens (with decoded JWT payloads).
- **Rules** — the loaded scenario rendered readably, with the cursor (next /
  consumed rule) highlighted.
- **State** — rule cursor, id seed, and fault-attempt counters.

Tests drive the mock through the control API; the UI only observes.

This documentation is served by the worker at **`/docs`** as a standalone
server-rendered HTML page. Its content is generated from `README.md` at build
time (see the readme plugin in `vite.config.ts`), so editing the README and
redeploying updates the page — never edit `src/worker/readme-generated.ts` by
hand.

---

## Development

```bash
npm start          # fling dev — worker on :3210, frontend on :5174
npm test           # vitest: unit + route-integration tests
npm run exercise   # drive the whole service against a running instance
                   #   npm run exercise -- https://fake-openai.flingit.run
```

Project layout:

```
src/worker/     backend: OAuth + model routes, /docs page, streaming engine, store, D1 schema
src/react-app/  read-only inspector UI
scripts/        exercise.mjs — end-to-end smoke/demo script
```

---

## Deployment & security

Deployed with `npx fling it`. **The control API is unauthenticated by design** —
it is a test tool. Anyone who knows the URL can create sessions and read logs, so
do not put anything sensitive in scenarios or requests. Sessions auto-expire after
24 hours (hourly cron cleanup). If you need it locked down, add backend-enforced
auth (e.g. a shared password or an allowed-domain login) in front of `/api/*`.
