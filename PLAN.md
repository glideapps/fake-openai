# Fake OpenAI — Implementation Plan

A Fling app that replaces both external surfaces pi-orb depends on — OpenAI's
OAuth device-code/token endpoints (`auth.openai.com`) and the Codex **Responses**
streaming backend (`chatgpt.com/backend-api`) — so pi-orb E2E can run offline,
deterministically, with no real OpenAI account. Derived from
[`FAKE-OPENAI-REQS.md`](./FAKE-OPENAI-REQS.md); follows the established
`../fake-google-auth` / `../fake-resend` Fling pattern.

This is a plan, not code. The REQS doc is authoritative wherever this plan is
silent. This revision incorporates a Codex design review (see §14 for the
review-driven changes).

---

## 1. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Both surfaces built** (auth + model). | Both the inference **and** OAuth base URLs are pointed at the fling by registering a **custom pi-ai provider** in pi-orb — no `pi-ai` patch, no hardcoded `auth.openai.com`, no TLS interception. See §2. |
| D2 | **Per-session isolation** via a `sessionKey` path segment in the base URLs the stack is pointed at. | Concurrent E2E runs share one deployed fling without racing; mirrors `fake-google-auth`. See §2. |
| D3 | **Read-only frontend inspector.** Tests drive everything through the control API. | The UI observes; it does not mutate mock state. |
| D4 | **D1-backed state + `/reset` control endpoint.** *This is a deliberate deviation from REQS §3/§11 ("all state in-memory, no cross-run persistence"), forced by Workers' ephemeral isolates.* Per-test isolation is provided by `sessionKey` + `reset` instead of process lifetime. | Documented as a deviation, not presented as equivalent. See §12. |
| D5 | **Control + read API under `/api/__mock__/…`.** | Fling reserves `/__*`; `/api/*` is also the Vite dev-proxy prefix the React app needs. |
| D6 | **zstd request bodies decoded with a bundled pure-JS decoder** (`fzstd`). **This is the single highest-risk item** — it is full-buffer CPU+memory work in an isolate and blocks stream start until the whole body is decoded and the rule matched. | Workers' `DecompressionStream` has no zstd (REQS §4.3). Spiked first (§11). Also pursue REQS Open-Q #3: get pi-orb to send uncompressed bodies where possible. |
| D7 | **SSE via a hand-built `ReadableStream`, NOT a `streamSSE` helper.** WebSocket upgrade refused → pi-ai falls back to SSE. | REQS §10 demands byte-identical `data: <json>\n\n` framing; helpers impose their own flush/framing. We own the exact bytes. |

---

## 2. How the stack points at the mock

pi-orb registers a **custom pi-ai provider** for these tests, so **both** base URLs
are plain provider config pointed at the fling — no DNS/TLS interception (which a
`*.flingit.run` fling could not provide anyway) and no `pi-ai` change:

- **Model / inference side:** provider inference `baseUrl =
  https://<host>/oai/<sessionKey>/backend-api`; `resolveCodexUrl` appends
  `/codex/responses`. (Equivalent to the `models.json` override, REQS §5.1.)
- **Auth side:** the custom provider's OAuth base URL =
  `https://<host>/oai/<sessionKey>`, so pi-ai calls
  `…/api/accounts/deviceauth/usercode`, `…/api/accounts/deviceauth/token`,
  `…/oauth/token` on the fling instead of `auth.openai.com`. This is what removes
  the old blocking dependency — no upstream env override needed.
- **Catalog:** none. E2E sets `PI_OFFLINE` (REQS §4.4).

The `sessionKey` path segment **is** the isolation mechanism (D2): each orb
carries its own key in config, so its requests land in its own mock session.
Consumers hit the deployed worker (or `fling tunnel`) directly, so the non-`/api`
OpenAI paths are fine — the `/api` prefix only matters for the React app's proxy.

---

## 3. Data model (D1) and the debugging log

All tables keyed by `session_id`, `ON DELETE CASCADE` from `mock_sessions`.

- **`mock_sessions`** — `id TEXT PK` (`sessionKey`), `name`, `scenario_json`,
  `id_seed INTEGER` (deterministic id counter), `created_at`, `expires_at`.
- **`rule_cursor`** — `session_id`, `next_rule_index`, plus a **separate
  `fault_attempts` counter per rule** so a retried `429`/`5xx`
  (`rateLimitThenSucceed`) does **not** consume the rule on a failed attempt.
- **`device_auths`** — `session_id`, `device_auth_id`, `user_code`, `status`,
  `poll_count`, `approve_after_polls`, `slow_down_remaining`,
  `authorization_code`, `code_verifier`, `created_at`, `expires_at`.
- **`tokens`** — `session_id`, `access_token` (JWT, §6), `refresh_token`,
  `account_id`, `expires_at_ms`, `rotated_from`, `created_at`.
- **`request_log`** — `id`, `session_id`, `surface`, `method`, `path`, `status`,
  `request_headers_json`, `request_body_json` (decompressed), `matched_rule_index`,
  `stop_reason`, `aborted`, `finalized` (bool), `created_at`.
- **`request_events`** — `id`, `request_id`, `seq`, `event_json`. **SSE events are
  stored one row per event, appended as they are emitted**, not collected into one
  blob at the end (see below).

**Log persistence is designed around abort/hang, not normal completion**
(Codex's biggest point):

1. On request receipt, **insert the `request_log` row immediately** (`finalized=0`)
   with headers + decompressed body + matched rule — before any streaming.
2. As each SSE event is emitted, **append a `request_events` row**. Use
   `ctx.waitUntil` so appends survive the response stream ending.
3. On terminal event / abort / disconnect, update the row's `stop_reason`,
   `aborted`, `finalized=1`.

This way the `hang`, `truncate`, `midStreamError`, and `aborted` cases — the ones
you most need to debug — still leave a complete partial log even if the isolate is
torn down. **No newest-N cap within a live session** (would break §9/§10
assertability); pruning happens only at session expiry (§10).

**Timestamps are operational metadata, never part of asserted determinism.**
`created_at`/`expires_at` exist for humans reading the inspector. The determinism
contract (§9) covers SSE bytes, minted IDs, and tokens — not wall-clock fields.
The frontend/state responses separate the two so tests never assert on a clock.

---

## 4. OpenAI-surface endpoints (faithful to REQS §4)

### 4.1 Auth — device-code flow + refresh
- `POST …/deviceauth/usercode` → `{ device_auth_id, user_code, interval }`
  (`interval` numeric per REQS §4.1a).
- `POST …/deviceauth/token` → full poll semantics table (REQS §4.1b): approved
  `200`; pending `403/404`; `deviceauth_authorization_pending` (object **and**
  string form); `slow_down` (object/string); other `error.code` → failed. Driven
  by `approveAfterPolls`, `deviceSlowDown`, `deviceExpire`, control-approve.
- `POST …/oauth/token`: `authorization_code` (mints tokens) and `refresh_token`
  (rotation + 4xx/5xx failure). Both return `{ access_token, refresh_token,
  expires_in }`.
- **Refresh-path steering is done at mint time, not via `/expire`.** pi-ai decides
  whether to refresh from the `expires` it stored locally = `Date.now() +
  expires_in*1000`. So a scenario forces refresh by minting with a **near-past
  `accessTokenExpiresIn`**, and avoids it with a far-future one. `/expire`
  (§7) only drives the **device-code 900 s deadline**; it cannot retroactively
  change pi-ai's stored token expiry. (REQS Open-Q #7: exact proactive-refresh
  skew is not knowable from the vendored source; validate empirically.)

### 4.2 Model — Codex Responses streaming
`POST …/backend-api/codex/responses`:
1. **Read the raw body exactly once in the route handler** (no body-consuming
   middleware — Workers request bodies are single-consume). If
   `content-encoding: zstd`, decode with `fzstd`; else JSON-parse. Assert
   `chatgpt-account-id` header equals the JWT's `chatgpt_account_id` (§6).
2. Match the first unconsumed rule (§5 matchers).
3. Stream the rule's steps (§4.3) with exact framing.
4. Pre-stream faults and mid-stream faults (§4.3, §5).
- **Scripted tool calls are validated against the request's advertised `tools`**:
  a `toolCall` step whose `name` is not in the incoming `tools[]` is a scenario
  error surfaced in the log (REQS §4.3.1/§7.1 make real tool execution part of the
  contract — a typo'd tool name silently hangs the orb otherwise).
- **WebSocket:** no `Upgrade` handling → handshake fails → SSE fallback.

### 4.3 Streaming engine — full event vocabulary (REQS §4.3.1)
A builder turns a rule's steps into an ordered `SSEEvent[]`; a raw `ReadableStream`
emits each as `data: <json>\n\n` with fixed field order. The mock must be able to
produce **every** event pi-ai's parser handles — explicitly:

- Lifecycle: `response.created`, `response.output_item.added` (opens a slot before
  any delta for that `output_index`), `response.output_item.done`,
  `response.completed`, **`response.incomplete`** (→ `length`), **`response.done`**
  (pi-ai normalizes to completed — emit it in at least one scenario),
  `response.failed`, `error`.
- Reasoning: `response.reasoning_summary_text.delta`, `response.reasoning_text.delta`,
  **`response.reasoning_summary_part.done`** (inserts `\n\n` between parts). The
  reasoning `.done` item **must be self-consistent and stable** — pi-ai
  JSON-stringifies it as `thinkingSignature` and **replays it verbatim next turn**,
  so `summary`/`content`/`encrypted_content` must be deterministic (correctness
  requirement, not a nicety).
- Text/refusal: `response.output_text.delta`, **`response.refusal.delta`**
  (treated as text), plus the message `.done` with `content:[{output_text}|{refusal}]`.
- Tool: `response.function_call_arguments.delta/.done`; opening `.added` carries
  `{id, call_id, name}`; internal id is `` `${call_id}|${id}` ``.
- Usage: all fields optional/scenario-set (REQS §4.3.1 usage block).
- Stop reasons: `completed→stop`, `incomplete→length`, `failed/cancelled→error`;
  a tool call upgrades `stop→toolUse`; client abort → `aborted`.

**Pre-stream error responses (REQS §4.3, expanded):** non-2xx + JSON
`{ error: { code|type, message, plan_type?, resets_at? } }`; honor **both**
`retry-after` and `retry-after-ms` headers; **`429` with usage-limit bodies
(`usage_limit_reached`, `insufficient_quota`) is terminal/non-retryable**, other
`429/5xx` are retryable. Scenarios can emit each to exercise pi-ai retry vs. terminal.

**Abort & termination (REQS §8), handled distinctly:**
- `truncate`: close the stream cleanly with **no** terminal event, then finalize
  the log. (pi-ai throws "stream ended before terminal event".)
- `hang`: never send a terminal event; hold the stream open until the client
  disconnects. Rely on **both** `c.req.raw.signal` **and** the `ReadableStream`
  `cancel()` callback to detect teardown (they don't always coincide on streamed
  responses), then finalize with `aborted=1`. Partial events are already persisted
  (§3), so the canonical abort test is not flaky.
- `delay` steps `await` a timer (the only permitted wall-clock dependence).

---

## 4.4 Failure scenario matrix (must emulate ALL — REQS §4.1b, §4.3, §7.1, §7.2, §8)

Faithfully driving *failures* is a primary goal, not an afterthought. Every row is
scenario-declarable and appears in the log with the fault applied.

**Auth — device flow**
| Fault | How | pi-ai effect |
|---|---|---|
| pending | poll returns `403`/`404`, or non-2xx `deviceauth_authorization_pending` (object **and** string form) | keeps polling |
| slow_down | non-2xx `slow_down` (object/string), optional server `interval` | interval += 5s |
| manual-approve | stay pending until `POST …/deviceauth/approve` | Playwright "click approve" |
| expire / timeout | stay pending past 900 s (via `/expire`) | "Device flow timed out" |
| failed | non-2xx with any other `error.code` | surfaces error text |
| usercode "not enabled" | (real 404 maps to that) — mock returns 200, so this path is *avoided* by design | login proceeds |

**Auth — token exchange & refresh**
| Fault | How | pi-ai effect |
|---|---|---|
| exchange missing field | omit `access_token`/`refresh_token`/`expires_in` | `readTokenResponse` throws |
| refresh success | new token, controllable `expires_in` | normal |
| refresh rotate | new **and different** `refresh_token` | tests rotation handling |
| refresh fail | `4xx`/`5xx` on refresh | "cannot refresh → new device flow / fail" |
| bad JWT / no accountId | mint a token whose payload lacks `chatgpt_account_id` | "Failed to extract accountId from token" |
| force-refresh | mint with near-past `accessTokenExpiresIn` | pi-ai refreshes on next `getAuth` |

**Model — pre-stream HTTP errors**
| Fault | How | pi-ai effect |
|---|---|---|
| retryable | `429`/`500`/`502`/`503`/`504` + `{error:{code|type,message,plan_type?,resets_at?}}` | retried iff `maxRetries>0` |
| retry-after | as above + `retry-after` **and** `retry-after-ms` headers | honors backoff |
| usage-limit (terminal) | `429` body `usage_limit_reached` / `insufficient_quota` | **non-retryable**, terminal |
| rateLimitThenSucceed | N failing attempts (via `fault_attempts` counter, not rule cursor) then stream | tests retry→success |

**Model — mid/terminal stream faults**
| Fault | How | pi-ai effect |
|---|---|---|
| midStreamError | some deltas, then `error` / `response.failed` | throws `CodexApiError` |
| truncate | close stream with **no** terminal event | "stream ended before terminal event" |
| hang | never send terminal; hold until disconnect | idle timeout / abort test |
| aborted | client disconnect during `delay`/`hang` (signal **+** stream `cancel()`) | `stopReason = aborted` |
| length | `response.incomplete` | stop reason `length` |
| error status | `response.failed`/`cancelled` | stop reason `error` |
| refusal | `response.refusal.delta` + refusal `.done` | text treated as refusal |

Each fault has a conformance test asserting both the wire bytes/status and pi-ai's
resulting behavior where a real pi-ai is in the loop.

---

## 5. Scenario schema (the heart, REQS §7)

Loaded per session via `POST /api/__mock__/sessions/:key/scenario`; shape mirrors
REQS §7.3 (`auth.device`, `auth.refresh`, `model.rules[]` with `match`, `steps`,
`fault`). Rules consumed in order (multi-turn tool loops = rule sequence). IDs
(`resp_*`, `rs_*`, `msg_*`, `fc_*`, `call_id`, `device_auth_id`, `user_code`) **and
refresh tokens** are scenario-provided or minted from the session's seeded counter
— **never random, never `Date.now`** (random refresh tokens would break §9/§10
assertability). `crypto.getRandomValues` is used **only** for the opaque
`sessionKey`, which is not part of any asserted body.

---

## 6. JWT minting (HARD, REQS §6)

Access tokens are real JWTs: `base64url(header).base64(payload).sig`, **payload in
standard padded base64** so pi-ai's `atob` decodes it. Payload carries
`"https://api.openai.com/auth": { "chatgpt_account_id": <accountId> }`, plus `exp`,
`sub`. `chatgpt_account_id` round-trips as the `chatgpt-account-id` request header.
`accessTokenExpiresIn` steers refresh (§4.1).

---

## 7. Control + read API (`/api/__mock__`, REQS §9)

- `POST /sessions` → create; returns `sessionKey` + the two base URLs to configure.
- `POST /sessions/:key/scenario` → load/replace.
- `POST /sessions/:key/reset` → clear cursors, fault-attempt counters, device
  state, tokens, log, **and reset `id_seed` to its initial value** so a reused
  `sessionKey` reproduces byte-identical IDs (Codex fix; REQS §10). Scenario kept
  or dropped per flag.
- `POST /sessions/:key/deviceauth/approve` → approve pending device code by
  `user_code`.
- `POST /sessions/:key/expire` → device-code-deadline virtual-time trigger (§4.1
  notes its limits for token refresh).
- `GET /sessions/:key/requests` → full log incl. per-event transcript (assertable;
  uncapped within a session).
- `GET /sessions/:key/state` → cursors, tokens, device status (clock-free view).
- `GET /sessions`, `DELETE /sessions/:key`, `GET /health`. CORS on `/api/*`.

---

## 8. Frontend — read-only inspector (the debugging log)

React + Tailwind, `fake-google-auth`'s tabbed layout. Sessions list → detail tabs:
- **Requests** (headline): every request (time, surface, method, path, matched
  rule, status, stop reason, aborted, finalized). Expand → headers, decompressed
  body, and the **SSE stream event-by-event** (from `request_events`), usage, fault.
- **Auth**: device-code state; issued tokens with decoded JWT payload + rotation
  lineage.
- **Scenario**: loaded rules/auth as pretty JSON.
- **State**: rule cursors, fault-attempt counters.

Manual + auto refresh. "Made with Fling" badge kept.

---

## 9. Determinism (REQS §10) — assertable vs. operational

- **Assertable (must be byte-identical across reruns):** every SSE byte (fixed
  field order, framing, chunk boundaries follow `deltas`), all minted IDs, minted
  refresh/access tokens (from `id_seed`), `/state` and `/requests` payloads *minus*
  timestamps.
- **Operational (never asserted):** `created_at`, `expires_at`, cron, request
  duration. Kept for the inspector, excluded from the determinism contract.
- Virtual time: device-code expiry via `POST …/expire`; refresh via mint-time
  `accessTokenExpiresIn` (§4.1). No real waiting beyond `delay` steps.

---

## 10. Cron cleanup

Hourly `cron` deletes expired sessions (cascade) — operational only, never on a
test's assertion path.

---

## 11. Build order (spikes first)

0. **Spike the riskiest unknown before committing** (Codex): a hand-built
   streaming `ReadableStream` + `fzstd` decode round-trips a captured real zstd
   body under `fling dev`. (Custom-provider wiring — pointing both base URLs at the
   fling — is pi-orb-side config and no longer a blocking dependency; confirm it
   once end-to-end when a session first exists.)
1. **Scaffold + D1 migrations** + control API session create/list/reset +
   `/health`. Verify with `curl`.
2. **JWT minting + auth endpoints** with auth scenarios. **Conformance tests for
   the REQS §4.1(b) poll table** (all pending/slow_down/failed forms) — these
   parser edge cases matter more than session CRUD.
3. **Request logging (insert-early, append-per-event)** + single-consume body read
   + zstd decode.
4. **Model streaming engine + matcher**, full §4.3.1 vocabulary; the worked
   example (reasoning → bash toolCall → toolUse → second-turn text) end to end,
   with a **byte-identical golden-SSE conformance test**.
5. **Fault injection + abort/hang/truncate** with partial-log assertions;
   `rateLimitThenSucceed` attempt-counter behavior.
6. **Frontend inspector.**
7. **Cron, docs, deploy (`fling it`).**

## 12. Known deviations from REQS (stated plainly)

- **State is D1-backed, not in-memory** (REQS §3/§11). Consequence: state survives
  crashes/redeploys until TTL or `reset`. Per-test isolation relies on distinct
  `sessionKey`s + `reset`, which every test must call. Documented, not hidden.

(The earlier auth-host / TLS-impersonation caveat is resolved: pi-orb points both
base URLs at the fling via a custom provider — see §2 — so no upstream change and
no TLS interception are required.)

## 13. Top risks

- **zstd decode in an isolate** (D6) — CPU/memory + no early stream start; verify
  against a captured `zstdCompressSync(level 3)` body; pursue sending uncompressed.
- **Byte-identical SSE** — guaranteed by owning framing (D7) + golden tests.
- **Abort/hang log durability** — mitigated by insert-early + `waitUntil` appends.

## 14. Review-driven changes (from Codex)

Reset resets `id_seed`; refresh tokens minted deterministically; timestamps split
out of the determinism contract; log persistence redesigned around abort/hang
(insert-early + per-event append, no in-test cap); body read once in the route;
`streamSSE` helper replaced with hand-built framing; full SSE vocabulary
(`refusal.delta`, `reasoning_summary_part.done`, `response.done`, `incomplete`)
and the expanded pre-stream error model (`retry-after-ms`, non-retryable
usage-limit 429) enumerated; refresh-expiry steering clarified (mint-time, not
`/expire`); `fault_attempts` counter separated from rule consumption; scripted
tool-call names validated against advertised tools; reasoning `.done` stability
called out as a correctness requirement; auth-host + streaming spiked first.
D1/cron deviation from REQS stated plainly (§12).
