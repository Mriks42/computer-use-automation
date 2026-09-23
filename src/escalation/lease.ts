/**
 * Session control.
 *
 * The requirement is that a human can take over the *same* live session the
 * automation was driving, and hand it back. The temptation is to implement that
 * as a flag the agent loop politely checks. That is not a control model, it is
 * a convention, and conventions get violated by the one code path that forgot.
 *
 * So control is a lease, and the lease is enforced at the only place that
 * matters: the surface. Every act() goes through a holder check and throws if
 * the caller is not the current controller. A background retry that wakes up
 * while an operator is mid-correction cannot type into their form, because the
 * surface refuses it — not because the retry was written carefully.
 *
 * The states are deliberately four rather than two. `pending_human` exists
 * because the interval between "automation gave up" and "a person actually
 * arrived" is real, can be long, and is the window in which nobody is driving.
 * Collapsing it into `human` would mean the system believes an operator is at
 * the controls before one is.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export type Controller = "automation" | "pending_human" | "human" | "released";

export class ControlViolationError extends Error {
  constructor(
    readonly attemptedBy: Controller,
    readonly currentController: Controller,
  ) {
    super(
      `control violation: "${attemptedBy}" attempted to act while "${currentController}" holds the session lease`,
    );
    this.name = "ControlViolationError";
  }
}

export interface LeaseTransition {
  from: Controller;
  to: Controller;
  at: string;
  reason: string;
  /** Operator identity, when a person is involved. */
  actor?: string;
}

export interface LeaseState {
  sessionId: string;
  controller: Controller;
  heldSince: string;
  reason: string;
  actor?: string;
  history: LeaseTransition[];
}

export class ControlBroker extends EventEmitter {
  private readonly sessionId: string;
  private controller: Controller = "automation";
  private heldSince = new Date().toISOString();
  private reason = "session opened under automation";
  private actor: string | undefined;
  private readonly history: LeaseTransition[] = [];

  constructor(sessionId: string = randomUUID()) {
    super();
    this.sessionId = sessionId;
  }

  get id(): string {
    return this.sessionId;
  }

  get current(): Controller {
    return this.controller;
  }

  state(): LeaseState {
    return {
      sessionId: this.sessionId,
      controller: this.controller,
      heldSince: this.heldSince,
      reason: this.reason,
      actor: this.actor,
      history: [...this.history],
    };
  }

  private transition(to: Controller, reason: string, actor?: string): void {
    const transition: LeaseTransition = {
      from: this.controller,
      to,
      at: new Date().toISOString(),
      reason,
      actor,
    };
    this.history.push(transition);
    this.controller = to;
    this.heldSince = transition.at;
    this.reason = reason;
    this.actor = actor;
    this.emit("transition", transition);
  }

  /**
   * Gate for every action. Throws rather than returning false, because a
   * control violation is a bug in the caller and should not be recoverable by
   * ignoring the return value.
   */
  assertControl(claimant: Controller): void {
    if (this.controller !== claimant) {
      throw new ControlViolationError(claimant, this.controller);
    }
  }

  holds(claimant: Controller): boolean {
    return this.controller === claimant;
  }

  /** Automation stands down. Nobody is driving until an operator arrives. */
  requestHuman(reason: string): void {
    if (this.controller !== "automation") {
      throw new Error(`cannot request human control from state "${this.controller}"`);
    }
    this.transition("pending_human", reason);
  }

  /** An operator has arrived and is now driving the live session. */
  takeControl(actor: string): void {
    if (this.controller !== "pending_human") {
      throw new Error(`cannot take control from state "${this.controller}"`);
    }
    this.transition("human", "operator took control of the live session", actor);
  }

  /**
   * The operator is done. Automation resumes — but the caller is expected to
   * re-observe and re-assert before trusting the surface, because the operator
   * may have left it somewhere other than where they were asked to.
   */
  returnControl(summary: string): void {
    if (this.controller !== "human") {
      throw new Error(`cannot return control from state "${this.controller}"`);
    }
    this.transition("automation", summary, this.actor);
  }

  /** Terminal. Used when an operator decides the run should not continue. */
  release(reason: string): void {
    this.transition("released", reason, this.actor);
  }

  /** Resolves once the operator hands control back, or the run is aborted. */
  waitForAutomation(timeoutMs: number): Promise<"resumed" | "released" | "timeout"> {
    if (this.controller === "automation") return Promise.resolve("resumed");
    if (this.controller === "released") return Promise.resolve("released");

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off("transition", onTransition);
        resolve("timeout");
      }, timeoutMs);

      const onTransition = (t: LeaseTransition) => {
        if (t.to === "automation") {
          clearTimeout(timer);
          this.off("transition", onTransition);
          resolve("resumed");
        } else if (t.to === "released") {
          clearTimeout(timer);
          this.off("transition", onTransition);
          resolve("released");
        }
      };

      this.on("transition", onTransition);
    });
  }
}
