import { describe, it, expect } from "vitest";
import { frameEvent, renderEvents } from "./sse.js";

describe("frameEvent", () => {
  it("frames a single event as `data: <json>\\n\\n`", () => {
    expect(frameEvent({ type: "response.created", response: { id: "resp_1" } })).toBe(
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
    );
  });

  it("preserves object key insertion order (byte-identical output)", () => {
    expect(frameEvent({ type: "x", output_index: 0, delta: "hi" })).toBe(
      'data: {"type":"x","output_index":0,"delta":"hi"}\n\n',
    );
  });

  it("JSON-escapes strings correctly (quotes, backslashes)", () => {
    expect(frameEvent({ arguments: '{"command":"npm test"}' })).toBe(
      'data: {"arguments":"{\\"command\\":\\"npm test\\"}"}\n\n',
    );
  });
});

describe("renderEvents", () => {
  it("concatenates framed events with no extra separators", () => {
    const out = renderEvents([
      { data: { type: "a" } },
      { data: { type: "b" } },
    ]);
    expect(out).toBe('data: {"type":"a"}\n\ndata: {"type":"b"}\n\n');
  });

  it("ignores delayBeforeMs when rendering to a string", () => {
    const out = renderEvents([{ data: { type: "a" }, delayBeforeMs: 500 }]);
    expect(out).toBe('data: {"type":"a"}\n\n');
  });
});
