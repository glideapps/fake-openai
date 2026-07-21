/**
 * Scenario schema (PLAN.md §5, REQS §7). This is the declarative document a test
 * loads per session via the control API. The mock has no LLM — every answer is a
 * scenario rule replayed as SSE.
 *
 * Step shape uses an explicit `type` discriminator (cleaner/robuster than the
 * single-key YAML sketch in REQS §7.3; the wire semantics are identical).
 */

// --- Auth ----------------------------------------------------------------

export interface AuthScenario {
  device?: {
    /** Return `pending` for (approveAfterPolls-1) polls, then approve. 1 = approve on first poll. */
    approveAfterPolls?: number;
    /** Return `slow_down` this many times before normal polling resumes. */
    slowDownPolls?: number;
    /** Never approve; drive the 900s expiry/timeout path (also triggerable via /expire). */
    expire?: boolean;
    /** Require an explicit control-API approve call (no auto-approve). */
    manualApprove?: boolean;
  };
  refresh?: {
    /** Rotate the refresh token (return a new, different one). */
    rotate?: boolean;
    /** HTTP status for a refresh failure (4xx/5xx); omit for success. */
    failStatus?: number;
  };
  /** chatgpt_account_id baked into minted JWTs (REQS §6). */
  accountId?: string;
  /** `expires_in` for issued access tokens: far-future avoids refresh, near-past forces it. */
  accessTokenExpiresIn?: number;
  /** Mint access tokens WITHOUT the account claim, to drive "Failed to extract accountId". */
  omitAccountClaim?: boolean;
}

// --- Model rules ---------------------------------------------------------

export interface Matcher {
  userMessage?: string | { regex: string };
  turnIndex?: number;
  session?: string;
  toolResultContains?: string | { regex: string };
  default?: boolean;
}

export interface ReasoningStep {
  type: "reasoning";
  text: string;
  /** Even-split the text into N deltas. Ignored if `chunks` is given. */
  deltas?: number;
  /** Explicit delta boundaries (verbatim). Overrides `deltas`. */
  chunks?: string[];
  itemId?: string;
  encryptedContent?: string;
  /** Emit `reasoning_text.delta` instead of `reasoning_summary_text.delta`. */
  variant?: "summary" | "text";
}

export interface TextStep {
  type: "text";
  content: string;
  deltas?: number;
  chunks?: string[];
  itemId?: string;
  /** Emit as a refusal (`response.refusal.delta` + refusal content). */
  refusal?: boolean;
}

export interface ToolCallStep {
  type: "toolCall";
  name: string;
  arguments: unknown; // object (stringified) or a raw JSON string
  callId?: string;
  itemId?: string;
  deltas?: number;
  argumentChunks?: string[];
}

export interface UsageStep {
  type: "usage";
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface StopStep {
  type: "stop";
  status?: "completed" | "incomplete" | "failed" | "cancelled";
}

export interface DelayStep {
  type: "delay";
  ms: number;
}

export type Step =
  | ReasoningStep
  | TextStep
  | ToolCallStep
  | UsageStep
  | StopStep
  | DelayStep;

export interface Fault {
  /** Pre-stream non-2xx + JSON error body. */
  httpError?: {
    status: number;
    code?: string;
    type?: string;
    message?: string;
    plan_type?: string;
    resets_at?: number;
    retryAfterSeconds?: number;
    retryAfterMs?: number;
  };
  /** Emit some steps, then an `error` / `response.failed` event mid-stream. */
  midStreamError?: { code?: string; message?: string; via?: "error" | "response.failed" };
  /** End the stream with no terminal event. */
  truncate?: boolean;
  /** Never send a terminal event; hold open until client disconnect. */
  hang?: boolean;
  /** Return httpError for the first N attempts, then stream normally. */
  rateLimitThenSucceed?: { attempts: number; status?: number };
}

export interface Rule {
  match: Matcher;
  steps?: Step[];
  /** Explicit response id (else minted). */
  responseId?: string;
  fault?: Fault;
}

export interface Scenario {
  auth?: AuthScenario;
  model?: { rules: Rule[] };
}
