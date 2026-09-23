/**
 * The replay result contract.
 *
 * Four statuses, and the split between the first two is the whole point.
 *
 *   success          — the flow ran and the goal was met. Outputs attached.
 *   business_outcome — the flow ran correctly and the answer is not success.
 *                      "No such member." "Access restricted." The caller asked
 *                      a question and this is the answer. Nothing is broken.
 *   escalated        — a person was brought in and the run did not complete
 *                      autonomously. Distinct from failure because the system
 *                      behaved correctly; it just could not finish alone.
 *   failure          — something is wrong with the automation, the artifact,
 *                      or the application. Someone needs to look at it.
 *
 * Collapsing business_outcome into failure is the mistake this schema exists to
 * prevent. A calling agent that cannot distinguish "the member does not exist"
 * from "the automation is broken" will retry a lookup that can never succeed,
 * and will page someone about a member number that was simply mistyped.
 */

import type { Capability } from "../capability/schema.js";

export type FailureClass =
  /** No rung of the locator ladder resolved. Usually drift, sometimes a wrong screen. */
  | "locator_unresolved"
  /** The ladder resolved to more than one element. Never guessed at. */
  | "locator_ambiguous"
  /** The step ran but the screen does not show what it should. */
  | "checkpoint_failed"
  /** The screen was already wrong before the step ran. */
  | "precondition_failed"
  /** The application signed us out mid-flow. */
  | "session_expired"
  /** The application itself errored. */
  | "surface_error"
  /** The step did not complete in time and no recovery applied. */
  | "timeout"
  /** Policy refused an action. A governance event, not an operational one. */
  | "policy_denied"
  /** A risky action was not authorized by whoever was asked. */
  | "confirmation_denied"
  /** A declared output could not be read. */
  | "output_missing"
  /** Caller-supplied parameters failed validation. Nothing was attempted. */
  | "input_invalid"
  /** The artifact is not approved for the requested mode of invocation. */
  | "not_approved"
  /** A handoff was raised and nobody took it. */
  | "handoff_timeout"
  | "internal";

export interface StepTrace {
  stepId: string;
  index: number;
  intent: string;
  status: "ok" | "skipped" | "recovered" | "failed";
  /** Which rung of the ladder resolved. 0 is the strongest. */
  resolvedRung?: number;
  resolvedBy?: string;
  recoveriesApplied?: string[];
  durationMs: number;
  note?: string;
}

export interface ReplayFailure {
  class: FailureClass;
  stepId?: string;
  stepIndex?: number;
  intent?: string;
  /** What the system required to be true. */
  expected: string;
  /** What it found instead. */
  observed: string;
  detail: string;
  evidence?: { screenshot?: string; raw?: string };
  recoveryAttempted: string[];
}

interface ReplayBase {
  runId: string;
  capabilityId: string;
  capabilityVersion: string;
  startedAt: string;
  durationMs: number;
  trace: StepTrace[];
  evidenceDir: string;
  /** How many steps resolved below their strongest rung. A drift signal. */
  degradedResolutions: number;
}

export type ReplayResult = ReplayBase &
  (
    | { status: "success"; outputs: Record<string, unknown> }
    | {
        status: "business_outcome";
        code: string;
        message: string;
        description: string;
        outputs: Record<string, unknown>;
      }
    | { status: "escalated"; interventionId: string; note: string; actor?: string }
    | { status: "failure"; failure: ReplayFailure }
  );

/** Render a result the way a calling agent would want it summarized. */
export function describeResult(result: ReplayResult): string {
  switch (result.status) {
    case "success":
      return `success — ${Object.keys(result.outputs).length} output(s)`;
    case "business_outcome":
      return `${result.code} — ${result.message}`;
    case "escalated":
      return `escalated — ${result.note}`;
    case "failure":
      return `failure [${result.failure.class}] at ${result.failure.stepId ?? "n/a"}: expected ${result.failure.expected}, observed ${result.failure.observed}`;
  }
}

export function coerceOutput(value: string, type: Capability["outputs"][number]["type"]): unknown {
  const trimmed = value.trim();
  switch (type) {
    case "number":
      return Number(trimmed.replace(/[^0-9.-]/g, ""));
    case "currency": {
      // Preserve the parsed amount rather than the formatted string; a caller
      // doing arithmetic on "$8,241.55" is a bug waiting to happen.
      const numeric = Number(trimmed.replace(/[^0-9.-]/g, ""));
      return Number.isNaN(numeric) ? trimmed : numeric;
    }
    case "boolean":
      return /^(true|yes|y|1)$/i.test(trimmed);
    case "string":
    case "date":
      return trimmed;
  }
}
