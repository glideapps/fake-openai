import { describe, it, expect } from "vitest";
import { mintAccessToken, extractAccountId, AUTH_CLAIM } from "./jwt.js";

/**
 * These tests encode pi-ai's actual constraints (REQS §6):
 *  - token splits on "." into exactly 3 parts
 *  - part[1] (payload) is `atob`-decoded then JSON.parsed
 *  - payload has claim "https://api.openai.com/auth".chatgpt_account_id (non-empty string)
 *  - payload uses STANDARD base64 (padded), not base64url, so `atob` decodes it
 *
 * Note: pi-ai derives refresh timing from the token RESPONSE's `expires_in`
 * field, NOT from the JWT `exp` claim (REQS §4.1c). So the JWT can carry a fixed
 * far-future `exp` and stay fully deterministic; refresh steering lives in the
 * OAuth token route, not here.
 */

// Mirror of pi-ai: atob-decode part 1 and read the account id.
function piaiExtractAccountId(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("expected 3 parts");
  const payload = JSON.parse(atob(parts[1]));
  const claim = payload[AUTH_CLAIM];
  const id = claim?.chatgpt_account_id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Failed to extract accountId from token");
  }
  return id;
}

describe("mintAccessToken", () => {
  it("produces a token with exactly 3 dot-separated parts", () => {
    const jwt = mintAccessToken({ accountId: "acct_mock_0001" });
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("embeds chatgpt_account_id where pi-ai's atob+JSON.parse reads it", () => {
    const jwt = mintAccessToken({ accountId: "acct_mock_0001" });
    expect(piaiExtractAccountId(jwt)).toBe("acct_mock_0001");
  });

  it("our own extractAccountId agrees with the pi-ai decode path", () => {
    const jwt = mintAccessToken({ accountId: "acct_xyz" });
    expect(extractAccountId(jwt)).toBe("acct_xyz");
    expect(extractAccountId(jwt)).toBe(piaiExtractAccountId(jwt));
  });

  it("encodes the payload as STANDARD base64 so atob (forgiving-base64) decodes it", () => {
    // An account id engineered to force base64 chars that differ between
    // standard ('+','/') and url-safe ('-','_') alphabets.
    const jwt = mintAccessToken({ accountId: "acct_>>>???<<<" });
    const payloadSeg = jwt.split(".")[1];
    expect(payloadSeg).not.toMatch(/[-_]/); // not base64url
    expect(piaiExtractAccountId(jwt)).toBe("acct_>>>???<<<");
  });

  it("carries a far-future exp by default (kept valid; not used for refresh timing)", () => {
    const payload = JSON.parse(atob(mintAccessToken({ accountId: "a" }).split(".")[1]));
    expect(payload.exp).toBeGreaterThan(4_000_000_000); // year ~2096+
  });

  it("is deterministic: same inputs => byte-identical token (no wall-clock input)", () => {
    expect(mintAccessToken({ accountId: "acct_mock_0001" })).toBe(
      mintAccessToken({ accountId: "acct_mock_0001" }),
    );
  });

  it("can mint a token WITHOUT the account claim to drive the bad-JWT failure case", () => {
    const jwt = mintAccessToken({ accountId: "", omitAccountClaim: true });
    expect(jwt.split(".")).toHaveLength(3);
    expect(() => piaiExtractAccountId(jwt)).toThrow(/Failed to extract accountId/);
  });
});

describe("extractAccountId", () => {
  it("throws on a token without the claim", () => {
    const jwt = mintAccessToken({ accountId: "", omitAccountClaim: true });
    expect(() => extractAccountId(jwt)).toThrow();
  });

  it("throws on a token that is not 3 parts", () => {
    expect(() => extractAccountId("not.a.jwt.token")).toThrow();
    expect(() => extractAccountId("nope")).toThrow();
  });
});
