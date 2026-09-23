/**
 * The handoff.
 *
 * Sequence, and the reason for each part:
 *
 *   1. Capture context *before* standing down. Once automation releases the
 *      lease the operator may navigate away, and the screen that caused the
 *      escalation is gone. Evidence has to be taken at the moment of failure.
 *   2. Raise the request, then release the lease. In that order, so there is
 *      never an instant where the lease is free but nothing has been recorded
 *      about why.
 *   3. Start recording human input before the operator can possibly arrive.
 *   4. Block until control comes back, or until a timeout that is generous
 *      enough for a person to actually walk over and look.
 *   5. On resume, capture again and drain what the operator did.
 *
 * What this deliberately does *not* do is trust the operator to have left the
 * session where they were asked to. The caller is expected to re-observe and
 * re-assert its checkpoint after this returns — see ReplayEngine, which treats
 * a resumed run exactly like a fresh attempt at the current step.
 */

import type { ControlBroker } from "./lease.js";
import {
  summarizeObservation,
  type HumanAction,
  type InterventionKind,
  type InterventionRequest,
  type InterventionStore,
} from "./intervention.js";
import type { RunLogger } from "../evidence/logger.js";
import type { Observation, Surface } from "../surface/types.js";

export interface EscalationInput {
  kind: InterventionKind;
  reason: string;
  detail: string;
  goal?: string;
  capabilityId?: string;
  capabilityVersion?: string;
  stepId?: string;
  stepIndex?: number;
  expected?: string;
  observed?: string;
  suggestedAction?: string;
  proposedAction?: { description: string; risk: string };
}

export type HandoffOutcome =
  | { status: "resumed"; actor: string; note: string; humanActions: HumanAction[] }
  | { status: "rejected"; actor: string; note: string }
  | { status: "timeout" };

export interface HandoffOptions {
  /** How long to wait for a person. Default 10 minutes. */
  waitMs?: number;
}

export class HandoffCoordinator {
  private readonly waitMs: number;

  constructor(
    private readonly broker: ControlBroker,
    private readonly surface: Surface,
    private readonly store: InterventionStore,
    private readonly logger: RunLogger,
    options: HandoffOptions = {},
  ) {
    this.waitMs = options.waitMs ?? 10 * 60_000;
  }

  /** Called by the operator console when a person picks up the request. */
  takeControl(requestId: string, actor: string): InterventionRequest | undefined {
    const request = this.store.markTaken(requestId, actor);
    if (!request) return undefined;
    this.broker.takeControl(actor);
    this.logger.event("handoff_taken", { interventionId: requestId, actor });
    return request;
  }

  /** Called by the operator console when the person is finished. */
  async returnControl(
    requestId: string,
    input: { actor: string; note: string; decision?: "approved" | "rejected" },
  ): Promise<InterventionRequest | undefined> {
    const humanActions = ((await this.surface.drainHumanActions?.()) ?? []) as HumanAction[];

    const request = this.store.resolve(requestId, {
      actor: input.actor,
      note: input.note,
      decision: input.decision,
      humanActions,
    });
    if (!request) return undefined;

    this.logger.event("handoff_returned", {
      interventionId: requestId,
      actor: input.actor,
      decision: input.decision ?? "approved",
      note: input.note,
      humanActionCount: humanActions.length,
      humanActions,
    });

    if (input.decision === "rejected") {
      this.broker.release(`operator ${input.actor} aborted the run: ${input.note}`);
    } else {
      this.broker.returnControl(`operator ${input.actor} returned control: ${input.note}`);
    }
    return request;
  }

  /**
   * Stand down and wait for a person. Returns once control is back, or once
   * waiting has gone on long enough that nobody is coming.
   */
  async escalate(input: EscalationInput, observation?: Observation): Promise<HandoffOutcome> {
    const current = observation ?? (await this.surface.observe());
    const capture = await this.logger.capture(this.surface, `escalation-${input.kind}`);

    const context = summarizeObservation(current);
    context.screenshotPath = capture.screenshot;

    const request = this.store.create({
      runId: this.logger.runId,
      kind: input.kind,
      goal: input.goal,
      capabilityId: input.capabilityId,
      capabilityVersion: input.capabilityVersion,
      stepId: input.stepId,
      stepIndex: input.stepIndex,
      reason: input.reason,
      detail: input.detail,
      expected: input.expected,
      observed: input.observed,
      suggestedAction: input.suggestedAction,
      proposedAction: input.proposedAction,
      context,
    });

    this.logger.event("escalation_raised", {
      interventionId: request.id,
      kind: input.kind,
      reason: input.reason,
      stepId: input.stepId,
      expected: input.expected,
      observed: input.observed,
    });

    this.broker.requestHuman(`${input.kind}: ${input.reason}`);
    await this.surface.beginHumanRecording?.();

    process.stdout.write(
      `\n  ⏸  Automation paused. Intervention ${request.id} is open for an operator.\n` +
        `     Reason: ${input.reason}\n` +
        `     Operator console: http://127.0.0.1:${process.env.OPERATOR_PORT ?? 4610}\n\n`,
    );

    const result = await this.broker.waitForAutomation(this.waitMs);

    if (result === "timeout") {
      this.logger.event("handoff_timeout", { interventionId: request.id, waitedMs: this.waitMs });
      return { status: "timeout" };
    }

    const resolved = this.store.get(request.id);
    const actor = resolved?.resolution?.actor ?? "unknown";
    const note = resolved?.resolution?.note ?? "";

    if (result === "released" || resolved?.resolution?.decision === "rejected") {
      return { status: "rejected", actor, note };
    }

    await this.logger.capture(this.surface, `post-handoff-${request.id}`);

    return {
      status: "resumed",
      actor,
      note,
      humanActions: resolved?.resolution?.humanActions ?? [],
    };
  }
}
