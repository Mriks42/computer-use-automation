/**
 * A capability with a designed human decision point.
 *
 * Escalation is not only an error path. Some back-office flows legitimately
 * require a person — a judgement call on an ambiguous match, a four-eyes check
 * before an irreversible posting — and a capability that models that explicitly
 * is safer than one that pretends to be fully autonomous and gets overridden in
 * practice.
 *
 * The scenario: the flow searches for a member, then stops and asks an operator
 * to pick the correct record from the results. That is deliberately a task the
 * automation cannot do for itself, which makes it a real test of the handoff
 * rather than a pause that could have been skipped. The step that follows reads
 * the savings balance from wherever the operator left the session — so if
 * control transfer does not genuinely work, the run cannot complete.
 *
 * Note the escalate step carries a checkpoint. Automation does not take the
 * operator's word for it: on resume it re-observes and asserts that the session
 * actually reached the member detail screen.
 */

import { parseCapability, SCHEMA_VERSION, type Capability } from "../../src/capability/schema.js";
import { MERIDIAN_PROFILE } from "../../src/capability/profiles.js";
import type { LocatorDescriptor } from "../../src/surface/locator.js";

const labelled = (labelText: string, role: string, description: string): LocatorDescriptor => ({
  description,
  frame: "main",
  strategies: [{ kind: "label_adjacent", labelText, targetRole: role, exact: false }],
  confidence: "medium",
  rationale: "field has no accessible name; identified by the visible text beside it",
});

const named = (role: string, name: string, description: string): LocatorDescriptor => ({
  description,
  frame: "main",
  strategies: [{ kind: "role_name", role, name, exact: true }],
  confidence: "high",
  rationale: "accessible name is unique for this role on the screen",
});

export function escalatingCapability(entryPoint: string): Capability {
  return parseCapability({
    schemaVersion: SCHEMA_VERSION,
    id: "member.savings_balance.assisted_read",
    version: "1.0.0",
    name: "Read member savings balance (operator-assisted)",
    description:
      "Searches for a member, asks a human operator to select the correct record, then reads the savings balance from the record they chose.",

    surface: { kind: "web", app: "meridian-core", entryPoint },

    tenant: {
      product: "meridian-core",
      recordedOnTenant: "riverside-cu",
      verifiedTenants: ["riverside-cu"],
      overrides: {},
    },

    inputs: [
      {
        name: "memberId",
        type: "string",
        required: true,
        description: "The member number to search for.",
        sensitivity: "pii",
        pattern: "^[0-9]{5}$",
      },
    ],

    outputs: [
      {
        name: "savingsBalance",
        type: "currency",
        description: "Current balance of the savings share account on the selected record.",
        required: true,
        sensitivity: "internal",
      },
    ],

    steps: [
      {
        id: "s1_enter_operator_id",
        intent: "Enter the operator ID to sign on.",
        action: {
          kind: "type",
          target: labelled("Operator ID", "textbox", "Operator ID field"),
          value: { kind: "secret", ref: "MERIDIAN_USERNAME" },
          clearFirst: true,
        },
        skipIf: { kind: "text_absent", text: "Operator Sign On" },
        recovery: [],
        riskClass: "reversible_write",
        timeoutMs: 15000,
      },
      {
        id: "s2_enter_password",
        intent: "Enter the operator password to sign on.",
        action: {
          kind: "type",
          target: labelled("Password", "textbox", "Password field"),
          value: { kind: "secret", ref: "MERIDIAN_PASSWORD" },
          clearFirst: true,
        },
        skipIf: { kind: "text_absent", text: "Operator Sign On" },
        recovery: [],
        riskClass: "reversible_write",
        timeoutMs: 15000,
      },
      {
        id: "s3_sign_on",
        intent: "Submit the sign-on form.",
        action: { kind: "click", target: named("button", "Sign On", "Sign On button") },
        skipIf: { kind: "text_absent", text: "Operator Sign On" },
        checkpoint: { kind: "text_present", text: "Select a function from the navigation panel" },
        recovery: [],
        riskClass: "read_only",
        timeoutMs: 15000,
      },
      {
        id: "s4_open_member_search",
        intent: "Open the member search screen.",
        action: { kind: "click", target: named("link", "Member Search", "Member Search link") },
        checkpoint: { kind: "text_present", text: "Member ID or Last Name" },
        recovery: [],
        riskClass: "read_only",
        timeoutMs: 15000,
      },
      {
        id: "s5_enter_member_id",
        intent: "Enter the member number supplied by the caller.",
        action: {
          kind: "type",
          target: labelled("Member ID or Last Name", "textbox", "Member search field"),
          value: { kind: "param", param: "memberId" },
          clearFirst: true,
        },
        recovery: [],
        riskClass: "reversible_write",
        timeoutMs: 15000,
      },
      {
        id: "s6_run_search",
        intent: "Run the search.",
        action: { kind: "click", target: named("button", "Search", "Search button") },
        checkpoint: { kind: "text_present", text: "record(s) matched" },
        recovery: [],
        riskClass: "read_only",
        timeoutMs: 15000,
      },
      {
        id: "s7_operator_selects_record",
        intent:
          "Ask a human operator to select the correct member record from the search results, then continue from whatever record they opened.",
        action: {
          kind: "escalate",
          reason: "Selecting the correct record from search results requires operator judgement.",
          suggestedAction:
            "Review the search results in the live session, open the correct member record, then hand control back.",
        },
        // Automation does not take the operator's word for it. On resume it
        // re-observes and asserts the session actually reached the detail screen.
        checkpoint: { kind: "text_present", text: "Share Accounts" },
        recovery: [],
        riskClass: "read_only",
        timeoutMs: 600000,
      },
      {
        id: "s8_read_savings_balance",
        intent: "Read the savings balance from the record the operator selected.",
        action: {
          kind: "extract",
          output: "savingsBalance",
          target: {
            description: "current balance cell in the Savings row",
            frame: "mainframe",
            strategies: [
              { kind: "row_anchored", anchorText: "Savings", targetRole: "cell", columnIndex: 2 },
            ],
            confidence: "medium",
            rationale:
              "the cell's text is the value being read, so it cannot identify itself; anchored to the row label and column position instead",
          },
        },
        recovery: [],
        riskClass: "read_only",
        timeoutMs: 15000,
      },
    ],

    successCondition: { kind: "text_present", text: "Share Accounts" },

    knownOutcomes: MERIDIAN_PROFILE.knownOutcomes,
    globalRecovery: MERIDIAN_PROFILE.globalRecovery,

    riskClass: "reversible_write",

    provenance: {
      recordedAt: "2026-01-01T00:00:00.000Z",
      recordedBy: "hand-authored-test-fixture",
      discoveryRunId: "none",
      humanEdited: true,
      notes: "Test fixture for the escalation and control-transfer path. Not produced by a discovery run.",
    },

    approval: { state: "draft" },
    stability: { attempts: 0, successes: 0, degradedResolutions: 0 },
  });
}
