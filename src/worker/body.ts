/**
 * Request-body decoding for the model endpoint (REQS §4.3).
 *
 * On the SSE path pi-ai may zstd-compress the JSON body (Node
 * `zlib.zstdCompressSync`, level 3) and set `content-encoding: zstd`. Cloudflare
 * Workers' `DecompressionStream` has no zstd, so we decode with the bundled
 * pure-JS `fzstd`. Compression is skipped in environments without zstd, so we
 * must handle both compressed and plain bodies.
 *
 * IMPORTANT (PLAN.md §4.2): the raw body is single-consume on Workers — the
 * route handler reads it exactly once and passes the bytes here; there is no
 * body-consuming middleware.
 */
import { decompress } from "fzstd";

export interface DecodedBody {
  /** Parsed JSON (used for predicate matching). */
  json: any;
  /** Raw decoded text (stored verbatim in the request log). */
  text: string;
  wasCompressed: boolean;
}

export async function decodeRequestBody(
  bytes: Uint8Array,
  contentEncoding: string | null,
): Promise<DecodedBody> {
  const encoding = contentEncoding?.trim().toLowerCase();
  let text: string;
  let wasCompressed = false;

  if (encoding === "zstd") {
    const out = decompress(bytes);
    text = new TextDecoder().decode(out);
    wasCompressed = true;
  } else {
    text = new TextDecoder().decode(bytes);
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse request body as JSON: ${(e as Error).message}`);
  }
  return { json, text, wasCompressed };
}
