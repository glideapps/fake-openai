/**
 * Test-only control + read API (PLAN.md §7, REQS §9), under /api/__mock__.
 * Unauthenticated (a test tool). CORS open for browser/test-runner use.
 */
import { app } from "flingit";
import { cors } from "hono/cors";
import { validateScenario } from "./validate.js";
import {
  createSession,
  deleteSession,
  expireDeviceAuths,
  getDeviceAuthByUserCode,
  getSession,
  listDeviceAuths,
  listRequests,
  listSessions,
  listTokens,
  resetSession,
  setDeviceStatus,
  setScenario,
} from "./store.js";

function baseUrls(reqUrl: string, key: string) {
  const origin = new URL(reqUrl).origin;
  return {
    inferenceBaseUrl: `${origin}/oai/${key}/backend-api`,
    oauthBaseUrl: `${origin}/oai/${key}`,
  };
}

function scenarioOf(row: { scenario_json: string | null }): unknown {
  return row.scenario_json ? JSON.parse(row.scenario_json) : null;
}

export function registerControlRoutes(): void {
  app.use(
    "/api/*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  // Create a session.
  app.post("/api/__mock__/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let scenarioJson: string | null = null;
    if (body.scenario !== undefined) {
      const v = validateScenario(body.scenario);
      if (!v.ok) return c.json({ error: "invalid_scenario", details: v.errors }, 400);
      scenarioJson = JSON.stringify(body.scenario);
    }
    const session = await createSession({ name: body.name ?? null, scenarioJson });
    return c.json(
      {
        sessionKey: session.id,
        name: session.name,
        ...baseUrls(c.req.url, session.id),
        createdAt: session.created_at,
        expiresAt: session.expires_at,
      },
      201,
    );
  });

  // List sessions (newest first).
  app.get("/api/__mock__/sessions", async (c) => {
    const rows = await listSessions();
    return c.json(
      rows.map((r) => ({
        sessionKey: r.id,
        name: r.name,
        hasScenario: r.scenario_json !== null,
        nextRuleIndex: r.next_rule_index,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      })),
    );
  });

  // Session detail (includes the loaded scenario).
  app.get("/api/__mock__/sessions/:key", async (c) => {
    const row = await getSession(c.req.param("key"));
    if (!row) return c.json({ error: "session_not_found" }, 404);
    return c.json({
      sessionKey: row.id,
      name: row.name,
      scenario: scenarioOf(row),
      nextRuleIndex: row.next_rule_index,
      idSeed: row.id_seed,
      ...baseUrls(c.req.url, row.id),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    });
  });

  // Delete a session.
  app.delete("/api/__mock__/sessions/:key", async (c) => {
    const row = await getSession(c.req.param("key"));
    if (!row) return c.json({ error: "session_not_found" }, 404);
    await deleteSession(row.id);
    return c.json({ deleted: true });
  });

  // Load / replace the active scenario.
  app.post("/api/__mock__/sessions/:key/scenario", async (c) => {
    const row = await getSession(c.req.param("key"));
    if (!row) return c.json({ error: "session_not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const v = validateScenario(body);
    if (!v.ok) return c.json({ error: "invalid_scenario", details: v.errors }, 400);
    await setScenario(row.id, JSON.stringify(body));
    return c.json({ ok: true });
  });

  // Reset runtime state (cursors, device state, tokens, log) + id seed.
  app.post("/api/__mock__/sessions/:key/reset", async (c) => {
    const row = await getSession(c.req.param("key"));
    if (!row) return c.json({ error: "session_not_found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const keepScenario = body.keepScenario !== false; // default true
    await resetSession(row.id, keepScenario);
    return c.json({ reset: true, keptScenario: keepScenario });
  });

  // Approve a pending device code by user_code (programmatic "click approve").
  app.post("/api/__mock__/sessions/:key/deviceauth/approve", async (c) => {
    const row = await getSession(c.req.param("key"));
    if (!row) return c.json({ error: "session_not_found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const dev = await getDeviceAuthByUserCode(row.id, String(body.user_code ?? ""));
    if (!dev) return c.json({ error: "device_code_not_found" }, 404);
    await setDeviceStatus(dev.id, "approved");
    return c.json({ approved: true });
  });

  // Virtual-time trigger for the device-code 900s deadline (REQS §10).
  app.post("/api/__mock__/sessions/:key/expire", async (c) => {
    const row = await getSession(c.req.param("key"));
    if (!row) return c.json({ error: "session_not_found" }, 404);
    const expired = await expireDeviceAuths(row.id);
    return c.json({ expired });
  });

  // Full request log (assertable; uncapped within a session).
  app.get("/api/__mock__/sessions/:key/requests", async (c) => {
    const row = await getSession(c.req.param("key"));
    if (!row) return c.json({ error: "session_not_found" }, 404);
    const rows = await listRequests(row.id);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        surface: r.surface,
        method: r.method,
        path: r.path,
        status: r.status,
        headers: r.request_headers_json ? JSON.parse(r.request_headers_json) : null,
        body: r.request_body_json ? tryParse(r.request_body_json) : null,
        matchedRuleIndex: r.matched_rule_index,
        stopReason: r.stop_reason,
        aborted: r.aborted === 1,
        finalized: r.finalized === 1,
        events: r.events,
        createdAt: r.created_at,
      })),
    );
  });

  // Clock-free state view.
  app.get("/api/__mock__/sessions/:key/state", async (c) => {
    const row = await getSession(c.req.param("key"));
    if (!row) return c.json({ error: "session_not_found" }, 404);
    const tokens = await listTokens(row.id);
    const deviceAuths = await listDeviceAuths(row.id);
    return c.json({
      nextRuleIndex: row.next_rule_index,
      idSeed: row.id_seed,
      faultAttempts: JSON.parse(row.fault_attempts_json),
      tokens: tokens.map((t) => ({
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        accountId: t.account_id,
        kind: t.kind,
        rotatedFrom: t.rotated_from,
      })),
      deviceAuths: deviceAuths.map((d) => ({
        deviceAuthId: d.device_auth_id,
        userCode: d.user_code,
        status: d.status,
        pollCount: d.poll_count,
      })),
    });
  });
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
