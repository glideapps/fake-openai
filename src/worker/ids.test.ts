import { describe, it, expect } from "vitest";
import { IdMinter } from "./ids.js";

describe("IdMinter", () => {
  it("mints ids of the form <kind>_<n> starting from the seed", () => {
    const m = new IdMinter(0);
    expect(m.next("resp")).toBe("resp_1");
    expect(m.next("rs")).toBe("rs_2");
    expect(m.next("fc")).toBe("fc_3");
  });

  it("uses a single monotonic counter across kinds so ids never collide", () => {
    const m = new IdMinter(0);
    const ids = [m.next("resp"), m.next("resp"), m.next("msg")];
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(["resp_1", "resp_2", "msg_3"]);
  });

  it("is deterministic: same start seed + same calls => byte-identical ids", () => {
    const a = new IdMinter(5);
    const b = new IdMinter(5);
    const seq = (m: IdMinter) => [m.next("resp"), m.next("rs"), m.next("call")];
    expect(seq(a)).toEqual(seq(b));
  });

  it("resumes from a persisted seed value", () => {
    const first = new IdMinter(0);
    first.next("resp");
    first.next("rs");
    const resumed = new IdMinter(first.seed);
    expect(resumed.next("fc")).toBe("fc_3");
  });

  it("exposes the current seed for persistence", () => {
    const m = new IdMinter(0);
    expect(m.seed).toBe(0);
    m.next("resp");
    expect(m.seed).toBe(1);
    m.next("rs");
    expect(m.seed).toBe(2);
  });
});
