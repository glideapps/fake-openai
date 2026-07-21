/**
 * SSE ReadableStream builder (PLAN.md §4.3). Emits pre-built events with optional
 * per-event delays, persists each event to the request log as it is sent (so the
 * abort/hang/truncate cases still leave a complete partial log), and detects
 * client disconnect via both the request AbortSignal and the stream `cancel()`.
 */
import { frameEvent, type EmitEvent } from "./sse.js";
import { appendRequestEvent } from "./store.js";

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function waitForAbort(signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return; // no signal => hold indefinitely (only used with a signal in tests)
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export interface StreamOptions {
  signal?: AbortSignal | null;
  /** After emitting all events, hold the stream open until the client disconnects (hang fault). */
  holdOpen?: boolean;
  logId: number;
  /** Called once when the stream ends (naturally or via abort). */
  onFinalize: (aborted: boolean) => Promise<void>;
}

export function buildEventStream(events: EmitEvent[], opts: StreamOptions): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let aborted = false;
  let finalized = false;

  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    await opts.onFinalize(aborted);
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = 0;
      try {
        for (const ev of events) {
          if (opts.signal?.aborted) {
            aborted = true;
            break;
          }
          if (ev.delayBeforeMs) await sleep(ev.delayBeforeMs, opts.signal);
          if (opts.signal?.aborted) {
            aborted = true;
            break;
          }
          controller.enqueue(enc.encode(frameEvent(ev.data)));
          await appendRequestEvent(opts.logId, seq++, ev.data);
        }
        if (opts.holdOpen && !aborted) {
          await waitForAbort(opts.signal);
          aborted = true;
        }
      } catch {
        aborted = true;
      } finally {
        await finalize();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    async cancel() {
      aborted = true;
      await finalize();
    },
  });
}
