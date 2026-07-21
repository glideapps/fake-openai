/**
 * SSE framing (REQS §4.3 / §10).
 *
 * pi-ai's parser splits the stream on "\n\n", reads `data:` lines, ignores
 * `data: [DONE]`, and `JSON.parse`s each event. We own the exact bytes so reruns
 * are byte-identical (no helper library imposing its own framing). Object key
 * order is preserved by `JSON.stringify`, so events must be constructed with
 * keys in the intended order.
 */

export interface EmitEvent {
  /** The event object; serialized verbatim into the `data:` line. */
  data: unknown;
  /** Optional pre-emit delay in ms (the only permitted wall-clock dependence). */
  delayBeforeMs?: number;
}

/** Frame one event as a single SSE `data: <json>\n\n` block. */
export function frameEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Render events to a single string (delays ignored) — used by golden tests. */
export function renderEvents(events: EmitEvent[]): string {
  return events.map((e) => frameEvent(e.data)).join("");
}
