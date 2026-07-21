/**
 * D1 store (PLAN.md §3). All state is scoped by session id. Timestamps are
 * operational metadata only — never part of the determinism contract (§9).
 */
import { db } from "flingit";

const SESSION_DEFAULT_TTL_SECONDS = 24 * 60 * 60;

function nowIso(): string {
  return new Date().toISOString();
}
function isoInSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}
function hex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Sessions ------------------------------------------------------------

export interface SessionRow {
  id: string;
  name: string | null;
  scenario_json: string | null;
  id_seed: number;
  next_rule_index: number;
  fault_attempts_json: string;
  created_at: string;
  expires_at: string;
}

export async function createSession(opts: {
  name?: string | null;
  scenarioJson?: string | null;
  ttlSeconds?: number;
}): Promise<SessionRow> {
  const id = `sess_${hex(12)}`;
  const created = nowIso();
  const expires = isoInSeconds(opts.ttlSeconds ?? SESSION_DEFAULT_TTL_SECONDS);
  await db
    .prepare(
      `INSERT INTO mock_sessions (id, name, scenario_json, id_seed, next_rule_index, fault_attempts_json, created_at, expires_at)
       VALUES (?, ?, ?, 0, 0, '{}', ?, ?)`,
    )
    .bind(id, opts.name ?? null, opts.scenarioJson ?? null, created, expires)
    .run();
  return (await getSession(id))!;
}

export async function getSession(id: string): Promise<SessionRow | null> {
  return (await db.prepare("SELECT * FROM mock_sessions WHERE id = ?").bind(id).first<SessionRow>()) ?? null;
}

export async function listSessions(): Promise<SessionRow[]> {
  const res = await db
    .prepare("SELECT * FROM mock_sessions ORDER BY created_at DESC, rowid DESC")
    .all<SessionRow>();
  return res.results ?? [];
}

export async function deleteSession(id: string): Promise<void> {
  // Delete children explicitly so cleanup works regardless of FK-cascade support.
  await db
    .prepare(
      "DELETE FROM request_events WHERE request_id IN (SELECT id FROM request_log WHERE session_id = ?)",
    )
    .bind(id)
    .run();
  for (const t of ["request_log", "tokens", "device_auths", "mock_sessions"]) {
    const col = t === "mock_sessions" ? "id" : "session_id";
    await db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).bind(id).run();
  }
}

export async function setScenario(id: string, scenarioJson: string | null): Promise<void> {
  await db.prepare("UPDATE mock_sessions SET scenario_json = ? WHERE id = ?").bind(scenarioJson, id).run();
}

export async function resetSession(id: string, keepScenario: boolean): Promise<void> {
  await db
    .prepare(
      "DELETE FROM request_events WHERE request_id IN (SELECT id FROM request_log WHERE session_id = ?)",
    )
    .bind(id)
    .run();
  await db.prepare("DELETE FROM request_log WHERE session_id = ?").bind(id).run();
  await db.prepare("DELETE FROM tokens WHERE session_id = ?").bind(id).run();
  await db.prepare("DELETE FROM device_auths WHERE session_id = ?").bind(id).run();
  const scenarioClause = keepScenario ? "" : ", scenario_json = NULL";
  await db
    .prepare(
      `UPDATE mock_sessions SET id_seed = 0, next_rule_index = 0, fault_attempts_json = '{}'${scenarioClause} WHERE id = ?`,
    )
    .bind(id)
    .run();
}

export async function updateCursor(
  id: string,
  fields: { id_seed?: number; next_rule_index?: number; fault_attempts_json?: string },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.id_seed !== undefined) {
    sets.push("id_seed = ?");
    vals.push(fields.id_seed);
  }
  if (fields.next_rule_index !== undefined) {
    sets.push("next_rule_index = ?");
    vals.push(fields.next_rule_index);
  }
  if (fields.fault_attempts_json !== undefined) {
    sets.push("fault_attempts_json = ?");
    vals.push(fields.fault_attempts_json);
  }
  if (sets.length === 0) return;
  vals.push(id);
  await db.prepare(`UPDATE mock_sessions SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
}

export async function deleteExpiredSessions(): Promise<{ deleted: number }> {
  const now = nowIso();
  const expired = await db
    .prepare("SELECT id FROM mock_sessions WHERE expires_at < ?")
    .bind(now)
    .all<{ id: string }>();
  const ids = (expired.results ?? []).map((r) => r.id);
  for (const id of ids) await deleteSession(id);
  return { deleted: ids.length };
}

// --- Device auths --------------------------------------------------------

export interface DeviceAuthRow {
  id: number;
  session_id: string;
  device_auth_id: string;
  user_code: string;
  status: string;
  poll_count: number;
  authorization_code: string | null;
  code_verifier: string | null;
  created_at: string;
  expires_at: string;
}

export async function createDeviceAuth(opts: {
  sessionId: string;
  deviceAuthId: string;
  userCode: string;
  authorizationCode: string;
  codeVerifier: string;
  ttlSeconds: number;
}): Promise<DeviceAuthRow> {
  await db
    .prepare(
      `INSERT INTO device_auths (session_id, device_auth_id, user_code, status, poll_count, authorization_code, code_verifier, created_at, expires_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
    )
    .bind(
      opts.sessionId,
      opts.deviceAuthId,
      opts.userCode,
      opts.authorizationCode,
      opts.codeVerifier,
      nowIso(),
      isoInSeconds(opts.ttlSeconds),
    )
    .run();
  return (await getDeviceAuthById(opts.sessionId, opts.deviceAuthId))!;
}

export async function getDeviceAuthById(
  sessionId: string,
  deviceAuthId: string,
): Promise<DeviceAuthRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM device_auths WHERE session_id = ? AND device_auth_id = ?")
      .bind(sessionId, deviceAuthId)
      .first<DeviceAuthRow>()) ?? null
  );
}

export async function getDeviceAuthByUserCode(
  sessionId: string,
  userCode: string,
): Promise<DeviceAuthRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM device_auths WHERE session_id = ? AND user_code = ?")
      .bind(sessionId, userCode)
      .first<DeviceAuthRow>()) ?? null
  );
}

export async function getDeviceAuthByAuthCode(
  sessionId: string,
  authorizationCode: string,
): Promise<DeviceAuthRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM device_auths WHERE session_id = ? AND authorization_code = ?")
      .bind(sessionId, authorizationCode)
      .first<DeviceAuthRow>()) ?? null
  );
}

export async function expireDeviceAuths(sessionId: string): Promise<number> {
  const pending = await db
    .prepare("SELECT id FROM device_auths WHERE session_id = ? AND status = 'pending'")
    .bind(sessionId)
    .all<{ id: number }>();
  const ids = (pending.results ?? []).map((r) => r.id);
  for (const id of ids) await setDeviceStatus(id, "expired");
  return ids.length;
}

export async function bumpDevicePoll(id: number): Promise<number> {
  await db.prepare("UPDATE device_auths SET poll_count = poll_count + 1 WHERE id = ?").bind(id).run();
  const row = await db.prepare("SELECT poll_count FROM device_auths WHERE id = ?").bind(id).first<{ poll_count: number }>();
  return row?.poll_count ?? 0;
}

export async function setDeviceStatus(id: number, status: string): Promise<void> {
  await db.prepare("UPDATE device_auths SET status = ? WHERE id = ?").bind(status, id).run();
}

export async function listDeviceAuths(sessionId: string): Promise<DeviceAuthRow[]> {
  const res = await db
    .prepare("SELECT * FROM device_auths WHERE session_id = ? ORDER BY id DESC")
    .bind(sessionId)
    .all<DeviceAuthRow>();
  return res.results ?? [];
}

// --- Tokens --------------------------------------------------------------

export interface TokenRow {
  id: number;
  session_id: string;
  access_token: string;
  refresh_token: string;
  account_id: string;
  kind: string;
  rotated_from: string | null;
  created_at: string;
}

export async function insertToken(opts: {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  kind: "issue" | "refresh";
  rotatedFrom?: string | null;
}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tokens (session_id, access_token, refresh_token, account_id, kind, rotated_from, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      opts.sessionId,
      opts.accessToken,
      opts.refreshToken,
      opts.accountId,
      opts.kind,
      opts.rotatedFrom ?? null,
      nowIso(),
    )
    .run();
}

export async function getTokenByRefresh(sessionId: string, refreshToken: string): Promise<TokenRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM tokens WHERE session_id = ? AND refresh_token = ? ORDER BY id DESC")
      .bind(sessionId, refreshToken)
      .first<TokenRow>()) ?? null
  );
}

export async function listTokens(sessionId: string): Promise<TokenRow[]> {
  const res = await db
    .prepare("SELECT * FROM tokens WHERE session_id = ? ORDER BY id DESC")
    .bind(sessionId)
    .all<TokenRow>();
  return res.results ?? [];
}

// --- Request log ---------------------------------------------------------

export interface RequestLogRow {
  id: number;
  session_id: string;
  surface: string;
  method: string;
  path: string;
  status: number | null;
  request_headers_json: string | null;
  request_body_json: string | null;
  matched_rule_index: number | null;
  stop_reason: string | null;
  aborted: number;
  finalized: number;
  created_at: string;
}

export async function insertRequestLog(opts: {
  sessionId: string;
  surface: string;
  method: string;
  path: string;
  status?: number | null;
  headers?: unknown;
  body?: string | null;
  matchedRuleIndex?: number | null;
}): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO request_log (session_id, surface, method, path, status, request_headers_json, request_body_json, matched_rule_index, stop_reason, aborted, finalized, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, ?)`,
    )
    .bind(
      opts.sessionId,
      opts.surface,
      opts.method,
      opts.path,
      opts.status ?? null,
      opts.headers !== undefined ? JSON.stringify(opts.headers) : null,
      opts.body ?? null,
      opts.matchedRuleIndex ?? null,
      nowIso(),
    )
    .run();
  // D1 returns meta.last_row_id; fall back to a query if unavailable.
  const lastId = (res as any)?.meta?.last_row_id;
  if (typeof lastId === "number") return lastId;
  const row = await db
    .prepare("SELECT id FROM request_log WHERE session_id = ? ORDER BY id DESC LIMIT 1")
    .bind(opts.sessionId)
    .first<{ id: number }>();
  return row!.id;
}

export async function countModelRequests(sessionId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) as n FROM request_log WHERE session_id = ? AND surface = 'model'")
    .bind(sessionId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function appendRequestEvent(requestId: number, seq: number, data: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO request_events (request_id, seq, event_json) VALUES (?, ?, ?)")
    .bind(requestId, seq, JSON.stringify(data))
    .run();
}

export async function finalizeRequest(
  id: number,
  fields: { status?: number | null; stopReason?: string | null; aborted?: boolean },
): Promise<void> {
  await db
    .prepare(
      "UPDATE request_log SET status = COALESCE(?, status), stop_reason = COALESCE(?, stop_reason), aborted = ?, finalized = 1 WHERE id = ?",
    )
    .bind(fields.status ?? null, fields.stopReason ?? null, fields.aborted ? 1 : 0, id)
    .run();
}

export async function listRequests(sessionId: string): Promise<(RequestLogRow & { events: unknown[] })[]> {
  const res = await db
    .prepare("SELECT * FROM request_log WHERE session_id = ? ORDER BY id DESC")
    .bind(sessionId)
    .all<RequestLogRow>();
  const rows = res.results ?? [];
  const out: (RequestLogRow & { events: unknown[] })[] = [];
  for (const row of rows) {
    const evRes = await db
      .prepare("SELECT event_json FROM request_events WHERE request_id = ? ORDER BY seq ASC")
      .bind(row.id)
      .all<{ event_json: string }>();
    const events = (evRes.results ?? []).map((e) => JSON.parse(e.event_json));
    out.push({ ...row, events });
  }
  return out;
}
