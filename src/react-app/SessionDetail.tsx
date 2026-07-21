import { useEffect, useState, type ReactNode } from "react";
import {
  api,
  decodeJwtPayload,
  type RequestEntry,
  type SessionDetail as SessionDetailT,
  type SessionState,
} from "./api";

type Tab = "requests" | "auth" | "rules" | "state";

export function SessionDetail({ sessionKey, onBack }: { sessionKey: string; onBack: () => void }) {
  const [detail, setDetail] = useState<SessionDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("requests");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .getSession(sessionKey)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [sessionKey, tick]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, []);

  if (error)
    return (
      <div className="space-y-3">
        <BackButton onBack={onBack} />
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>
      </div>
    );
  if (!detail)
    return (
      <div className="space-y-3">
        <BackButton onBack={onBack} />
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    );

  return (
    <div className="space-y-5">
      <BackButton onBack={onBack} />

      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">{detail.name ?? "(unnamed session)"}</h2>
          <span className="font-mono text-xs text-slate-500">{detail.sessionKey}</span>
        </div>
        <div className="grid grid-cols-1 gap-1 text-xs">
          <UrlRow label="Inference baseUrl" value={detail.inferenceBaseUrl} />
          <UrlRow label="OAuth baseUrl" value={detail.oauthBaseUrl} />
        </div>
      </div>

      <div className="border-b border-slate-200 flex gap-1 text-sm">
        {(["requests", "auth", "rules", "state"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 -mb-px border-b-2 capitalize ${
              tab === t
                ? "border-blue-600 text-blue-700 font-semibold"
                : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "requests" && <RequestsTab sessionKey={sessionKey} tick={tick} />}
      {tab === "auth" && <AuthTab sessionKey={sessionKey} tick={tick} />}
      {tab === "rules" && <RulesTab scenario={detail.scenario} nextRuleIndex={detail.nextRuleIndex} />}
      {tab === "state" && <StateTab sessionKey={sessionKey} tick={tick} />}
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button onClick={onBack} className="text-sm text-blue-700 hover:underline">
      ← All sessions
    </button>
  );
}

function UrlRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 items-baseline">
      <span className="text-slate-500 w-40 shrink-0">{label}</span>
      <code className="font-mono text-slate-700 break-all">{value}</code>
    </div>
  );
}

// ----- Requests tab (the debugging log) ----------------------------

function RequestsTab({ sessionKey, tick }: { sessionKey: string; tick: number }) {
  const [rows, setRows] = useState<RequestEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getRequests(sessionKey)
      .then((r) => !cancelled && setRows(r))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [sessionKey, tick]);

  if (error) return <div className="text-sm text-red-700">{error}</div>;
  if (rows === null) return <p className="text-sm text-slate-500">Loading…</p>;
  if (rows.length === 0) return <p className="text-sm text-slate-500">No requests yet.</p>;

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-slate-600">
          <tr>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Surface</th>
            <th className="px-3 py-2 font-medium">Path</th>
            <th className="px-3 py-2 font-medium">Rule</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Stop</th>
            <th className="px-3 py-2 font-medium">Events</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <RequestRow
              key={r.id}
              row={r}
              open={open === r.id}
              onToggle={() => setOpen((c) => (c === r.id ? null : r.id))}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RequestRow({ row, open, onToggle }: { row: RequestEntry; open: boolean; onToggle: () => void }) {
  const statusColor =
    row.status == null
      ? "text-slate-500"
      : row.status >= 500
        ? "text-red-700"
        : row.status >= 400
          ? "text-amber-700"
          : "text-green-700";
  const surfaceColor =
    row.surface === "model"
      ? "bg-indigo-100 text-indigo-700"
      : row.surface === "auth"
        ? "bg-teal-100 text-teal-700"
        : "bg-slate-100 text-slate-600";
  return (
    <>
      <tr onClick={onToggle} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer">
        <td className="px-3 py-1.5 text-xs text-slate-500">{new Date(row.createdAt).toLocaleTimeString()}</td>
        <td className="px-3 py-1.5">
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${surfaceColor}`}>{row.surface}</span>
        </td>
        <td className="px-3 py-1.5 font-mono text-xs truncate max-w-[280px]">
          {row.path.replace(/^\/oai\/[^/]+/, "…")}
        </td>
        <td className="px-3 py-1.5 text-xs font-mono">{row.matchedRuleIndex ?? "—"}</td>
        <td className={`px-3 py-1.5 text-xs font-semibold ${statusColor}`}>{row.status ?? "—"}</td>
        <td className="px-3 py-1.5 text-xs">
          {row.stopReason ? (
            <span className={row.aborted ? "text-amber-700" : "text-slate-600"}>{row.stopReason}</span>
          ) : (
            "—"
          )}
        </td>
        <td className="px-3 py-1.5 text-xs text-slate-500">{row.events.length}</td>
      </tr>
      {open && (
        <tr className="border-t border-slate-100 bg-slate-50">
          <td colSpan={7} className="px-3 py-3 space-y-3">
            {row.headers && (
              <Detail title="Request headers">
                <Pre value={row.headers} />
              </Detail>
            )}
            {row.body != null && (
              <Detail title="Request body (decompressed)">
                <Pre value={row.body} />
              </Detail>
            )}
            <Detail title={`Emitted events (${row.events.length})`}>
              <div className="space-y-1">
                {row.events.map((e, i) => (
                  <pre
                    key={i}
                    className="bg-white border border-slate-200 rounded px-2 py-1 text-[11px] overflow-x-auto"
                  >
                    {JSON.stringify(e)}
                  </pre>
                ))}
              </div>
            </Detail>
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-slate-500 uppercase tracking-wide text-[10px] mb-1">{title}</div>
      {children}
    </div>
  );
}

function Pre({ value }: { value: unknown }) {
  return (
    <pre className="bg-white border border-slate-200 rounded p-2 text-[11px] overflow-auto max-h-72">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

// ----- Rules tab (the loaded scenario, readable) -------------------

function fmtPred(p: any): string {
  if (p == null) return "";
  return typeof p === "string" ? `contains "${p}"` : `~ /${p.regex}/`;
}

function matcherSummary(m: any): string {
  if (!m || typeof m !== "object") return "(none)";
  if (m.default) return "default — always matches";
  const parts: string[] = [];
  if (m.userMessage !== undefined) parts.push(`userMessage ${fmtPred(m.userMessage)}`);
  if (m.toolResultContains !== undefined) parts.push(`toolResult ${fmtPred(m.toolResultContains)}`);
  if (m.turnIndex !== undefined) parts.push(`turnIndex == ${m.turnIndex}`);
  if (m.session !== undefined) parts.push(`session == ${m.session}`);
  return parts.length ? parts.join("  AND  ") : "(empty — matches nothing)";
}

function truncate(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function stepSummary(s: any): string {
  switch (s?.type) {
    case "reasoning":
      return `reasoning: "${truncate(String(s.text ?? ""))}"`;
    case "text":
      return `${s.refusal ? "refusal" : "text"}: "${truncate(String(s.content ?? ""))}"`;
    case "toolCall":
      return `toolCall: ${s.name}(${truncate(JSON.stringify(s.arguments ?? {}))})`;
    case "usage":
      return "usage";
    case "stop":
      return `stop: ${s.status ?? "completed"}`;
    case "delay":
      return `delay: ${s.ms}ms`;
    default:
      return JSON.stringify(s);
  }
}

function RulesTab({ scenario, nextRuleIndex }: { scenario: any; nextRuleIndex: number }) {
  if (scenario == null) return <p className="text-sm text-slate-500">No scenario loaded.</p>;
  const rules: any[] = scenario?.model?.rules ?? [];
  const auth = scenario?.auth;

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">
        Rules are defined in the scenario loaded via{" "}
        <code className="font-mono bg-slate-100 px-1 rounded">POST /api/__mock__/sessions/:key/scenario</code>{" "}
        (or inline at session creation). Each incoming model request is matched to the first{" "}
        <em>unconsumed</em> rule (cursor at <span className="font-mono">rule {nextRuleIndex}</span>).
      </p>

      {auth && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Auth config</h3>
          <Pre value={auth} />
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold mb-2">Model rules ({rules.length})</h3>
        {rules.length === 0 ? (
          <p className="text-sm text-slate-500">No model rules.</p>
        ) : (
          <div className="space-y-2">
            {rules.map((rule, i) => {
              const consumed = i < nextRuleIndex;
              const isNext = i === nextRuleIndex;
              return (
                <div
                  key={i}
                  className={`border rounded-lg p-3 ${
                    isNext ? "border-blue-300 bg-blue-50" : consumed ? "border-slate-200 bg-slate-50 opacity-70" : "border-slate-200 bg-white"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] font-mono bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded">
                      rule {i}
                    </span>
                    {isNext && <span className="text-[10px] text-blue-700 font-semibold">NEXT</span>}
                    {consumed && <span className="text-[10px] text-slate-500">consumed</span>}
                    {rule.fault && (
                      <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                        fault: {Object.keys(rule.fault).join(", ")}
                      </span>
                    )}
                  </div>
                  <div className="text-xs mb-2">
                    <span className="text-slate-500">match: </span>
                    <span className="font-mono text-slate-800">{matcherSummary(rule.match)}</span>
                  </div>
                  <ol className="text-xs space-y-0.5">
                    {(rule.steps ?? []).map((s: any, j: number) => (
                      <li key={j} className="font-mono text-slate-700">
                        <span className="text-slate-400">{j + 1}.</span> {stepSummary(s)}
                      </li>
                    ))}
                    {(!rule.steps || rule.steps.length === 0) && !rule.fault && (
                      <li className="text-slate-400 italic">no steps</li>
                    )}
                  </ol>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700">Raw scenario JSON</summary>
        <div className="mt-2">
          <Pre value={scenario} />
        </div>
      </details>
    </div>
  );
}

// ----- Auth tab (runtime device codes + tokens) -------------------

function AuthTab({ sessionKey, tick }: { sessionKey: string; tick: number }) {
  const [state, setState] = useState<SessionState | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getState(sessionKey).then((s) => !cancelled && setState(s));
    return () => {
      cancelled = true;
    };
  }, [sessionKey, tick]);
  if (!state) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold mb-2">Device authorizations</h3>
        {state.deviceAuths.length === 0 ? (
          <p className="text-sm text-slate-500">None.</p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-medium">device_auth_id</th>
                  <th className="px-3 py-2 font-medium">user_code</th>
                  <th className="px-3 py-2 font-medium">status</th>
                  <th className="px-3 py-2 font-medium">polls</th>
                </tr>
              </thead>
              <tbody>
                {state.deviceAuths.map((d) => (
                  <tr key={d.deviceAuthId} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 font-mono text-xs">{d.deviceAuthId}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{d.userCode}</td>
                    <td className="px-3 py-1.5 text-xs">
                      <span
                        className={
                          d.status === "approved"
                            ? "text-green-700"
                            : d.status === "expired"
                              ? "text-red-700"
                              : "text-slate-600"
                        }
                      >
                        {d.status}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-xs">{d.pollCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2">Issued tokens</h3>
        {state.tokens.length === 0 ? (
          <p className="text-sm text-slate-500">None.</p>
        ) : (
          <div className="space-y-2">
            {state.tokens.map((t, i) => (
              <div key={i} className="bg-white border border-slate-200 rounded-lg p-3 text-xs space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">{t.kind}</span>
                  <span className="font-mono text-slate-500">account {t.accountId}</span>
                  {t.rotatedFrom && <span className="text-amber-700">rotated from {t.rotatedFrom}</span>}
                </div>
                <div className="font-mono break-all text-slate-600">access: {t.accessToken.slice(0, 40)}…</div>
                <div className="font-mono break-all text-slate-600">refresh: {t.refreshToken}</div>
                <Detail title="Decoded JWT payload">
                  <Pre value={decodeJwtPayload(t.accessToken)} />
                </Detail>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ----- State tab ---------------------------------------------------

function StateTab({ sessionKey, tick }: { sessionKey: string; tick: number }) {
  const [state, setState] = useState<SessionState | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getState(sessionKey).then((s) => !cancelled && setState(s));
    return () => {
      cancelled = true;
    };
  }, [sessionKey, tick]);
  if (!state) return <p className="text-sm text-slate-500">Loading…</p>;
  return (
    <div className="grid grid-cols-3 gap-3">
      <Stat label="Next rule index" value={state.nextRuleIndex} />
      <Stat label="ID seed" value={state.idSeed} />
      <Stat label="Fault attempts" value={Object.keys(state.faultAttempts).length} />
      <div className="col-span-3">
        <Detail title="Fault attempt counters">
          <Pre value={state.faultAttempts} />
        </Detail>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-semibold text-slate-800">{value}</div>
    </div>
  );
}
