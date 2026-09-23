import type { PolicyDecision } from "./allowlist.js";

/**
 * Thrown when an action is refused by policy.
 *
 * Distinct from a replay failure on purpose. A step that fails because the page
 * was slow is an operational problem; a step that fails because policy refused
 * it is a governance event, and the two should never be aggregated into the
 * same error rate.
 */
export class PolicyViolationError extends Error {
  constructor(readonly decision: PolicyDecision) {
    super(`policy denied action: ${decision.reason}`);
    this.name = "PolicyViolationError";
  }
}

/** Thrown when a risky action was not approved by whoever was asked. */
export class ConfirmationDeniedError extends Error {
  constructor(
    readonly decision: PolicyDecision,
    readonly note: string,
  ) {
    super(`confirmation refused for ${decision.risk} action: ${note}`);
    this.name = "ConfirmationDeniedError";
  }
}
