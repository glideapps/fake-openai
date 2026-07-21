/**
 * Rule matching (PLAN.md §4.2, REQS §7.1).
 *
 * Predicates over the decoded Codex request body. The mock picks the first
 * UNCONSUMED rule whose matcher is satisfied (consumption/cursor logic lives in
 * the caller); this module is pure.
 */
import type { Rule, Matcher } from "./types.js";

export interface MatchContext {
  /** Nth request within the session (0-based). */
  turnIndex: number;
  /** Resolved session id (prompt_cache_key / session-id / x-client-request-id). */
  sessionId: string;
}

/** Latest user message text in `input` (joins its input_text parts). */
export function latestUserText(body: any): string {
  const input = Array.isArray(body?.input) ? body.input : [];
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item?.role === "user" && Array.isArray(item.content)) {
      return item.content
        .filter((c: any) => c?.type === "input_text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("");
    }
  }
  return "";
}

/** Output string of the most recent function_call_output in `input`, or null. */
export function latestToolResult(body: any): string | null {
  const input = Array.isArray(body?.input) ? body.input : [];
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item?.type === "function_call_output" && typeof item.output === "string") {
      return item.output;
    }
  }
  return null;
}

function textMatches(pred: string | { regex: string }, haystack: string): boolean {
  if (typeof pred === "string") return haystack.includes(pred);
  return new RegExp(pred.regex).test(haystack);
}

export function ruleMatches(rule: Rule, body: any, ctx: MatchContext): boolean {
  const m: Matcher = rule.match;

  if (m.default === true) return true;

  // An empty match object is not an accidental catch-all — use { default: true }.
  const keys = Object.keys(m);
  if (keys.length === 0) return false;

  if (m.userMessage !== undefined) {
    if (!textMatches(m.userMessage, latestUserText(body))) return false;
  }
  if (m.toolResultContains !== undefined) {
    const result = latestToolResult(body);
    if (result === null || !textMatches(m.toolResultContains, result)) return false;
  }
  if (m.turnIndex !== undefined) {
    if (m.turnIndex !== ctx.turnIndex) return false;
  }
  if (m.session !== undefined) {
    if (m.session !== ctx.sessionId) return false;
  }
  return true;
}
