import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { app, db } from "flingit";
import { runMigrations } from "flingit/runtime/migrate";
import "./index.js";
import { extractAccountId } from "./jwt.js";

async function newSession(auth: Record<string, unknown> = {}): Promise<string> {
  const res = await app.request("/api/__mock__/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario: { auth } }),
  });
  return (await res.json()).sessionKey;
}

function usercode(key: string): Promise<Response> {
  return app.request(`/oai/${key}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" }),
  });
}

function poll(key: string, deviceAuthId: string, userCode: string): Promise<Response> {
  return app.request(`/oai/${key}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
  });
}

function tokenExchange(key: string, form: Record<string, string>): Promise<Response> {
  return app.request(`/oai/${key}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

beforeAll(async () => {
  await runMigrations();
});
beforeEach(async () => {
  for (const t of ["request_events", "request_log", "tokens", "device_auths", "mock_sessions"]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

describe("POST /deviceauth/usercode", () => {
  it("returns device_auth_id, user_code, and a numeric interval", async () => {
    const key = await newSession();
    const res = await usercode(key);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.device_auth_id).toBe("string");
    expect(typeof data.user_code).toBe("string");
    expect(Number.isFinite(Number(data.interval))).toBe(true);
  });

  it("mints deterministic ids (same session reset => identical values)", async () => {
    const key = await newSession();
    const a = await (await usercode(key)).json();
    await app.request(`/api/__mock__/sessions/${key}/reset`, { method: "POST" });
    const b = await (await usercode(key)).json();
    expect(a.device_auth_id).toBe(b.device_auth_id);
    expect(a.user_code).toBe(b.user_code);
  });
});

describe("device poll — auto-approve (fully scriptable, no human)", () => {
  it("approves on the first poll by default", async () => {
    const key = await newSession();
    const { device_auth_id, user_code } = await (await usercode(key)).json();
    const res = await poll(key, device_auth_id, user_code);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.authorization_code).toBe("string");
    expect(typeof data.code_verifier).toBe("string");
  });

  it("returns pending (403) then approves after approveAfterPolls", async () => {
    const key = await newSession({ device: { approveAfterPolls: 2 } });
    const { device_auth_id, user_code } = await (await usercode(key)).json();
    const first = await poll(key, device_auth_id, user_code);
    expect(first.status).toBe(403); // pending
    const second = await poll(key, device_auth_id, user_code);
    expect(second.status).toBe(200);
    expect((await second.json()).authorization_code).toBeDefined();
  });

  it("returns slow_down for the first slowDownPolls polls", async () => {
    const key = await newSession({ device: { slowDownPolls: 1, approveAfterPolls: 2 } });
    const { device_auth_id, user_code } = await (await usercode(key)).json();
    const first = await poll(key, device_auth_id, user_code);
    expect(first.status).not.toBe(200);
    const body = await first.json();
    const code = typeof body.error === "string" ? body.error : body.error?.code;
    expect(code).toBe("slow_down");
  });
});

describe("device poll — manual approve via control (programmatic, still no human typing)", () => {
  it("stays pending until the control approve call, then approves", async () => {
    const key = await newSession({ device: { manualApprove: true } });
    const { device_auth_id, user_code } = await (await usercode(key)).json();
    expect((await poll(key, device_auth_id, user_code)).status).toBe(403);

    const approve = await app.request(`/api/__mock__/sessions/${key}/deviceauth/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code }),
    });
    expect(approve.status).toBe(200);

    expect((await poll(key, device_auth_id, user_code)).status).toBe(200);
  });
});

describe("token exchange (authorization_code)", () => {
  it("returns a JWT access token, refresh token, and expires_in", async () => {
    const key = await newSession({ accountId: "acct_mock_0001", accessTokenExpiresIn: 3600 });
    const { device_auth_id, user_code } = await (await usercode(key)).json();
    const { authorization_code, code_verifier } = await (await poll(key, device_auth_id, user_code)).json();

    const res = await tokenExchange(key, {
      grant_type: "authorization_code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code: authorization_code,
      code_verifier,
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.access_token).toBe("string");
    expect(typeof data.refresh_token).toBe("string");
    expect(data.expires_in).toBe(3600);
    expect(extractAccountId(data.access_token)).toBe("acct_mock_0001");
  });

  it("can mint a bad JWT (missing account claim) to drive the extract-accountId failure", async () => {
    const key = await newSession({ omitAccountClaim: true });
    const { device_auth_id, user_code } = await (await usercode(key)).json();
    const { authorization_code, code_verifier } = await (await poll(key, device_auth_id, user_code)).json();
    const data = await (
      await tokenExchange(key, {
        grant_type: "authorization_code",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        code: authorization_code,
        code_verifier,
        redirect_uri: "https://auth.openai.com/deviceauth/callback",
      })
    ).json();
    expect(() => extractAccountId(data.access_token)).toThrow(/Failed to extract accountId/);
  });
});

describe("token refresh", () => {
  async function issue(key: string): Promise<{ refresh_token: string }> {
    const { device_auth_id, user_code } = await (await usercode(key)).json();
    const { authorization_code, code_verifier } = await (await poll(key, device_auth_id, user_code)).json();
    return await (
      await tokenExchange(key, {
        grant_type: "authorization_code",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        code: authorization_code,
        code_verifier,
        redirect_uri: "https://auth.openai.com/deviceauth/callback",
      })
    ).json();
  }

  it("returns a new access token for a valid refresh token (no rotation by default)", async () => {
    const key = await newSession();
    const { refresh_token } = await issue(key);
    const res = await tokenExchange(key, {
      grant_type: "refresh_token",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      refresh_token,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.access_token).toBe("string");
    expect(data.refresh_token).toBe(refresh_token); // not rotated
  });

  it("rotates the refresh token when configured", async () => {
    const key = await newSession({ refresh: { rotate: true } });
    const { refresh_token } = await issue(key);
    const data = await (
      await tokenExchange(key, {
        grant_type: "refresh_token",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        refresh_token,
      })
    ).json();
    expect(data.refresh_token).not.toBe(refresh_token);
  });

  it("fails refresh with the configured status", async () => {
    const key = await newSession({ refresh: { failStatus: 400 } });
    const { refresh_token } = await issue(key);
    const res = await tokenExchange(key, {
      grant_type: "refresh_token",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      refresh_token,
    });
    expect(res.status).toBe(400);
  });
});

describe("full auto flow end-to-end (zero manual intervention)", () => {
  it("usercode -> poll(approve) -> exchange yields a usable credential", async () => {
    const key = await newSession({ accountId: "acct_auto", accessTokenExpiresIn: 3600 });
    const uc = await (await usercode(key)).json();
    const polled = await (await poll(key, uc.device_auth_id, uc.user_code)).json();
    const tok = await (
      await tokenExchange(key, {
        grant_type: "authorization_code",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        code: polled.authorization_code,
        code_verifier: polled.code_verifier,
        redirect_uri: "https://auth.openai.com/deviceauth/callback",
      })
    ).json();
    expect(extractAccountId(tok.access_token)).toBe("acct_auto");

    const state = await (await app.request(`/api/__mock__/sessions/${key}/state`)).json();
    expect(state.tokens.length).toBe(1);
    expect(state.deviceAuths[0].status).toBe("approved");
  });
});
