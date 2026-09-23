/**
 * Intervention requests.
 *
 * What an operator needs in order to act is not "the automation stopped". It is:
 * which capability, pursuing what goal, on whose behalf, at which step, what the
 * screen looked like, and what the system was expecting to happen instead. All
 * of that is assembled at the moment of escalation, while the context still
 * exists, because it cannot be reconstructed afterwards from a stack trace.
 *
 * The request carries the *reason* as a structured kind rather than a message,
 * so that routing decisions can be made on it later without parsing prose —
 * a risky-action confirmation goes to someone with authority, a stuck discovery
 * run goes to whoever is building the capability.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Observation } from "../surface/types.js";

export type InterventionKind =
  /** The model could not work out how to proceed during discovery. */
  | "discovery_stuck"
  /** Replay hit a condition its artifact does not describe how to handle. */
  | "replay_unrecoverable"
  /** An irreversible action needs a person to authorize it. */
  | "risky_action_confirmation"
  /** Policy refused something and a person should decide whether to widen it. */
  | "policy_refusal";

export type InterventionStatus = "open" | "taken" | "resolved" | "aborted";

/** What the operator did while holding the lease. */
export interface HumanAction {
  at: string;
  type: "click" | "input" | "change" | "submit" | "navigate" | "key";
  /** Role and label of the control, matching the observation vocabulary. */
  target?: string;
  /**
   * Never the value typed. Recording what an operator entered into a field on a
   * member record would defeat the entire redaction layer; we record that a
   * field was filled, its identity, and the length of what went in.
   */
  valueLength?: number;
  location?: string;
}

export interface InterventionContext {
  location: string;
  title: string;
  /** Redacted excerpt of what was on screen. */
  textExcerpt: string;
  signals: string[];
  screenshotPath?: string;
}

export interface InterventionRequest {
  id: string;
  runId: string;
  kind: InterventionKind;
  createdAt: string;
  status: InterventionStatus;

  /** What the system was trying to do. */
  goal?: string;
  capabilityId?: string;
  capabilityVersion?: string;
  stepId?: string;
  stepIndex?: number;

  /** Why it stopped, in one line, and in detail. */
  reason: string;
  detail: string;
  /** What the system expected to be true but was not. */
  expected?: string;
  observed?: string;

  /** For risky_action_confirmation: the action awaiting authorization. */
  proposedAction?: { description: string; risk: string };

  /** What an operator is being asked to do. */
  suggestedAction?: string;

  context: InterventionContext;

  resolution?: {
    actor: string;
    at: string;
    note: string;
    decision?: "approved" | "rejected";
    humanActions: HumanAction[];
  };
}

export function summarizeObservation(observation: Observation, excerptLength = 1200): InterventionContext {
  return {
    location: observation.location,
    title: observation.title,
    textExcerpt: observation.text.slice(0, excerptLength),
    signals: observation.signals.map((s) => `${s.kind}: ${s.detail}`),
  };
}

/**
 * In-process store.
 *
 * Deliberately not a queue or a database. The seam that matters is the
 * InterventionRequest shape and the lease transitions around it; swapping this
 * for a real queue is a store implementation, not a redesign. Building the
 * queue now would be building scaling infrastructure the brief explicitly says
 * not to build.
 */
export class InterventionStore extends EventEmitter {
  private readonly requests = new Map<string, InterventionRequest>();

  create(input: Omit<InterventionRequest, "id" | "createdAt" | "status">): InterventionRequest {
    const request: InterventionRequest = {
      ...input,
      id: `int-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      status: "open",
    };
    this.requests.set(request.id, request);
    this.emit("created", request);
    return request;
  }

  get(id: string): InterventionRequest | undefined {
    return this.requests.get(id);
  }

  list(status?: InterventionStatus): InterventionRequest[] {
    const all = [...this.requests.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return status ? all.filter((r) => r.status === status) : all;
  }

  markTaken(id: string, actor: string): InterventionRequest | undefined {
    const request = this.requests.get(id);
    if (!request || request.status !== "open") return undefined;
    request.status = "taken";
    request.resolution = { actor, at: new Date().toISOString(), note: "", humanActions: [] };
    this.emit("taken", request);
    return request;
  }

  resolve(
    id: string,
    input: { actor: string; note: string; decision?: "approved" | "rejected"; humanActions: HumanAction[] },
  ): InterventionRequest | undefined {
    const request = this.requests.get(id);
    if (!request) return undefined;
    request.status = input.decision === "rejected" ? "aborted" : "resolved";
    request.resolution = {
      actor: input.actor,
      at: new Date().toISOString(),
      note: input.note,
      decision: input.decision,
      humanActions: input.humanActions,
    };
    this.emit("resolved", request);
    return request;
  }
}
