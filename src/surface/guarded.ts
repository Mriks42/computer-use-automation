/**
 * Policy and control enforcement, applied as a wrapper around any Surface.
 *
 * This is a decorator rather than logic inside the agent loop or the replay
 * engine, for one reason: there are two execution paths (discovery and replay)
 * and there will eventually be more. Enforcement written into a caller has to
 * be written into every caller, correctly, forever. Enforcement at the surface
 * happens once and cannot be forgotten, because there is no way to reach the
 * application except through it.
 *
 * Composition is GuardedSurface(PlaywrightSurface). The guard holds the lease
 * and the allowlist; the adapter holds the browser; neither knows about the
 * other's concerns.
 */

import { Allowlist, type PolicyDecision } from "../policy/allowlist.js";
import { ConfirmationDeniedError, PolicyViolationError } from "../policy/errors.js";
import { classifyAction } from "../policy/risk.js";
import type { ControlBroker } from "../escalation/lease.js";
import type {
  ActResult,
  Action,
  Observation,
  RecordedHumanAction,
  ResolvedStrategyRequest,
  Surface,
  SurfaceCapture,
  SurfaceDescriptor,
} from "./types.js";

/** Asked to approve an action above the unattended risk ceiling. */
export type ConfirmationHandler = (
  action: Action,
  decision: PolicyDecision,
  observation: Observation | undefined,
) => Promise<{ approved: boolean; note: string }>;

export interface GuardedSurfaceOptions {
  broker: ControlBroker;
  allowlist: Allowlist;
  /** Absent means every risky action is refused, which is the safe default. */
  onConfirmationRequired?: ConfirmationHandler;
  /** Called for every decision, including allows, so evidence is complete. */
  onDecision?: (action: Action, decision: PolicyDecision) => void;
}

export class GuardedSurface implements Surface {
  private lastObservation: Observation | undefined;

  constructor(
    private readonly inner: Surface,
    private readonly options: GuardedSurfaceOptions,
  ) {}

  get descriptor(): SurfaceDescriptor {
    return this.inner.descriptor;
  }

  /** The wrapped adapter, for the handoff layer which needs the live page. */
  get adapter(): Surface {
    return this.inner;
  }

  async observe(): Promise<Observation> {
    // Observation is not gated. Reading the screen is how an escalation builds
    // the context it hands to an operator, and that has to work precisely when
    // automation does not hold the lease.
    const observation = await this.inner.observe();
    this.lastObservation = observation;
    return observation;
  }

  /**
   * Resolve the label on whatever this action targets, so risk classification
   * reads the same words a human operator would.
   */
  private riskContextFor(action: Action) {
    if (!("ref" in action) || !action.ref) return {};
    const element = this.lastObservation?.elements.find((e) => e.ref === action.ref);
    if (!element) return {};
    return {
      targetName: element.name || element.derivedName,
      targetRole: element.role,
    };
  }

  async act(action: Action): Promise<ActResult> {
    this.options.broker.assertControl("automation");

    const risk = classifyAction(action, this.riskContextFor(action));
    const decision = this.options.allowlist.check(action, risk, this.lastObservation?.location);
    this.options.onDecision?.(action, decision);

    if (decision.effect === "deny") {
      throw new PolicyViolationError(decision);
    }

    if (decision.effect === "confirm") {
      const handler = this.options.onConfirmationRequired;
      if (!handler) {
        // No approver configured means unattended. Refusing is the only
        // defensible behaviour: the alternative is performing an irreversible
        // action at a bank because nobody was around to say no.
        throw new ConfirmationDeniedError(decision, "no confirmation handler is configured");
      }
      const outcome = await handler(action, decision, this.lastObservation);
      if (!outcome.approved) {
        throw new ConfirmationDeniedError(decision, outcome.note);
      }
    }

    const result = await this.inner.act(action);

    // A click can navigate somewhere the allowlist would have refused had it
    // been requested directly. Check where we actually ended up.
    const after = await this.inner.observe();
    this.lastObservation = after;
    const locationDecision = this.options.allowlist.checkLocation(after.location);
    if (locationDecision.effect === "deny") {
      this.options.onDecision?.(action, locationDecision);
      throw new PolicyViolationError({
        ...locationDecision,
        reason: `action navigated to a location outside the allowlist: ${locationDecision.reason}`,
      });
    }

    return result;
  }

  capture(): Promise<SurfaceCapture> {
    return this.inner.capture();
  }

  resolve(request: ResolvedStrategyRequest): Promise<string | undefined> {
    return this.inner.resolve(request);
  }

  // Human recording is not lease-gated: it exists precisely to observe the
  // window in which automation does not hold the lease.
  async beginHumanRecording(): Promise<void> {
    await this.inner.beginHumanRecording?.();
  }

  async drainHumanActions(): Promise<RecordedHumanAction[]> {
    return (await this.inner.drainHumanActions?.()) ?? [];
  }

  dispose(): Promise<void> {
    return this.inner.dispose();
  }
}
