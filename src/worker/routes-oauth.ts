/**
 * OAuth device-code + token/refresh endpoints (REQS §4.1, §4.2), registered per
 * session under /oai/:key/... The flow is fully scriptable — auto-approve by
 * default (return `pending` for approveAfterPolls-1 polls, then the code), with
 * no human step. All emitted ids/tokens are deterministic (minted from the
 * session id_seed); the JWT is deterministic from the account id.
 */
import { app } from "flingit";
import { IdMinter } from "./ids.js";
import { mintAccessToken } from "./jwt.js";
import type { AuthScenario } from "./types.js";
import {
  appendRequestEvent,
  bumpDevicePoll,
  createDeviceAuth,
  finalizeRequest,
  getDeviceAuthByAuthCode,
  getDeviceAuthById,
  getSession,
  getTokenByRefresh,
  insertRequestLog,
  insertToken,
  setDeviceStatus,
  updateCursor,
  type SessionRow,
} from "./store.js";

const DEFAULT_ACCOUNT_ID = "acct_mock_0001";
const DEFAULT_EXPIRES_IN = 3600;
const DEVICE_TTL_SECONDS = 900;
const POLL_INTERVAL = 1;

function authOf(session: SessionRow): AuthScenario {
  if (!session.scenario_json) return {};
  try {
    return (JSON.parse(session.scenario_json).auth as AuthScenario) ?? {};
  } catch {
    return {};
  }
}

function headersObj(c: any): Record<string, string> {
  const out: Record<string, string> = {};
  (c.req.raw.headers as Headers).forEach((v: string, k: string) => (out[k] = v));
  return out;
}

async function logAuth(
  c: any,
  sessionId: string,
  status: number,
  reqBody: unknown,
  respBody: unknown,
): Promise<void> {
  const id = await insertRequestLog({
    sessionId,
    surface: "auth",
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status,
    headers: headersObj(c),
    body: typeof reqBody === "string" ? reqBody : JSON.stringify(reqBody),
  });
  await appendRequestEvent(id, 0, { kind: "response", status, body: respBody });
  await finalizeRequest(id, { status, aborted: false });
}

export function registerOAuthRoutes(): void {
  // (a) Start device authorization.
  app.post("/oai/:key/api/accounts/deviceauth/usercode", async (c) => {
    const key = c.req.param("key");
    const session = await getSession(key);
    if (!session) return c.json({ error: "unknown_session" }, 404);
    const body = await c.req.json().catch(() => ({}));

    const minter = new IdMinter(session.id_seed);
    const deviceAuthId = minter.next("deviceauth");
    const userCode = minter.next("usercode");
    const authorizationCode = minter.next("authcode");
    const codeVerifier = minter.next("verifier");
    await createDeviceAuth({
      sessionId: key,
      deviceAuthId,
      userCode,
      authorizationCode,
      codeVerifier,
      ttlSeconds: DEVICE_TTL_SECONDS,
    });
    await updateCursor(key, { id_seed: minter.seed });

    const resp = { device_auth_id: deviceAuthId, user_code: userCode, interval: POLL_INTERVAL };
    await logAuth(c, key, 200, body, resp);
    return c.json(resp);
  });

  // (b) Poll for authorization.
  app.post("/oai/:key/api/accounts/deviceauth/token", async (c) => {
    const key = c.req.param("key");
    const session = await getSession(key);
    if (!session) return c.json({ error: "unknown_session" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const auth = authOf(session);

    const dev = await getDeviceAuthById(key, String(body.device_auth_id ?? ""));
    if (!dev) {
      // Unknown device auth: 404 is treated as "pending" by pi-ai.
      const resp = { error: { code: "deviceauth_authorization_pending" } };
      await logAuth(c, key, 404, body, resp);
      return c.json(resp, 404);
    }

    const pollCount = await bumpDevicePoll(dev.id);

    // Expired (via /expire control) -> failed.
    if (dev.status === "expired") {
      const resp = { error: { code: "deviceauth_expired", message: "device code expired" } };
      await logAuth(c, key, 400, body, resp);
      return c.json(resp, 400);
    }

    // slow_down window.
    const slowDownPolls = auth.device?.slowDownPolls ?? 0;
    if (pollCount <= slowDownPolls) {
      const resp = { error: { code: "slow_down" } };
      await logAuth(c, key, 429, body, resp);
      return c.json(resp, 429);
    }

    // Manual (control) approval only.
    if (auth.device?.manualApprove) {
      if (dev.status === "approved") {
        const resp = { authorization_code: dev.authorization_code, code_verifier: dev.code_verifier };
        await logAuth(c, key, 200, body, resp);
        return c.json(resp, 200);
      }
      const resp = { error: { code: "deviceauth_authorization_pending" } };
      await logAuth(c, key, 403, body, resp);
      return c.json(resp, 403);
    }

    // Expire scenario: never approve (pi-ai eventually times out at 900s).
    if (auth.device?.expire) {
      const resp = { error: { code: "deviceauth_authorization_pending" } };
      await logAuth(c, key, 403, body, resp);
      return c.json(resp, 403);
    }

    // Auto-approve after N polls (default 1 = approve on first poll).
    const approveAfter = auth.device?.approveAfterPolls ?? 1;
    if (pollCount >= approveAfter) {
      await setDeviceStatus(dev.id, "approved");
      const resp = { authorization_code: dev.authorization_code, code_verifier: dev.code_verifier };
      await logAuth(c, key, 200, body, resp);
      return c.json(resp, 200);
    }

    const resp = { error: { code: "deviceauth_authorization_pending" } };
    await logAuth(c, key, 403, body, resp);
    return c.json(resp, 403);
  });

  // (c) Token exchange + refresh.
  app.post("/oai/:key/oauth/token", async (c) => {
    const key = c.req.param("key");
    const session = await getSession(key);
    if (!session) return c.json({ error: "unknown_session" }, 404);
    const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, string>;
    const auth = authOf(session);
    const accountId = auth.accountId ?? DEFAULT_ACCOUNT_ID;
    const expiresIn = auth.accessTokenExpiresIn ?? DEFAULT_EXPIRES_IN;
    const grant = form.grant_type;
    const minter = new IdMinter(session.id_seed);

    if (grant === "authorization_code") {
      const dev = await getDeviceAuthByAuthCode(key, form.code ?? "");
      if (!dev) {
        const resp = { error: "invalid_grant", error_description: "unknown authorization code" };
        await logAuth(c, key, 400, form, resp);
        return c.json(resp, 400);
      }
      const accessToken = mintAccessToken({ accountId, omitAccountClaim: auth.omitAccountClaim });
      const refreshToken = minter.next("refresh");
      await insertToken({ sessionId: key, accessToken, refreshToken, accountId, kind: "issue" });
      await updateCursor(key, { id_seed: minter.seed });
      const resp = { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn };
      await logAuth(c, key, 200, form, resp);
      return c.json(resp, 200);
    }

    if (grant === "refresh_token") {
      if (auth.refresh?.failStatus) {
        const status = auth.refresh.failStatus;
        const resp = { error: "invalid_grant", error_description: "refresh failed" };
        await logAuth(c, key, status, form, resp);
        return c.json(resp, status as any);
      }
      const oldRefresh = form.refresh_token ?? "";
      const existing = await getTokenByRefresh(key, oldRefresh);
      if (!existing) {
        const resp = { error: "invalid_grant", error_description: "unknown refresh token" };
        await logAuth(c, key, 400, form, resp);
        return c.json(resp, 400);
      }
      const accessToken = mintAccessToken({ accountId, omitAccountClaim: auth.omitAccountClaim });
      let refreshToken = oldRefresh;
      let rotatedFrom: string | null = null;
      if (auth.refresh?.rotate) {
        refreshToken = minter.next("refresh");
        rotatedFrom = oldRefresh;
      }
      await insertToken({
        sessionId: key,
        accessToken,
        refreshToken,
        accountId,
        kind: "refresh",
        rotatedFrom,
      });
      await updateCursor(key, { id_seed: minter.seed });
      const resp = { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn };
      await logAuth(c, key, 200, form, resp);
      return c.json(resp, 200);
    }

    const resp = { error: "unsupported_grant_type" };
    await logAuth(c, key, 400, form, resp);
    return c.json(resp, 400);
  });
}
