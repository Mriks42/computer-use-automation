/**
 * A capability whose final step commits something irreversible.
 *
 * Every other fixture reads. This one opens a sub-account and submits it, so
 * the last step is a button labelled "Submit Request" — which the risk
 * classifier reads as `irreversible_write`, which puts it above the unattended
 * ceiling, which means policy must stop and ask a person rather than either
 * proceeding or failing.
 *
 * That path existed in the code and was covered by unit tests at the
 * classification level, but nothing exercised it end to end. A guardrail that
 * has never fired against a real screen is a guardrail you are guessing about.
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

export function riskyCapability(entryPoint: string): Capability {
  return parseCapability({
    schemaVersion: SCHEMA_VERSION,
    id: "member.sub_account.open",
    version: "1.0.0",
    name: "Open a member sub-account",
    description:
      "Opens a new share sub-account for a member and submits the request. Commits a record: the final step is irreversible and requires authorization.",

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
        description: "The member number to open the sub-account for.",
        sensitivity: "pii",
        pattern: "^[0-9]{5}$",
      },
      {
        name: "accountType",
        type: "string",
        required: true,
        description: "Share account type to open.",
        sensitivity: "internal",
        enum: ["Savings", "Checking", "Certificate"],
      },
      {
        name: "initialDeposit",
        type: "currency",
        required: true,
        description: "Opening deposit. The application rejects anything under $25.00.",
        sensitivity: "internal",
      },
    ],

    outputs: [
      {
        name: "confirmationNumber",
        type: "string",
        description: "Reference for the submitted sub-account request.",
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
        id: "s7_open_member",
        intent: "Open the member's record.",
        action: {
          kind: "click",
          target: {
            description: "member number link in the results row",
            frame: "mainframe",
            strategies: [{ kind: "row_anchored", anchorParam: "memberId", targetRole: "link", columnIndex: 0 }],
            confidence: "medium",
            rationale: "the link text is caller-supplied data, so the row anchor identifies it instead",
          },
        },
        checkpoint: { kind: "text_present", text: "Share Accounts" },
        recovery: [],
        riskClass: "read_only",
        timeoutMs: 15000,
      },
      {
        id: "s8_open_sub_account_form",
        intent: "Open the sub-account request form.",
        action: { kind: "click", target: named("link", "Open Sub-Account", "Open Sub-Account link") },
        checkpoint: { kind: "text_present", text: "Account Type" },
        recovery: [],
        riskClass: "read_only",
        timeoutMs: 15000,
      },
      {
        id: "s9_choose_account_type",
        intent: "Choose the share account type the caller asked for.",
        action: {
          kind: "select",
          target: labelled("Account Type", "combobox", "Account type dropdown"),
          value: { kind: "param", param: "accountType" },
        },
        recovery: [],
        riskClass: "reversible_write",
        timeoutMs: 15000,
      },
      {
        id: "s10_enter_deposit",
        intent: "Enter the opening deposit.",
        action: {
          kind: "type",
          target: labelled("Initial Deposit", "textbox", "Initial deposit field"),
          value: { kind: "param", param: "initialDeposit" },
          clearFirst: true,
        },
        recovery: [],
        riskClass: "reversible_write",
        timeoutMs: 15000,
      },
      {
        /**
         * The irreversible one. Filling the form above changed nothing anybody
         * can see; this button commits the request and cannot be un-clicked.
         * Policy stops here and asks a person.
         */
        id: "s11_submit_request",
        intent: "Submit the sub-account request. This commits the record.",
        action: { kind: "click", target: named("button", "Submit Request", "Submit Request button") },
        checkpoint: { kind: "text_present", text: "Sub-account request recorded successfully" },
        recovery: [],
        riskClass: "irreversible_write",
        timeoutMs: 15000,
      },
      {
        id: "s12_read_confirmation",
        intent: "Read the confirmation number off the receipt screen.",
        action: {
          kind: "extract",
          output: "confirmationNumber",
          target: {
            description: "confirmation number cell",
            frame: "mainframe",
            strategies: [{ kind: "row_anchored", anchorText: "Confirmation Number:", targetRole: "cell", columnIndex: 1 }],
            confidence: "medium",
            rationale: "the cell holds the value being read, so it is anchored to its row label instead",
          },
        },
        recovery: [],
        riskClass: "read_only",
        timeoutMs: 15000,
      },
    ],

    successCondition: { kind: "text_present", text: "Sub-account request recorded successfully" },

    knownOutcomes: [
      ...MERIDIAN_PROFILE.knownOutcomes,
      {
        code: "DEPOSIT_BELOW_MINIMUM",
        description:
          "The application refused the opening deposit as below the product minimum. A validation result the caller needs, not a malfunction.",
        detect: { kind: "text_present", text: "Initial Deposit must be at least" },
        message: "The opening deposit is below the minimum required for this account type.",
        partialOutputs: [],
        verified: true,
      },
    ],
    globalRecovery: MERIDIAN_PROFILE.globalRecovery,

    riskClass: "irreversible_write",

    provenance: {
      recordedAt: "2026-01-01T00:00:00.000Z",
      recordedBy: "hand-authored-test-fixture",
      discoveryRunId: "none",
      humanEdited: true,
      notes: "Test fixture for the irreversible-action authorization path. Not produced by a discovery run.",
    },

    approval: { state: "draft" },
    stability: { attempts: 0, successes: 0, degradedResolutions: 0 },
  });
}
