import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { app, db } from "flingit";
import { runMigrations } from "flingit/runtime/migrate";
import "./index.js";

async function createSession(body: Record<string, unknown> = {}): Promise<any> {
  const res = await app.request("/api/__mock__/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  for (const t of [
    "request_events",
    "request_log",
    "tokens",
    "device_auths",
    "mock_sessions",
  ]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("POST /api/__mock__/sessions", () => {
  it("creates a session and returns a key + base URLs to configure", async () => {
    const res = await createSession({ name: "e2e-1" });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.sessionKey).toMatch(/^sess_[0-9a-f]+$/);
    expect(data.name).toBe("e2e-1");
    // The base URLs embed the session key (the isolation mechanism, PLAN §2).
    expect(data.inferenceBaseUrl).toContain(`/oai/${data.sessionKey}/backend-api`);
    expect(data.oauthBaseUrl).toContain(`/oai/${data.sessionKey}`);
  });

  it("accepts an inline scenario at creation", async () => {
    const scenario = { model: { rules: [{ match: { default: true }, steps: [] } ] } };
    const res = await createSession({ name: "s", scenario });
    const data = await res.json();
    const detail = await (await app.request(`/api/__mock__/sessions/${data.sessionKey}`)).json();
    expect(detail.scenario.model.rules).toHaveLength(1);
  });

  it("rejects an invalid scenario", async () => {
    const res = await createSession({ scenario: { model: { rules: "nope" } } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_scenario");
  });
});

describe("GET /api/__mock__/sessions", () => {
  it("lists sessions newest first", async () => {
    await createSession({ name: "a" });
    await createSession({ name: "b" });
    const res = await app.request("/api/__mock__/sessions");
    const rows = await res.json();
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("b");
  });
});

describe("POST /api/__mock__/sessions/:key/scenario", () => {
  it("loads/replaces the active scenario", async () => {
    const { sessionKey } = await (await createSession()).json();
    const scenario = {
      model: { rules: [{ match: { userMessage: "hi" }, steps: [{ type: "text", content: "yo" }] }] },
    };
    const res = await app.request(`/api/__mock__/sessions/${sessionKey}/scenario`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scenario),
    });
    expect(res.status).toBe(200);
    const detail = await (await app.request(`/api/__mock__/sessions/${sessionKey}`)).json();
    expect(detail.scenario.model.rules[0].match.userMessage).toBe("hi");
  });

  it("404s for an unknown session", async () => {
    const res = await app.request("/api/__mock__/sessions/sess_nope/scenario", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/__mock__/sessions/:key/reset", () => {
  it("resets the id seed and rule cursor, keeping the scenario by default", async () => {
    const scenario = { model: { rules: [{ match: { default: true }, steps: [] }] } };
    const { sessionKey } = await (await createSession({ scenario })).json();

    // Advance some state directly.
    db.prepare("UPDATE mock_sessions SET id_seed = 7, next_rule_index = 3 WHERE id = ?")
      .bind(sessionKey)
      .run();

    const res = await app.request(`/api/__mock__/sessions/${sessionKey}/reset`, { method: "POST" });
    expect(res.status).toBe(200);

    const row: any = await db.prepare("SELECT * FROM mock_sessions WHERE id = ?").bind(sessionKey).first();
    expect(row.id_seed).toBe(0);
    expect(row.next_rule_index).toBe(0);
    expect(row.scenario_json).not.toBeNull(); // kept
  });

  it("drops the scenario when keepScenario=false", async () => {
    const scenario = { model: { rules: [] } };
    const { sessionKey } = await (await createSession({ scenario })).json();
    await app.request(`/api/__mock__/sessions/${sessionKey}/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keepScenario: false }),
    });
    const row: any = await db.prepare("SELECT * FROM mock_sessions WHERE id = ?").bind(sessionKey).first();
    expect(row.scenario_json).toBeNull();
  });
});

describe("DELETE /api/__mock__/sessions/:key", () => {
  it("deletes the session", async () => {
    const { sessionKey } = await (await createSession()).json();
    const res = await app.request(`/api/__mock__/sessions/${sessionKey}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const check = await app.request(`/api/__mock__/sessions/${sessionKey}`);
    expect(check.status).toBe(404);
  });
});

describe("GET /api/__mock__/sessions/:key/state", () => {
  it("reports cursor, tokens and device status (clock-free)", async () => {
    const { sessionKey } = await (await createSession()).json();
    const res = await app.request(`/api/__mock__/sessions/${sessionKey}/state`);
    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.nextRuleIndex).toBe(0);
    expect(state.tokens).toEqual([]);
    expect(state.deviceAuths).toEqual([]);
  });
});

describe("CORS", () => {
  it("answers OPTIONS preflight on /api/*", async () => {
    const res = await app.request("/api/__mock__/sessions", { method: "OPTIONS" });
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
