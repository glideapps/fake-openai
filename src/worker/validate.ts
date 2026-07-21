/**
 * Minimal scenario validation (PLAN.md §5). Structural only — enough to reject
 * obviously malformed documents with a clear error; the engine tolerates missing
 * optional fields.
 */
import type { Scenario } from "./types.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  scenario?: Scenario;
}

export function validateScenario(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["scenario must be an object"] };
  }
  const s = input as Record<string, unknown>;

  if (s.model !== undefined) {
    const model = s.model as Record<string, unknown>;
    if (typeof model !== "object" || model === null || Array.isArray(model)) {
      errors.push("model must be an object");
    } else if (!Array.isArray(model.rules)) {
      errors.push("model.rules must be an array");
    } else {
      model.rules.forEach((rule: any, i: number) => {
        if (typeof rule !== "object" || rule === null) {
          errors.push(`model.rules[${i}] must be an object`);
          return;
        }
        if (typeof rule.match !== "object" || rule.match === null) {
          errors.push(`model.rules[${i}].match must be an object`);
        }
        if (rule.steps !== undefined && !Array.isArray(rule.steps)) {
          errors.push(`model.rules[${i}].steps must be an array`);
        }
      });
    }
  }

  if (s.auth !== undefined) {
    if (typeof s.auth !== "object" || s.auth === null || Array.isArray(s.auth)) {
      errors.push("auth must be an object");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], scenario: input as Scenario };
}
