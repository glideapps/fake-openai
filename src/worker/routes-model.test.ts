import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import zlib from "node:zlib";
import { app, db } from "flingit";
import { runMigrations } from "flingit/runtime/migrate";
import "./index.js";

async function newSession(scenario: unknown): Promise<string> {
  const res = await app.request("/api/__mock__/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario }),
  });
  return (await res.json()).sessionKey;
}

function post(
  key: string,
  body: unknown,
  opts: { zstd?: boolean; headers?: Record<string, string>; signal?: AbortSignal } = {},
) {
  const json = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: "Bearer test",
    ...(opts.headers ?? {}),
  };
  let payload: BodyInit;
  if (opts.zstd) {
    headers["content-encoding"] = "zstd";
    payload = zlib.zstdCompressSync(Buffer.from(json), {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
    });
  } else {
    payload = json;
  }
  return app.request(`/oai/${key}/backend-api/codex/responses`, {
    method: "POST",
    headers,
    body: payload,
    signal: opts.signal,
  });
}

const userReq = (text: string) => ({
  model: "gpt-5.4",
  input: [{ role: "user", content: [{ type: "input_text", text }] }],
});

// The REQS §7.3 two-rule scenario with explicit ids so Turn 1 is byte-identical.
const workedScenario = {
  model: {
    rules: [
      {
        match: { userMessage: { regex: "run the tests" } },
        responseId: "resp_mock_1",
        steps: [
          {
            type: "reasoning",
            itemId: "rs_mock_1",
            encryptedContent: "enc_mock_1",
            text: "The user wants the test suite run. I'll invoke bash.",
            chunks: ["The user wants ", "the test suite run. ", "I'll invoke bash."],
          },
          {
            type: "toolCall",
            name: "bash",
            callId: "call_run_tests_1",
            itemId: "fc_run_tests_1",
            arguments: { command: "npm test" },
            argumentChunks: ['{"command":', '"npm test"}'],
          },
          {
            type: "usage",
            input_tokens: 1200,
            output_tokens: 90,
            total_tokens: 1290,
            input_tokens_details: { cached_tokens: 0 },
          },
          { type: "stop", status: "completed" },
        ],
      },
      {
        match: { toolResultContains: { regex: "(passing|passed|Tests:)" } },
        responseId: "resp_mock_2",
        steps: [
          { type: "text", content: "All tests passed. The suite is green.", itemId: "msg_mock_2", deltas: 1 },
          { type: "stop", status: "completed" },
        ],
      },
    ],
  },
};

const TURN1_GOLDEN =
  'data: {"type":"response.created","response":{"id":"resp_mock_1"}}\n\n' +
  'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_mock_1"}}\n\n' +
  'data: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"The user wants "}\n\n' +
  'data: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"the test suite run. "}\n\n' +
  'data: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"I\'ll invoke bash."}\n\n' +
  'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_mock_1","summary":[{"text":"The user wants the test suite run. I\'ll invoke bash."}],"encrypted_content":"enc_mock_1"}}\n\n' +
  'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_run_tests_1","call_id":"call_run_tests_1","name":"bash"}}\n\n' +
  'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"command\\":"}\n\n' +
  'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"\\"npm test\\"}"}\n\n' +
  'data: {"type":"response.function_call_arguments.done","output_index":1,"arguments":"{\\"command\\":\\"npm test\\"}"}\n\n' +
  'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_run_tests_1","call_id":"call_run_tests_1","name":"bash","arguments":"{\\"command\\":\\"npm test\\"}"}}\n\n' +
  'data: {"type":"response.completed","response":{"id":"resp_mock_1","status":"completed","usage":{"input_tokens":1200,"output_tokens":90,"total_tokens":1290,"input_tokens_details":{"cached_tokens":0}}}}\n\n';

beforeAll(async () => {
  await runMigrations();
});
beforeEach(async () => {
  for (const t of ["request_events", "request_log", "tokens", "device_auths", "mock_sessions"]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

describe("model streaming — happy path", () => {
  it("streams byte-identical SSE for the REQS worked example Turn 1", async () => {
    const key = await newSession(workedScenario);
    const res = await post(key, userReq("please run the tests"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toBe(TURN1_GOLDEN);
  });

  it("advances the cursor and matches Turn 2 on the tool result", async () => {
    const key = await newSession(workedScenario);
    await (await post(key, userReq("run the tests"))).text();

    const turn2 = {
      model: "gpt-5.4",
      input: [
        { role: "user", content: [{ type: "input_text", text: "run the tests" }] },
        { type: "function_call_output", call_id: "call_run_tests_1", output: "Tests: 12 passed" },
      ],
    };
    const body = await (await post(key, turn2)).text();
    expect(body).toContain('"delta":"All tests passed. The suite is green."');
    expect(body).toContain('"type":"response.completed"');
  });
});

describe("model streaming — zstd request body", () => {
  it("decompresses a zstd body and matches predicates", async () => {
    const key = await newSession(workedScenario);
    const res = await post(key, userReq("please run the tests"), { zstd: true });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(TURN1_GOLDEN);
  });
});

describe("model streaming — request logging", () => {
  it("logs the request with decompressed body, matched rule, events and stop reason", async () => {
    const key = await newSession(workedScenario);
    await (await post(key, userReq("run the tests"), { headers: { "chatgpt-account-id": "acct_mock_0001" } })).text();

    const log = await (await app.request(`/api/__mock__/sessions/${key}/requests`)).json();
    expect(log).toHaveLength(1);
    const entry = log[0];
    expect(entry.surface).toBe("model");
    expect(entry.matchedRuleIndex).toBe(0);
    expect(entry.stopReason).toBe("toolUse");
    expect(entry.finalized).toBe(true);
    // The decompressed body is captured for debugging.
    expect(entry.body.input[0].content[0].text).toContain("run the tests");
    // Headers (incl. chatgpt-account-id round-trip) are captured (REQS §10).
    expect(entry.headers["chatgpt-account-id"]).toBe("acct_mock_0001");
    // Full SSE transcript is stored event-by-event.
    expect(entry.events[0].type).toBe("response.created");
    expect(entry.events.at(-1).type).toBe("response.completed");
  });
});

describe("model streaming — default rule + no match", () => {
  it("falls back to a default rule", async () => {
    const key = await newSession({
      model: { rules: [{ match: { default: true }, steps: [{ type: "text", content: "hi" }] }] },
    });
    const body = await (await post(key, userReq("anything at all"))).text();
    expect(body).toContain('"delta":"hi"');
  });

  it("400s when no rule matches", async () => {
    const key = await newSession({
      model: { rules: [{ match: { userMessage: "specific" }, steps: [] }] },
    });
    const res = await post(key, userReq("nothing relevant"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no_matching_rule");
  });
});

describe("model streaming — fault: pre-stream httpError", () => {
  it("returns a 429 usage-limit terminal error before streaming", async () => {
    const key = await newSession({
      model: {
        rules: [
          {
            match: { default: true },
            fault: { httpError: { status: 429, code: "usage_limit_reached", message: "over limit", retryAfterSeconds: 30 } },
          },
        ],
      },
    });
    const res = await post(key, userReq("go"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    const data = await res.json();
    expect(data.error.code).toBe("usage_limit_reached");
  });
});

describe("model streaming — fault: rateLimitThenSucceed", () => {
  it("fails the first N attempts (cursor not consumed), then streams", async () => {
    const key = await newSession({
      model: {
        rules: [
          {
            match: { default: true },
            fault: { rateLimitThenSucceed: { attempts: 1, status: 429 } },
            steps: [{ type: "text", content: "ok now" }],
          },
        ],
      },
    });
    const first = await post(key, userReq("go"));
    expect(first.status).toBe(429);
    const second = await post(key, userReq("go"));
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('"delta":"ok now"');
  });
});

describe("model streaming — fault: midStreamError & truncate", () => {
  it("midStreamError emits deltas then an error event (no completed)", async () => {
    const key = await newSession({
      model: {
        rules: [
          {
            match: { default: true },
            fault: { midStreamError: { code: "server_error", message: "boom" } },
            steps: [{ type: "text", content: "partial" }],
          },
        ],
      },
    });
    const body = await (await post(key, userReq("go"))).text();
    expect(body).toContain('"delta":"partial"');
    expect(body).toContain('"type":"error"');
    expect(body).not.toContain('"type":"response.completed"');
  });

  it("hang holds the stream open and finalizes as aborted on client disconnect", async () => {
    const key = await newSession({
      model: {
        rules: [
          {
            match: { default: true },
            fault: { hang: true },
            steps: [{ type: "reasoning", text: "thinking hard", chunks: ["thinking hard"] }],
          },
        ],
      },
    });
    const ac = new AbortController();
    const res = await post(key, userReq("go"), { signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read(); // consume the first chunk, stream then holds open
    ac.abort();
    await reader.read().catch(() => {}); // let the abort propagate
    // give the source's finalize() a tick to persist
    await new Promise((r) => setTimeout(r, 50));

    const log = await (await app.request(`/api/__mock__/sessions/${key}/requests`)).json();
    expect(log[0].aborted).toBe(true);
    expect(log[0].stopReason).toBe("aborted");
    // No terminal event was ever emitted.
    expect(log[0].events.some((e: any) => e.type === "response.completed")).toBe(false);
  });

  it("truncate ends the stream with no terminal event", async () => {
    const key = await newSession({
      model: {
        rules: [
          { match: { default: true }, fault: { truncate: true }, steps: [{ type: "text", content: "partial" }] },
        ],
      },
    });
    const body = await (await post(key, userReq("go"))).text();
    expect(body).toContain('"delta":"partial"');
    expect(body).not.toContain('"type":"response.completed"');
    const log = await (await app.request(`/api/__mock__/sessions/${key}/requests`)).json();
    expect(log[0].stopReason).toBe("truncated");
  });
});
