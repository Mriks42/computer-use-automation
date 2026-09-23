/**
 * The allowlist.
 *
 * Enforced on every action, in discovery and in replay alike. Discovery is the
 * case that actually needs it — a model exploring an unfamiliar application is
 * precisely the situation where something unintended gets clicked — but replay
 * is checked too, because an artifact is a file, files get edited, and an
 * edited artifact should not be able to reach somewhere the recording never
 * could.
 *
 * Deny rules beat allow rules. The local target app exposes a fault-injection
 * control plane at /control/*; it is denied here, so the agent cannot reach the
 * switch that makes the application misbehave even though it is served from an
 * allowed origin. That asymmetry is the point of having deny rules at all.
 */

import type { Action } from "../surface/types.js";
import type { RiskClass } from "../capability/schema.js";
import { maxRisk, riskRank } from "./risk.js";

export interface AllowlistConfig {
  /** Origins the surface may visit, e.g. "http://127.0.0.1:4600". */
  allowedOrigins: string[];
  /** Path regexes that are permitted. Empty means all paths on an allowed origin. */
  allowedPaths: string[];
  /** Path regexes that are refused even on an allowed origin. Evaluated first. */
  deniedPaths: string[];
  /** Action types the agent may perform at all. */
  allowedActions: Action["type"][];
  /** The highest risk class permitted without an explicit human decision. */
  maxUnattendedRisk: RiskClass;
  /** Hard ceiling on discovery loop length, independent of model behaviour. */
  maxSteps: number;
}

export const DEFAULT_ALLOWLIST: AllowlistConfig = {
  allowedOrigins: [],
  allowedPaths: [],
  deniedPaths: ["^/control/", "^/admin/", "^/logout"],
  allowedActions: ["navigate", "click", "type", "select", "press", "wait_for", "extract", "done"],
  maxUnattendedRisk: "reversible_write",
  maxSteps: 30,
};

export type PolicyEffect = "allow" | "deny" | "confirm";

export interface PolicyDecision {
  effect: PolicyEffect;
  reason: string;
  risk: RiskClass;
  /** Rule that produced a deny or confirm, for the evidence log. */
  rule?: string;
}

export class Allowlist {
  private readonly config: AllowlistConfig;
  private readonly denied: RegExp[];
  private readonly allowed: RegExp[];

  constructor(config: Partial<AllowlistConfig> = {}) {
    this.config = { ...DEFAULT_ALLOWLIST, ...config };
    this.denied = this.config.deniedPaths.map((p) => new RegExp(p, "i"));
    this.allowed = this.config.allowedPaths.map((p) => new RegExp(p, "i"));
  }

  get maxSteps(): number {
    return this.config.maxSteps;
  }

  get maxUnattendedRisk(): RiskClass {
    return this.config.maxUnattendedRisk;
  }

  /**
   * Check a destination.
   *
   * Applied both to explicit navigations and to the URL the surface ends up on
   * after a click, because a click is a navigation the agent did not have to
   * spell out. Checking only explicit navigate actions would leave the obvious
   * hole open.
   */
  checkLocation(rawUrl: string): PolicyDecision {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { effect: "deny", reason: `unparseable URL: ${rawUrl}`, risk: "read_only", rule: "url_parse" };
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        effect: "deny",
        reason: `protocol ${url.protocol} is not permitted`,
        risk: "read_only",
        rule: "protocol",
      };
    }

    for (const pattern of this.denied) {
      if (pattern.test(url.pathname)) {
        return {
          effect: "deny",
          reason: `path ${url.pathname} matches a deny rule`,
          risk: "read_only",
          rule: `deny:${pattern.source}`,
        };
      }
    }

    if (this.config.allowedOrigins.length > 0 && !this.config.allowedOrigins.includes(url.origin)) {
      return {
        effect: "deny",
        reason: `origin ${url.origin} is not on the allowlist`,
        risk: "read_only",
        rule: "origin",
      };
    }

    if (this.allowed.length > 0 && !this.allowed.some((p) => p.test(url.pathname))) {
      return {
        effect: "deny",
        reason: `path ${url.pathname} is not on the allowlist`,
        risk: "read_only",
        rule: "path",
      };
    }

    return { effect: "allow", reason: "location permitted", risk: "read_only" };
  }

  /**
   * Check an action.
   *
   * `risk` is supplied by the caller rather than computed here, because the
   * caller knows what the action is pointed at — the label on the button — and
   * the allowlist does not.
   */
  checkAction(action: Action, risk: RiskClass): PolicyDecision {
    if (!this.config.allowedActions.includes(action.type)) {
      return {
        effect: "deny",
        reason: `action type "${action.type}" is not permitted`,
        risk,
        rule: "action_type",
      };
    }

    if (action.type === "navigate") {
      const locationDecision = this.checkLocation(action.url);
      if (locationDecision.effect !== "allow") return { ...locationDecision, risk };
    }

    if (riskRank(risk) > riskRank(this.config.maxUnattendedRisk)) {
      // Not a denial. An irreversible action is exactly what some capabilities
      // exist to perform; it just does not get to happen without a decision.
      return {
        effect: "confirm",
        reason: `action is ${risk}, above the unattended ceiling of ${this.config.maxUnattendedRisk}`,
        risk,
        rule: "risk_ceiling",
      };
    }

    return { effect: "allow", reason: "action permitted", risk };
  }

  /** Combined check used by the guarded surface. */
  check(action: Action, risk: RiskClass, currentLocation?: string): PolicyDecision {
    if (currentLocation) {
      const locationDecision = this.checkLocation(currentLocation);
      if (locationDecision.effect === "deny") return { ...locationDecision, risk: maxRisk(risk, "read_only") };
    }
    return this.checkAction(action, risk);
  }
}
