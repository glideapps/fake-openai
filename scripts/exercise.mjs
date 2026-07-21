#!/usr/bin/env node
/**
 * End-to-end exercise of the fake-openai service against a running instance.
 *
 *   node scripts/exercise.mjs [baseUrl]
 *
 * Default baseUrl is http://localhost:3210 (the `fling dev` worker port).
 * Drives, with ZERO manual intervention:
 *   1. session creation
 *   2. the OAuth device-code flow (auto-approve) + token exchange + refresh
 *   3. a two-turn model tool loop over zstd-compressed requests (SSE)
 *   4. failure scenarios: pre-stream 429 usage-limit, mid-stream error, truncate
 *   5. the debugging request log
 *
 * Exits non-zero if any expectation fails, so it works as a smoke test.
 */
import zlib from "node:zlib";

const BASE = (process.argv[2] || process.env.FAKE_OPENAI_BASE || "http://localhost:3210").replace(/\/$/, "");
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

let failures = 0;
function check(label, cond) {
  const ok = !!cond;
  console.log(`   ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
}
function section(t) {
  console.log(`\n=== ${t} ===`);
}

async function jpost(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function jget(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, json: await res.json().catch(() => null) };
}
function form(path, fields) {
  return fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}
function zstd(obj) {
  return zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj)), {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
  });
}
async function readSSE(res) {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((b) => b.replace(/^data: /, "").trim())
    .filter((l) => l && l !== "[DONE]")
    .map((l) => JSON.parse(l));
}
const userReq = (text, extra = []) => ({
  model: "gpt-5.4",
  input: [{ role: "user", content: [{ type: "input_text", text }] }, ...extra],
});

const SCENARIO = {
  auth: {
    accountId: "acct_mock_0001",
    accessTokenExpiresIn: 3600,
    device: { approveAfterPolls: 2 }, // pending once, then auto-approve
    refresh: { rotate: true },
  },
  model: {
    rules: [
      {
        match: { userMessage: { regex: "run the tests" } },
        steps: [
          { type: "reasoning", text: "The user wants the tests run. I'll use bash.", deltas: 2 },
          { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
          { type: "usage", input_tokens: 1200, output_tokens: 90, total_tokens: 1290 },
          { type: "stop", status: "completed" },
        ],
      },
      {
        match: { toolResultContains: { regex: "(passed|passing|Tests:)" } },
        steps: [
          { type: "text", content: "All tests passed. The suite is green.", deltas: 4 },
          { type: "stop", status: "completed" },
        ],
      },
    ],
  },
};

async function main() {
  console.log(`fake-openai exercise against ${BASE}`);

  section("health");
  const health = await jget("/health");
  check("GET /health -> { ok: true }", health.status === 200 && health.json?.ok === true);

  section("create session");
  const create = await jpost("/api/__mock__/sessions", { name: "exercise", scenario: SCENARIO });
  check("session created (201)", create.status === 201);
  const key = create.json.sessionKey;
  console.log(`   sessionKey=${key}`);
  console.log(`   inferenceBaseUrl=${create.json.inferenceBaseUrl}`);
  console.log(`   oauthBaseUrl=${create.json.oauthBaseUrl}`);

  section("OAuth device flow (fully auto — no human)");
  const uc = (await jpost(`/oai/${key}/api/accounts/deviceauth/usercode`, { client_id: CLIENT_ID })).json;
  console.log(`   device_auth_id=${uc.device_auth_id} user_code=${uc.user_code} interval=${uc.interval}`);
  const poll1 = await jpost(`/oai/${key}/api/accounts/deviceauth/token`, {
    device_auth_id: uc.device_auth_id,
    user_code: uc.user_code,
  });
  check("first poll pending (403)", poll1.status === 403);
  const poll2 = await jpost(`/oai/${key}/api/accounts/deviceauth/token`, {
    device_auth_id: uc.device_auth_id,
    user_code: uc.user_code,
  });
  check("second poll approved (200, code + verifier)", poll2.status === 200 && poll2.json.authorization_code);

  section("token exchange");
  const tokRes = await form(`/oai/${key}/oauth/token`, {
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code: poll2.json.authorization_code,
    code_verifier: poll2.json.code_verifier,
    redirect_uri: "https://auth.openai.com/deviceauth/callback",
  });
  const tok = await tokRes.json();
  const jwtParts = String(tok.access_token).split(".");
  const accountId = JSON.parse(Buffer.from(jwtParts[1], "base64").toString())["https://api.openai.com/auth"]
    ?.chatgpt_account_id;
  check("access_token is a 3-part JWT", jwtParts.length === 3);
  check("account id extracted from JWT", accountId === "acct_mock_0001");
  check("expires_in present", tok.expires_in === 3600);
  console.log(`   access_token=${tok.access_token.slice(0, 24)}...  refresh_token=${tok.refresh_token}`);

  section("token refresh (rotation)");
  const refRes = await form(`/oai/${key}/oauth/token`, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: tok.refresh_token,
  });
  const ref = await refRes.json();
  check("refresh succeeded (200)", refRes.status === 200);
  check("refresh token rotated", ref.refresh_token && ref.refresh_token !== tok.refresh_token);

  section("model turn 1 — reasoning + bash tool call (zstd request)");
  const t1 = await fetch(`${BASE}/oai/${key}/backend-api/codex/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "zstd",
      accept: "text/event-stream",
      authorization: `Bearer ${tok.access_token}`,
      "chatgpt-account-id": accountId,
    },
    body: zstd(userReq("please run the tests")),
  });
  check("turn 1 status 200", t1.status === 200);
  check("turn 1 content-type is SSE", (t1.headers.get("content-type") || "").includes("text/event-stream"));
  const ev1 = await readSSE(t1);
  const toolCall = ev1.find((e) => e.type === "response.output_item.done" && e.item?.type === "function_call");
  check("turn 1 emitted a bash tool call", toolCall?.item?.name === "bash");
  check("turn 1 ended with response.completed", ev1.at(-1).type === "response.completed");
  console.log(`   tool call: ${toolCall.item.name}(${toolCall.item.arguments})`);

  section("model turn 2 — final text after (real) tool result");
  const t2 = await fetch(`${BASE}/oai/${key}/backend-api/codex/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${tok.access_token}`,
    },
    body: JSON.stringify(
      userReq("run the tests", [
        { type: "function_call_output", call_id: toolCall.item.call_id, output: "Tests: 12 passed, 0 failed" },
      ]),
    ),
  });
  const ev2 = await readSSE(t2);
  const finalText = ev2
    .filter((e) => e.type === "response.output_text.delta")
    .map((e) => e.delta)
    .join("");
  check("turn 2 produced final text", finalText.includes("All tests passed"));
  console.log(`   final: "${finalText}"`);

  section("failure scenarios");
  // Fresh session per fault so cursors are clean.
  const faultKey = (
    await jpost("/api/__mock__/sessions", {
      name: "faults",
      scenario: {
        model: {
          rules: [
            {
              match: { userMessage: "limit" },
              fault: { httpError: { status: 429, code: "usage_limit_reached", message: "over limit", retryAfterSeconds: 30 } },
            },
            {
              match: { userMessage: "boom" },
              fault: { midStreamError: { code: "server_error", message: "boom" } },
              steps: [{ type: "text", content: "partial..." }],
            },
            {
              match: { userMessage: "cut" },
              fault: { truncate: true },
              steps: [{ type: "text", content: "half a sentence" }],
            },
          ],
        },
      },
    })
  ).json.sessionKey;

  const limitRes = await fetch(`${BASE}/oai/${faultKey}/backend-api/codex/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(userReq("usage limit please")),
  });
  const limitBody = await limitRes.json();
  check("usage-limit 429 with retry-after", limitRes.status === 429 && limitRes.headers.get("retry-after") === "30");
  check("usage-limit body code", limitBody.error?.code === "usage_limit_reached");

  const boomEv = await readSSE(
    await fetch(`${BASE}/oai/${faultKey}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(userReq("boom now")),
    }),
  );
  check("mid-stream error event emitted", boomEv.some((e) => e.type === "error"));
  check("mid-stream error has no completed", !boomEv.some((e) => e.type === "response.completed"));

  const cutEv = await readSSE(
    await fetch(`${BASE}/oai/${faultKey}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(userReq("cut it off")),
    }),
  );
  check("truncated stream has no terminal event", !cutEv.some((e) => e.type === "response.completed"));

  section("debugging request log");
  const log = (await jget(`/api/__mock__/sessions/${key}/requests`)).json;
  console.log(`   ${log.length} requests logged for session ${key}:`);
  for (const r of log.slice().reverse()) {
    console.log(
      `     [${r.surface}] ${r.method} ${r.path} -> ${r.status}` +
        (r.matchedRuleIndex != null ? ` rule#${r.matchedRuleIndex}` : "") +
        (r.stopReason ? ` (${r.stopReason})` : "") +
        ` — ${r.events.length} events`,
    );
  }
  check("model turn 1 logged with stopReason toolUse", log.some((r) => r.surface === "model" && r.stopReason === "toolUse"));
  check("auth requests logged", log.some((r) => r.surface === "auth"));

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✓" : `${failures} CHECK(S) FAILED ✗`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("EXERCISE ERROR:", e);
  process.exit(1);
});
