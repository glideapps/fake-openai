/**
 * Streaming engine (PLAN.md §4.3, REQS §4.3.1 / §7.3).
 *
 * Turns one scenario rule (one model turn) into an ordered list of SSE events
 * covering the full vocabulary pi-ai's parser handles. Objects are built with
 * keys in the exact wire order so `JSON.stringify` output is byte-identical.
 */
import type { EmitEvent } from "./sse.js";
import type { IdMinter } from "./ids.js";
import type { Rule, Step, UsageStep } from "./types.js";

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface Turn {
  events: EmitEvent[];
  responseId: string;
  hasToolCall: boolean;
  stopReason: StopReason;
}

export function buildTurn(rule: Rule, minter: IdMinter): Turn {
  const events: EmitEvent[] = [];
  let pendingDelay = 0;
  const push = (data: unknown) => {
    const ev: EmitEvent = { data };
    if (pendingDelay > 0) {
      ev.delayBeforeMs = pendingDelay;
      pendingDelay = 0;
    }
    events.push(ev);
  };

  const responseId = rule.responseId ?? minter.next("resp");
  push({ type: "response.created", response: { id: responseId } });

  let outputIndex = 0;
  let hasToolCall = false;
  let usage: Record<string, unknown> | undefined;
  let stopStatus: "completed" | "incomplete" | "failed" | "cancelled" = "completed";

  for (const step of rule.steps ?? []) {
    switch (step.type) {
      case "delay":
        pendingDelay += step.ms;
        break;

      case "usage":
        usage = buildUsage(step);
        break;

      case "stop":
        stopStatus = step.status ?? "completed";
        break;

      case "reasoning": {
        const id = step.itemId ?? minter.next("rs");
        const idx = outputIndex++;
        push({
          type: "response.output_item.added",
          output_index: idx,
          item: { type: "reasoning", id },
        });
        const deltaType =
          step.variant === "text"
            ? "response.reasoning_text.delta"
            : "response.reasoning_summary_text.delta";
        for (const delta of splitText(step.text, step.deltas, step.chunks)) {
          push({ type: deltaType, output_index: idx, delta });
        }
        const enc = step.encryptedContent ?? minter.next("enc");
        const item: Record<string, unknown> = { type: "reasoning", id };
        if (step.variant === "text") item.content = [{ text: step.text }];
        else item.summary = [{ text: step.text }];
        item.encrypted_content = enc;
        push({ type: "response.output_item.done", output_index: idx, item });
        break;
      }

      case "text": {
        const id = step.itemId ?? minter.next("msg");
        const idx = outputIndex++;
        push({
          type: "response.output_item.added",
          output_index: idx,
          item: { type: "message", id },
        });
        const deltaType = step.refusal
          ? "response.refusal.delta"
          : "response.output_text.delta";
        for (const delta of splitText(step.content, step.deltas, step.chunks)) {
          push({ type: deltaType, output_index: idx, delta });
        }
        const content = step.refusal
          ? [{ refusal: step.content }]
          : [{ type: "output_text", text: step.content }];
        push({
          type: "response.output_item.done",
          output_index: idx,
          item: { type: "message", id, content },
        });
        break;
      }

      case "toolCall": {
        const id = step.itemId ?? minter.next("fc");
        const callId = step.callId ?? minter.next("call");
        const idx = outputIndex++;
        const argStr =
          typeof step.arguments === "string" ? step.arguments : JSON.stringify(step.arguments);
        push({
          type: "response.output_item.added",
          output_index: idx,
          item: { type: "function_call", id, call_id: callId, name: step.name },
        });
        const argChunks = step.argumentChunks ?? splitText(argStr, step.deltas);
        for (const delta of argChunks) {
          push({ type: "response.function_call_arguments.delta", output_index: idx, delta });
        }
        push({
          type: "response.function_call_arguments.done",
          output_index: idx,
          arguments: argStr,
        });
        push({
          type: "response.output_item.done",
          output_index: idx,
          item: { type: "function_call", id, call_id: callId, name: step.name, arguments: argStr },
        });
        hasToolCall = true;
        break;
      }
    }
  }

  // Terminal event.
  if (stopStatus === "incomplete") {
    push({
      type: "response.incomplete",
      response: usage
        ? { id: responseId, status: "incomplete", usage }
        : { id: responseId, status: "incomplete" },
    });
  } else if (stopStatus === "failed" || stopStatus === "cancelled") {
    push({
      type: "response.failed",
      response: { id: responseId, status: stopStatus, error: { code: "server_error", message: "scenario stop" } },
    });
  } else {
    push({
      type: "response.completed",
      response: usage
        ? { id: responseId, status: "completed", usage }
        : { id: responseId, status: "completed" },
    });
  }

  const stopReason = mapStopReason(stopStatus, hasToolCall);
  return { events, responseId, hasToolCall, stopReason };
}

function mapStopReason(
  status: "completed" | "incomplete" | "failed" | "cancelled",
  hasToolCall: boolean,
): StopReason {
  if (status === "incomplete") return "length";
  if (status === "failed" || status === "cancelled") return "error";
  // completed
  return hasToolCall ? "toolUse" : "stop";
}

function buildUsage(step: UsageStep): Record<string, unknown> {
  const u: Record<string, unknown> = {};
  if (step.input_tokens !== undefined) u.input_tokens = step.input_tokens;
  if (step.output_tokens !== undefined) u.output_tokens = step.output_tokens;
  if (step.total_tokens !== undefined) u.total_tokens = step.total_tokens;
  if (step.input_tokens_details !== undefined) u.input_tokens_details = step.input_tokens_details;
  if (step.output_tokens_details !== undefined) u.output_tokens_details = step.output_tokens_details;
  return u;
}

/** Split `text` into deltas: explicit `chunks` win; else even N-way; else whole. */
function splitText(text: string, deltas?: number, chunks?: string[]): string[] {
  if (chunks) return chunks;
  const n = deltas && deltas > 0 ? deltas : 1;
  if (n <= 1) return [text];
  const parts: string[] = [];
  const base = Math.floor(text.length / n);
  let rem = text.length % n;
  let i = 0;
  for (let k = 0; k < n; k++) {
    const size = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    parts.push(text.slice(i, i + size));
    i += size;
  }
  return parts;
}
