// Read-only client for the fake-openai control API (/api/__mock__).

export interface SessionSummary {
  sessionKey: string;
  name: string | null;
  hasScenario: boolean;
  nextRuleIndex: number;
  createdAt: string;
  expiresAt: string;
}

export interface SessionDetail {
  sessionKey: string;
  name: string | null;
  scenario: unknown;
  nextRuleIndex: number;
  idSeed: number;
  inferenceBaseUrl: string;
  oauthBaseUrl: string;
  createdAt: string;
  expiresAt: string;
}

export interface RequestEntry {
  id: number;
  surface: "auth" | "model" | "control";
  method: string;
  path: string;
  status: number | null;
  headers: Record<string, string> | null;
  body: any;
  matchedRuleIndex: number | null;
  stopReason: string | null;
  aborted: boolean;
  finalized: boolean;
  events: any[];
  createdAt: string;
}

export interface SessionState {
  nextRuleIndex: number;
  idSeed: number;
  faultAttempts: Record<string, number>;
  tokens: {
    accessToken: string;
    refreshToken: string;
    accountId: string;
    kind: string;
    rotatedFrom: string | null;
  }[];
  deviceAuths: {
    deviceAuthId: string;
    userCode: string;
    status: string;
    pollCount: number;
  }[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const api = {
  listSessions: () => get<SessionSummary[]>("/api/__mock__/sessions"),
  getSession: (key: string) => get<SessionDetail>(`/api/__mock__/sessions/${key}`),
  getRequests: (key: string) => get<RequestEntry[]>(`/api/__mock__/sessions/${key}/requests`),
  getState: (key: string) => get<SessionState>(`/api/__mock__/sessions/${key}/state`),
};

/** Decode a JWT payload for display (best-effort; no verification). */
export function decodeJwtPayload(token: string): unknown {
  try {
    const part = token.split(".")[1];
    return JSON.parse(atob(part));
  } catch {
    return null;
  }
}
