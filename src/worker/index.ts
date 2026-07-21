/**
 * Fake OpenAI — a Fling app that impersonates OpenAI's OAuth device-code/token
 * endpoints and the Codex Responses streaming backend, so pi-orb E2E can run
 * offline and deterministically. See PLAN.md.
 */
import { cron, db, migrate } from "flingit";
import { registerControlRoutes } from "./routes-control.js";
import { registerOAuthRoutes } from "./routes-oauth.js";
import { registerModelRoutes } from "./routes-model.js";
import { deleteExpiredSessions } from "./store.js";

migrate("001_init", async () => {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS mock_sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        scenario_json TEXT,
        id_seed INTEGER NOT NULL DEFAULT 0,
        next_rule_index INTEGER NOT NULL DEFAULT 0,
        fault_attempts_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS device_auths (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES mock_sessions(id) ON DELETE CASCADE,
        device_auth_id TEXT NOT NULL,
        user_code TEXT NOT NULL,
        status TEXT NOT NULL,
        poll_count INTEGER NOT NULL DEFAULT 0,
        authorization_code TEXT,
        code_verifier TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES mock_sessions(id) ON DELETE CASCADE,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        rotated_from TEXT,
        created_at TEXT NOT NULL
      )`,
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS request_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES mock_sessions(id) ON DELETE CASCADE,
        surface TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status INTEGER,
        request_headers_json TEXT,
        request_body_json TEXT,
        matched_rule_index INTEGER,
        stop_reason TEXT,
        aborted INTEGER NOT NULL DEFAULT 0,
        finalized INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS request_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL REFERENCES request_log(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL
      )`,
    )
    .run();

  for (const stmt of [
    "CREATE INDEX IF NOT EXISTS idx_sessions_created ON mock_sessions(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON mock_sessions(expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_device_session ON device_auths(session_id)",
    "CREATE INDEX IF NOT EXISTS idx_device_auth_id ON device_auths(device_auth_id)",
    "CREATE INDEX IF NOT EXISTS idx_device_user_code ON device_auths(user_code)",
    "CREATE INDEX IF NOT EXISTS idx_tokens_session ON tokens(session_id)",
    "CREATE INDEX IF NOT EXISTS idx_tokens_access ON tokens(access_token)",
    "CREATE INDEX IF NOT EXISTS idx_tokens_refresh ON tokens(refresh_token)",
    "CREATE INDEX IF NOT EXISTS idx_log_session ON request_log(session_id, id)",
    "CREATE INDEX IF NOT EXISTS idx_events_request ON request_events(request_id, seq)",
  ]) {
    await db.prepare(stmt).run();
  }
});

registerControlRoutes();
registerOAuthRoutes();
registerModelRoutes();

cron("hourly-cleanup", "0 * * * *", async () => {
  return await deleteExpiredSessions();
});
