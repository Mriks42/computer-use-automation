/**
 * A hand-authored capability used only by the integration tests.
 *
 * This is NOT the artifact a discovery run produces — the real one lives in
 * capabilities/ and is written by the recorder from a genuine model run. This
 * exists so the replay engine, the error taxonomy and the recovery rules can be
 * tested deterministically without spending a model call per test, and so that
 * a test failure points at the replay engine rather than at whatever the model
 * decided to do that afternoon.
 *
 * It is written against the same schema and goes through the same validation,
 * so it cannot drift away from the real format without the tests noticing.
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

export function fixtureCapability(entryPoint: string): Capability {
  return parseCapability({
    schemaVersion: SCHEMA_VERSION,
    id: "member.savings_balance.read",
    version: "1.0.0",
    name: "Read member savings balance",
    description:
      "Signs on to Meridian Core, looks up a member by member number, and returns the current balance of their savings share account.",

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
        description: "The member number to look up.",
        sensitivity: "pii",
        pattern: "^[0-9]{5}$",
      },
    ],

    outputs: [
      {
        name: "savingsBalance",
        type: "currency",
        description: "Current balance of the member's savings share account.",
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
          target: labelled("Operator ID", "textbox", "Operator ID field on the sign-on screen"),
          value: { kind: "secret", ref: "MERIDIAN_USERNAME" },
          clearFirst: true,
        },
        // Skipped when a session is already open, so the flow works from either
        // starting state.
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
          target: labelled("Password", "textbox", "Password field on the sign-on screen"),
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
        intent: "Submit the sign-on form to reach the operator desk.",
        action: { kind: "click", target: named("button", "Sign On", "Sign On button") },
        skipIf: { kind: "text_absent", text: "Operator Sign On" },
        checkpoint: { kind: "text_present", text: "Select a function from the navigation panel" },
        recovery: [],
        riskClass: "read_only",
        timeoutMs: 15000,
      },
      {
        id: "s4_open_member_search",
        intent: "Open the member search screen from the navigation panel.",
        action: { kind: "click", target: named("link", "Member Search", "Member Search navigation link") },
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
        intent: "Run the search to find the member record.",
        action: { kind: "click", target: named("button", "Search", "Search submit button") },
        checkpoint: { kind: "text_present", text: "record(s) matched" },
        recovery: [],
        riskClass: "read_only",
        timeoutMs: 15000,
      },
      {
        id: "s7_open_member",
        intent: "Open the matching member's record from the results grid.",
        action: {
          kind: "click",
          target: {
            description: "member number link in the results row for the requested member",
            frame: "mainframe",
            strategies: [
              {
                kind: "row_anchored",
                anchorParam: "memberId",
                targetRole: "link",
                columnIndex: 0,
              },
            ],
            confidence: "medium",
            rationale:
              "the link's own text is the member number, which is caller-supplied data; targeting by row anchor keeps the step independent of which member was recorded",
          },
        },
        checkpoint: { kind: "text_present", text: "Share Accounts" },
        recovery: [],
        riskClass: "read_only",
        timeoutMs: 15000,
      },
      {
        id: "s8_read_savings_balance",
        intent: "Read the current balance from the Savings row of the share accounts grid.",
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
      notes: "Test fixture. Not produced by a discovery run.",
    },

    approval: { state: "draft" },
    stability: { attempts: 0, successes: 0, degradedResolutions: 0 },
  });
}
