/**
 * JWT minting for access tokens (REQS §6 — HARD requirement).
 *
 * pi-ai's `decodeJwt`/`extractAccountId`:
 *   - split the token on "." and require EXACTLY 3 parts,
 *   - `atob`-decode part 1 (payload) and `JSON.parse` it,
 *   - read `payload["https://api.openai.com/auth"].chatgpt_account_id`
 *     (must be a non-empty string) — else login/refresh/streaming fails.
 * The header and signature are never decoded or verified.
 *
 * Encoding caveat: pi-ai uses `atob` (forgiving-base64), which does NOT accept
 * base64url-only chars. So the payload is encoded as STANDARD base64 (padded).
 *
 * The token is fully deterministic (no wall-clock input): pi-ai derives refresh
 * timing from the token RESPONSE's `expires_in` (REQS §4.1c), not the JWT `exp`,
 * so `exp` is a fixed far-future constant.
 */

export const AUTH_CLAIM = "https://api.openai.com/auth";

// Fixed far-future expiry (matches the REQS §6 example shape). Cosmetic: pi-ai
// never uses this for refresh decisions.
const FAR_FUTURE_EXP = 9_999_999_999;

// A JWT-looking header ({"alg":"none","typ":"JWT"}) and a non-empty placeholder
// signature. pi-ai decodes neither. Both are stable for determinism.
const HEADER_SEGMENT = base64UrlFromString('{"alg":"none","typ":"JWT"}');
const SIGNATURE_SEGMENT = "mocksignature";

export interface MintOptions {
  accountId: string;
  /** Omit the account claim entirely to drive the "Failed to extract accountId" failure case. */
  omitAccountClaim?: boolean;
}

export function mintAccessToken(opts: MintOptions): string {
  const payload: Record<string, unknown> = {
    exp: FAR_FUTURE_EXP,
    sub: "user_mock",
  };
  if (!opts.omitAccountClaim) {
    payload[AUTH_CLAIM] = { chatgpt_account_id: opts.accountId };
  }
  const payloadSegment = base64StdFromString(JSON.stringify(payload));
  return `${HEADER_SEGMENT}.${payloadSegment}.${SIGNATURE_SEGMENT}`;
}

/** Mirror of pi-ai's extraction path, used by the model route to assert round-trip. */
export function extractAccountId(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Failed to extract accountId from token: not a 3-part JWT");
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(atob(parts[1]));
  } catch {
    throw new Error("Failed to extract accountId from token: payload not JSON");
  }
  const claim = payload[AUTH_CLAIM] as { chatgpt_account_id?: unknown } | undefined;
  const id = claim?.chatgpt_account_id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Failed to extract accountId from token");
  }
  return id;
}

// --- base64 helpers -------------------------------------------------------

function bytesToBinaryString(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return bin;
}

/** Standard base64 (padded), so pi-ai's `atob` reliably decodes it (REQS §6). */
function base64StdFromString(s: string): string {
  return btoa(bytesToBinaryString(new TextEncoder().encode(s)));
}

/** base64url (unpadded) — used only for the cosmetic header segment. */
function base64UrlFromString(s: string): string {
  return base64StdFromString(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
