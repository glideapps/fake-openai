/**
 * Codex Responses streaming endpoint (REQS §4.3), registered per session under
 * /oai/:key/backend-api/codex/responses.
 *
 * Pipeline: read raw body once -> decode (zstd or plain) -> match the first
 * unconsumed rule -> pre-stream faults -> stream SSE (logging each event) ->
 * finalize. WebSocket upgrade is not handled, so pi-ai falls back to SSE.
 */
import { app } from "flingit";
import { decodeRequestBody } from "./body.js";
import { buildTurn } from "./engine.js";
import { IdMinter } from "./ids.js";
import { ruleMatches } from "./matcher.js";
import { buildEventStream } from "./stream.js";
import type { EmitEvent } from "./sse.js";
import type { Rule, Scenario } from "./types.js";
import {
  appendRequestEvent,
  countModelRequests,
  finalizeRequest,
  getSession,
  insertRequestLog,
  updateCursor,
  type SessionRow,
} from "./store.js";

function headersObj(c: any): Record<string, string> {
  const out: Record<string, string> = {};
  (c.req.raw.headers as Headers).forEach((v: string, k: string) => (out[k] = v));
  return out;
}

function rulesOf(session: SessionRow): Rule[] {
  if (!session.scenario_json) return [];
  try {
    return ((JSON.parse(session.scenario_json) as Scenario).model?.rules as Rule[]) ?? [];
  } catch {
    return [];
  }
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

export function registerModelRoutes(): void {
  app.post("/oai/:key/backend-api/codex/responses", async (c) => {
    const key = c.req.param("key");
    const session = await getSession(key);
    if (!session) return c.json({ error: "unknown_session" }, 404);

    // Read the raw body exactly once (single-consume on Workers).
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const encoding = c.req.header("content-encoding") ?? null;
    const path = new URL(c.req.url).pathname;
    const headers = headersObj(c);

    let decoded;
    try {
      decoded = await decodeRequestBody(raw, encoding);
    } catch (e) {
      const id = await insertRequestLog({
        sessionId: key,
        surface: "model",
        method: "POST",
        path,
        status: 400,
        headers,
        body: null,
      });
      const body = { error: "invalid_body", message: (e as Error).message };
      await appendRequestEvent(id, 0, { kind: "response", status: 400, body });
      await finalizeRequest(id, { status: 400, stopReason: "error" });
      return c.json(body, 400);
    }

    const body = decoded.json;
    const sessionId =
      body?.prompt_cache_key ??
      c.req.header("session-id") ??
      c.req.header("x-client-request-id") ??
      key;
    const turnIndex = await countModelRequests(key);

    // Match the first unconsumed rule (index >= cursor).
    const rules = rulesOf(session);
    const cursor = session.next_rule_index;
    let matchedIndex = -1;
    for (let i = cursor; i < rules.length; i++) {
      if (ruleMatches(rules[i], body, { turnIndex, sessionId })) {
        matchedIndex = i;
        break;
      }
    }

    if (matchedIndex === -1) {
      const id = await insertRequestLog({
        sessionId: key,
        surface: "model",
        method: "POST",
        path,
        status: 400,
        headers,
        body: decoded.text,
        matchedRuleIndex: null,
      });
      const respBody = { error: "no_matching_rule" };
      await appendRequestEvent(id, 0, { kind: "response", status: 400, body: respBody });
      await finalizeRequest(id, { status: 400, stopReason: "error" });
      return c.json(respBody, 400);
    }

    const rule = rules[matchedIndex];

    // Fault: rateLimitThenSucceed — fail the first N attempts WITHOUT consuming
    // the rule (attempts tracked separately from the cursor).
    if (rule.fault?.rateLimitThenSucceed) {
      const faultAttempts = JSON.parse(session.fault_attempts_json) as Record<string, number>;
      const done = faultAttempts[matchedIndex] ?? 0;
      const need = rule.fault.rateLimitThenSucceed.attempts;
      if (done < need) {
        faultAttempts[matchedIndex] = done + 1;
        await updateCursor(key, { fault_attempts_json: JSON.stringify(faultAttempts) });
        const status = rule.fault.rateLimitThenSucceed.status ?? 429;
        const respBody = { error: { code: "rate_limit_exceeded", message: "rate limited, retry" } };
        const id = await insertRequestLog({
          sessionId: key,
          surface: "model",
          method: "POST",
          path,
          status,
          headers,
          body: decoded.text,
          matchedRuleIndex: matchedIndex,
        });
        await appendRequestEvent(id, 0, { kind: "response", status, body: respBody });
        await finalizeRequest(id, { status, stopReason: "error" });
        return c.json(respBody, status as any, { "retry-after": "1" });
      }
      // enough attempts made — fall through to stream and consume the rule.
    }

    // Fault: pre-stream httpError.
    if (rule.fault?.httpError) {
      const h = rule.fault.httpError;
      await updateCursor(key, { next_rule_index: matchedIndex + 1 });
      const respBody = {
        error: stripUndefined({
          code: h.code,
          type: h.type,
          message: h.message ?? "error",
          plan_type: h.plan_type,
          resets_at: h.resets_at,
        }),
      };
      const respHeaders: Record<string, string> = {};
      if (h.retryAfterSeconds !== undefined) respHeaders["retry-after"] = String(h.retryAfterSeconds);
      if (h.retryAfterMs !== undefined) respHeaders["retry-after-ms"] = String(h.retryAfterMs);
      const id = await insertRequestLog({
        sessionId: key,
        surface: "model",
        method: "POST",
        path,
        status: h.status,
        headers,
        body: decoded.text,
        matchedRuleIndex: matchedIndex,
      });
      await appendRequestEvent(id, 0, { kind: "response", status: h.status, body: respBody });
      await finalizeRequest(id, { status: h.status, stopReason: "error" });
      return c.json(respBody, h.status as any, respHeaders);
    }

    // Normal streaming turn.
    const minter = new IdMinter(session.id_seed);
    const turn = buildTurn(rule, minter);
    await updateCursor(key, { id_seed: minter.seed, next_rule_index: matchedIndex + 1 });

    let events: EmitEvent[] = turn.events;
    let holdOpen = false;
    let stopReason: string = turn.stopReason;

    if (rule.fault?.truncate) {
      events = events.slice(0, -1);
      stopReason = "truncated";
    } else if (rule.fault?.midStreamError) {
      const m = rule.fault.midStreamError;
      const errEvent =
        m.via === "response.failed"
          ? {
              type: "response.failed",
              response: {
                id: turn.responseId,
                error: { code: m.code ?? "server_error", message: m.message ?? "error" },
              },
            }
          : { type: "error", code: m.code ?? "server_error", message: m.message ?? "error" };
      events = [...events.slice(0, -1), { data: errEvent }];
      stopReason = "error";
    } else if (rule.fault?.hang) {
      events = events.slice(0, -1);
      holdOpen = true;
    }

    const logId = await insertRequestLog({
      sessionId: key,
      surface: "model",
      method: "POST",
      path,
      status: 200,
      headers,
      body: decoded.text,
      matchedRuleIndex: matchedIndex,
    });

    const stream = buildEventStream(events, {
      signal: c.req.raw.signal,
      holdOpen,
      logId,
      onFinalize: async (aborted) => {
        await finalizeRequest(logId, {
          status: 200,
          stopReason: aborted ? "aborted" : stopReason,
          aborted,
        });
      },
    });

    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  });
}
