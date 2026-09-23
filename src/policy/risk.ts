/**
 * Risk classification for actions.
 *
 * The distinction that matters operationally is not "read vs write" but
 * "can this be undone". Typing into a field is a write, but nothing has
 * happened yet; the form can be abandoned. Clicking "Post Transaction" cannot
 * be taken back by any amount of subsequent automation.
 *
 * Classification is heuristic and admits it. It reads the verb on the control,
 * which is the same thing a human operator reads, and which is the only signal
 * these applications reliably offer. That makes it wrong sometimes — and the
 * design accounts for being wrong by choosing which way to fail:
 *
 *   - an unrecognised button is treated as a *write*, not a read;
 *   - anything matching the irreversible vocabulary is treated as irreversible
 *     even if it turns out to be harmless;
 *   - a step in an artifact can carry an explicit classification that overrides
 *     the heuristic, set by the human who reviewed and approved it.
 *
 * So the heuristic's job is to be conservative on first encounter, and to be
 * correctable by review. It is not the last line of defence — the allowlist and
 * the approval gate are.
 */

import type { RiskClass } from "../capability/schema.js";
import type { Action } from "../surface/types.js";

/**
 * Control labels that commit something. Drawn from back-office vocabulary:
 * these are the words that appear on the button you cannot un-click.
 */
const IRREVERSIBLE_VERBS =
  /\b(submit|confirm|post|approve|authorize|authorise|delete|remove|close|void|reverse|transfer|disburse|pay|send|issue|finalize|finalise|commit|execute|apply|activate|deactivate|suspend|terminate)\b/i;

/** Labels that navigate or query without changing state. */
const READ_ONLY_VERBS =
  /\b(search|find|look ?up|view|show|display|open|next|previous|back|cancel|close window|return|home|refresh|print|export|download|acknowledge|ok|dismiss|continue)\b/i;

export interface RiskContext {
  /** Accessible or derived name of the control being acted on. */
  targetName?: string;
  /** Role of the control. Links are navigational far more often than buttons. */
  targetRole?: string;
}

export function classifyAction(action: Action, context: RiskContext = {}): RiskClass {
  switch (action.type) {
    case "navigate":
    case "wait_for":
    case "extract":
    case "press":
    case "done":
      return "read_only";

    case "type":
    case "select":
      // Filling a field changes the pending form, not the system of record.
      return "reversible_write";

    case "click": {
      const label = (context.targetName ?? "").trim();

      if (IRREVERSIBLE_VERBS.test(label)) return "irreversible_write";
      if (READ_ONLY_VERBS.test(label)) return "read_only";

      // A link almost always navigates; a link that commits something is a
      // design error on the application's part, and a rare one.
      if (context.targetRole === "link") return "read_only";

      // Anything else with a button role is an unknown commit. Assume it writes.
      return "reversible_write";
    }
  }
}

/** True when this class needs an explicit decision rather than a default. */
export function requiresConfirmation(risk: RiskClass): boolean {
  return risk === "irreversible_write";
}

export function riskRank(risk: RiskClass): number {
  return risk === "read_only" ? 0 : risk === "reversible_write" ? 1 : 2;
}

export function maxRisk(a: RiskClass, b: RiskClass): RiskClass {
  return riskRank(a) >= riskRank(b) ? a : b;
}
