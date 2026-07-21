import { useEffect, useState } from "react";
import { api, type SessionSummary } from "./api";
import { SessionDetail } from "./SessionDetail";
import { Docs } from "./Docs";

type Route = { kind: "list" } | { kind: "session"; key: string } | { kind: "docs" };

function readRoute(): Route {
  const h = window.location.hash;
  if (h === "#/docs") return { kind: "docs" };
  const m = h.match(/^#\/sessions\/(sess_[0-9a-f]+)$/);
  if (m) return { kind: "session", key: m[1] };
  return { kind: "list" };
}

function App() {
  const [route, setRoute] = useState<Route>(readRoute());

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (hash: string) => {
    window.location.hash = hash;
  };
  const navSession = (k: string | null) => go(k ? `#/sessions/${k}` : "");

  const navLink = (label: string, target: string, active: boolean) => (
    <button
      onClick={() => go(target)}
      className={`text-sm ${active ? "text-blue-700 font-semibold" : "text-slate-600 hover:text-slate-900"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="min-h-screen text-slate-800">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <button
              onClick={() => go("")}
              className="text-lg font-semibold tracking-tight hover:text-blue-700"
            >
              fake-openai
            </button>
            <nav className="flex items-center gap-4">
              {navLink("Sessions", "", route.kind !== "docs")}
              {navLink("Docs", "#/docs", route.kind === "docs")}
            </nav>
          </div>
          <span className="hidden md:inline text-sm text-slate-500">
            scriptable fake OpenAI — OAuth + Codex Responses for E2E tests
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">
        {route.kind === "docs" ? (
          <Docs />
        ) : route.kind === "session" ? (
          <SessionDetail sessionKey={route.key} onBack={() => navSession(null)} />
        ) : (
          <SessionList onSelect={navSession} />
        )}
      </main>
      <a
        href="https://flingit.io"
        target="_blank"
        rel="noopener noreferrer"
        className="fixed bottom-4 left-4 flex items-center gap-1.5 px-2.5 py-1.5 bg-white border border-gray-200 rounded-full shadow-sm text-xs text-gray-500 hover:text-gray-700 hover:border-gray-300 transition-colors"
      >
        <img src="/fling.svg" alt="Fling" className="w-4 h-4" />
        Made with Fling
      </a>
    </div>
  );
}

function SessionList({ onSelect }: { onSelect: (key: string) => void }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .listSessions()
        .then((s) => !cancelled && setSessions(s))
        .catch((e) => !cancelled && setError(String(e)));
    load();
    const t = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Sessions</h2>
        <span className="text-xs text-slate-500">auto-refreshes every 3s</span>
      </div>
      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>
      )}
      {sessions === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : sessions.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-6 text-sm text-slate-500">
          No sessions yet. Create one with{" "}
          <code className="font-mono bg-slate-100 px-1 rounded">POST /api/__mock__/sessions</code>.
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">Session</th>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Scenario</th>
                <th className="px-3 py-2 font-medium">Cursor</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={s.sessionKey}
                  onClick={() => onSelect(s.sessionKey)}
                  className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                >
                  <td className="px-3 py-1.5 font-mono text-xs text-blue-700">{s.sessionKey}</td>
                  <td className="px-3 py-1.5">{s.name ?? "—"}</td>
                  <td className="px-3 py-1.5">
                    {s.hasScenario ? (
                      <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded">loaded</span>
                    ) : (
                      <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">none</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs">rule {s.nextRuleIndex}</td>
                  <td className="px-3 py-1.5 text-xs text-slate-500">
                    {new Date(s.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default App;
