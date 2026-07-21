import { describe, it, expect } from "vitest";
import { latestUserText, latestToolResult, ruleMatches } from "./matcher.js";
import type { Rule } from "./types.js";

const userBody = {
  input: [
    { role: "user", content: [{ type: "input_text", text: "please run the tests now" }] },
  ],
};

const toolBody = {
  input: [
    { role: "user", content: [{ type: "input_text", text: "run the tests" }] },
    { type: "function_call", call_id: "c1", name: "bash", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "Tests: 12 passed, 0 failed" },
  ],
};

describe("latestUserText", () => {
  it("extracts the latest user input_text", () => {
    expect(latestUserText(userBody)).toBe("please run the tests now");
  });

  it("returns the LAST user message when several are present", () => {
    const body = {
      input: [
        { role: "user", content: [{ type: "input_text", text: "first" }] },
        { role: "user", content: [{ type: "input_text", text: "second" }] },
      ],
    };
    expect(latestUserText(body)).toBe("second");
  });

  it("joins multiple input_text parts of the latest user message", () => {
    const body = {
      input: [
        { role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }] },
      ],
    };
    expect(latestUserText(body)).toBe("ab");
  });

  it("returns empty string when there is no user message", () => {
    expect(latestUserText({ input: [] })).toBe("");
    expect(latestUserText({})).toBe("");
  });
});

describe("latestToolResult", () => {
  it("extracts the most recent function_call_output", () => {
    expect(latestToolResult(toolBody)).toBe("Tests: 12 passed, 0 failed");
  });

  it("returns the LAST output when several are present", () => {
    const body = {
      input: [
        { type: "function_call_output", call_id: "a", output: "old" },
        { type: "function_call_output", call_id: "b", output: "new" },
      ],
    };
    expect(latestToolResult(body)).toBe("new");
  });

  it("returns null when there is no tool result", () => {
    expect(latestToolResult(userBody)).toBeNull();
  });
});

describe("ruleMatches", () => {
  const ctx = (over: Partial<{ turnIndex: number; sessionId: string }> = {}) => ({
    turnIndex: over.turnIndex ?? 0,
    sessionId: over.sessionId ?? "sess_1",
  });

  it("matches userMessage substring", () => {
    const rule: Rule = { match: { userMessage: "run the tests" } };
    expect(ruleMatches(rule, userBody, ctx())).toBe(true);
  });

  it("does not match a userMessage substring that is absent", () => {
    const rule: Rule = { match: { userMessage: "deploy" } };
    expect(ruleMatches(rule, userBody, ctx())).toBe(false);
  });

  it("matches userMessage regex", () => {
    const rule: Rule = { match: { userMessage: { regex: "run the tests?" } } };
    expect(ruleMatches(rule, userBody, ctx())).toBe(true);
  });

  it("matches toolResultContains regex", () => {
    const rule: Rule = { match: { toolResultContains: { regex: "(passed|passing|Tests:)" } } };
    expect(ruleMatches(rule, toolBody, ctx())).toBe(true);
  });

  it("does not match toolResultContains when there is no tool result", () => {
    const rule: Rule = { match: { toolResultContains: "passed" } };
    expect(ruleMatches(rule, userBody, ctx())).toBe(false);
  });

  it("matches turnIndex", () => {
    const rule: Rule = { match: { turnIndex: 2 } };
    expect(ruleMatches(rule, userBody, ctx({ turnIndex: 2 }))).toBe(true);
    expect(ruleMatches(rule, userBody, ctx({ turnIndex: 1 }))).toBe(false);
  });

  it("matches session", () => {
    const rule: Rule = { match: { session: "sess_9" } };
    expect(ruleMatches(rule, userBody, ctx({ sessionId: "sess_9" }))).toBe(true);
    expect(ruleMatches(rule, userBody, ctx({ sessionId: "other" }))).toBe(false);
  });

  it("default matches anything", () => {
    const rule: Rule = { match: { default: true } };
    expect(ruleMatches(rule, userBody, ctx())).toBe(true);
    expect(ruleMatches(rule, {}, ctx())).toBe(true);
  });

  it("ANDs multiple predicates", () => {
    const rule: Rule = { match: { userMessage: "run the tests", turnIndex: 0 } };
    expect(ruleMatches(rule, userBody, ctx({ turnIndex: 0 }))).toBe(true);
    expect(ruleMatches(rule, userBody, ctx({ turnIndex: 1 }))).toBe(false);
  });

  it("an empty match object matches nothing (avoid accidental catch-all)", () => {
    const rule: Rule = { match: {} };
    expect(ruleMatches(rule, userBody, ctx())).toBe(false);
  });
});
