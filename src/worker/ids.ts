/**
 * Deterministic id minting (PLAN.md §9).
 *
 * Every id the mock emits that is not provided by the scenario is minted here
 * from a single monotonic per-session counter. No `Math.random`, no UUID, no
 * `Date.now` — so a given scenario + request sequence produces byte-identical
 * ids on every rerun. The counter (`seed`) is persisted per session and reset
 * by the control API's `/reset` endpoint.
 */
export class IdMinter {
  private counter: number;

  constructor(startSeed: number) {
    this.counter = startSeed;
  }

  /** Mint the next id of the given kind, e.g. `next("resp") => "resp_1"`. */
  next(kind: string): string {
    this.counter += 1;
    return `${kind}_${this.counter}`;
  }

  /** Current counter value, for persistence back into `mock_sessions.id_seed`. */
  get seed(): number {
    return this.counter;
  }
}
