import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { decodeRequestBody } from "./body.js";

function zstd(s: string): Uint8Array {
  // Same shape pi-ai uses: zlib.zstdCompressSync at level 3.
  const buf = zlib.zstdCompressSync(Buffer.from(s, "utf8"), {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
  });
  return new Uint8Array(buf);
}

const SAMPLE = JSON.stringify({
  model: "gpt-5.4",
  input: [{ role: "user", content: [{ type: "input_text", text: "run the tests" }] }],
});

describe("decodeRequestBody", () => {
  it("parses an uncompressed JSON body", async () => {
    const bytes = new TextEncoder().encode(SAMPLE);
    const result = await decodeRequestBody(bytes, null);
    expect(result.json.model).toBe("gpt-5.4");
    expect(result.text).toBe(SAMPLE);
    expect(result.wasCompressed).toBe(false);
  });

  it("decompresses a zstd body when content-encoding: zstd is set", async () => {
    const result = await decodeRequestBody(zstd(SAMPLE), "zstd");
    expect(result.text).toBe(SAMPLE);
    expect(result.json.model).toBe("gpt-5.4");
    expect(result.wasCompressed).toBe(true);
  });

  it("treats content-encoding case-insensitively and trims it", async () => {
    const result = await decodeRequestBody(zstd(SAMPLE), "  ZSTD ");
    expect(result.json.model).toBe("gpt-5.4");
    expect(result.wasCompressed).toBe(true);
  });

  it("round-trips a large body (tool output) through zstd", async () => {
    const big = JSON.stringify({
      input: [{ type: "function_call_output", call_id: "c1", output: "x".repeat(50_000) }],
    });
    const result = await decodeRequestBody(zstd(big), "zstd");
    expect(result.json.input[0].output).toHaveLength(50_000);
  });

  it("exposes parsed json and raw text for logging/matching", async () => {
    const result = await decodeRequestBody(new TextEncoder().encode(SAMPLE), null);
    expect(typeof result.text).toBe("string");
    expect(typeof result.json).toBe("object");
  });

  it("throws a clear error on malformed JSON", async () => {
    const bytes = new TextEncoder().encode("{not json");
    await expect(decodeRequestBody(bytes, null)).rejects.toThrow();
  });
});
