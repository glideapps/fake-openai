import { describe, it, expect } from "vitest";
import { buildTurn } from "./engine.js";
import { renderEvents } from "./sse.js";
import { IdMinter } from "./ids.js";
import type { Rule } from "./types.js";

// The canonical worked example from REQS §7.3, Turn 1. This is a byte-identical
// golden of the exact SSE the mock must produce (minus the trailing [DONE],
// which pi-ai ignores). All ids are scenario-provided so the bytes are pinned.
const REQS_TURN1_GOLDEN =
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

const turn1Rule: Rule = {
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
};

describe("buildTurn — REQS §7.3 golden", () => {
  it("produces byte-identical SSE for the worked example Turn 1", () => {
    const result = buildTurn(turn1Rule, new IdMinter(0));
    expect(renderEvents(result.events)).toBe(REQS_TURN1_GOLDEN);
  });

  it("marks the turn as containing a tool call and stop reason toolUse", () => {
    const result = buildTurn(turn1Rule, new IdMinter(0));
    expect(result.hasToolCall).toBe(true);
    expect(result.stopReason).toBe("toolUse"); // completed + tool call => upgraded
  });

  it("is deterministic across reruns", () => {
    const a = renderEvents(buildTurn(turn1Rule, new IdMinter(0)).events);
    const b = renderEvents(buildTurn(turn1Rule, new IdMinter(0)).events);
    expect(a).toBe(b);
  });
});

describe("buildTurn — id minting when not scenario-provided", () => {
  it("mints response/item/call ids from the seeded counter", () => {
    const rule: Rule = {
      match: { default: true },
      steps: [
        { type: "text", content: "hi" },
        { type: "stop", status: "completed" },
      ],
    };
    const result = buildTurn(rule, new IdMinter(0));
    const text = renderEvents(result.events);
    expect(text).toContain('"id":"resp_1"'); // response.created
    expect(text).toContain('"id":"msg_2"'); // message item
    expect(result.stopReason).toBe("stop");
  });
});

describe("buildTurn — text step", () => {
  it("emits added + output_text.delta(s) + done for a plain message", () => {
    const rule: Rule = {
      match: { default: true },
      responseId: "resp_x",
      steps: [
        { type: "text", content: "All tests passed.", itemId: "msg_x", deltas: 1 },
        { type: "stop", status: "completed" },
      ],
    };
    const text = renderEvents(buildTurn(rule, new IdMinter(0)).events);
    expect(text).toContain(
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_x"}}\n\n',
    );
    expect(text).toContain(
      'data: {"type":"response.output_text.delta","output_index":0,"delta":"All tests passed."}\n\n',
    );
    expect(text).toContain(
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_x","content":[{"type":"output_text","text":"All tests passed."}]}}\n\n',
    );
  });

  it("even-splits content into N deltas when `deltas` is set", () => {
    const rule: Rule = {
      match: { default: true },
      steps: [
        { type: "text", content: "abcdef", deltas: 3 },
        { type: "stop", status: "completed" },
      ],
    };
    const text = renderEvents(buildTurn(rule, new IdMinter(0)).events);
    expect(text).toContain('"delta":"ab"');
    expect(text).toContain('"delta":"cd"');
    expect(text).toContain('"delta":"ef"');
  });
});

describe("buildTurn — terminal/stop mapping", () => {
  it("incomplete => length", () => {
    const rule: Rule = {
      match: { default: true },
      steps: [{ type: "text", content: "x" }, { type: "stop", status: "incomplete" }],
    };
    const result = buildTurn(rule, new IdMinter(0));
    expect(result.stopReason).toBe("length");
    expect(renderEvents(result.events)).toContain('"type":"response.incomplete"');
  });

  it("defaults to completed/stop when no stop step is given", () => {
    const rule: Rule = { match: { default: true }, steps: [{ type: "text", content: "x" }] };
    const result = buildTurn(rule, new IdMinter(0));
    expect(result.stopReason).toBe("stop");
    expect(renderEvents(result.events)).toContain('"type":"response.completed"');
  });

  it("omits usage from the terminal event when no usage step is present", () => {
    const rule: Rule = { match: { default: true }, steps: [{ type: "text", content: "x" }] };
    const text = renderEvents(buildTurn(rule, new IdMinter(0)).events);
    expect(text).not.toContain('"usage"');
  });
});

describe("buildTurn — refusal + reasoning part.done", () => {
  it("emits refusal deltas when a text step is marked refusal", () => {
    const rule: Rule = {
      match: { default: true },
      steps: [
        { type: "text", content: "I can't help with that.", refusal: true, itemId: "msg_r" },
        { type: "stop", status: "completed" },
      ],
    };
    const text = renderEvents(buildTurn(rule, new IdMinter(0)).events);
    expect(text).toContain('"type":"response.refusal.delta"');
    expect(text).toContain('"refusal":"I can\'t help with that."');
  });
});

describe("buildTurn — delay attaches to following event", () => {
  it("carries delayBeforeMs on the event after a delay step", () => {
    const rule: Rule = {
      match: { default: true },
      steps: [
        { type: "delay", ms: 250 },
        { type: "text", content: "hi" },
        { type: "stop", status: "completed" },
      ],
    };
    const events = buildTurn(rule, new IdMinter(0)).events;
    // response.created is first (index 0); the delay applies to the next emitted event.
    const delayed = events.find((e) => e.delayBeforeMs === 250);
    expect(delayed).toBeDefined();
  });
});
