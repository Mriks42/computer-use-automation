/**
 * Irreversible actions, against a live browser.
 *
 * The claim: an action that commits something cannot happen unattended. It is
 * not denied — some capabilities exist precisely to commit things — but it
 * stops and becomes a question for a person, carrying the screen it would have
 * acted on.
 *
 * The distinction being tested is *reversible from not*, which is the one that
 * matters operationally. Steps 9 and 10 fill in a form: writes, but nothing has
 * happened and the form can be abandoned. Step 11 clicks "Submit Request",
 * which cannot be un-clicked. Only that step stops.
 *
 * The three cases below are the three things that can happen at that point:
 * nobody is available, someone approves, someone refuses.
 */

import { afterEach, describe, expect, it } from "vitest";
import { replay } from "../src/replay/executor.js";
import { classifyAction } from "../src/policy/risk.js";
import { riskyCapability } from "./fixtures/risky-capability.js";
import { TEST_SECRETS, testStack } from "./helpers/stack.js";

let stack: Awaited<ReturnType<typeof testStack>> | undefined;

afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

const PARAMS = { memberId: "10001", accountType: "Savings", initialDeposit: "500" };

describe("irreversible actions require authorization", () => {
  it("refuses to commit when no approver is configured", async () => {
    // The safe default. Unattended means nobody is there to say no, so the
    // answer to "may I commit this?" has to be no.
    stack = await testStack();
    const capability = riskyCapability(stack.origin);

    const result = await replay({
      capability,
      params: PARAMS,
      surface: stack.surface,
      logger: stack.logger,
      handoff: stack.handoff,
      secrets: TEST_SECRETS,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.class).toBe("confirmation_denied");

    // It got all the way to the commit step before stopping — the read and
    // form-filling steps were not blocked, only the one that commits.
    const reached = result.trace.map((t) => t.stepId);
    expect(reached).toContain("s10_enter_deposit");
    expect(reached).not.toContain("s12_read_confirmation");
  });

  it("commits once a person authorizes it, and returns the confirmation", async () => {
    let asked: { risk: string; sawScreen: boolean } | undefined;

    stack = await testStack({
      onConfirmationRequired: async (_action, decision, observation) => {
        // The approver is handed the risk class and the screen the action
        // would have been taken on. Deciding without those is rubber-stamping.
        asked = {
          risk: decision.risk,
          sawScreen: (observation?.text ?? "").includes("Open Sub-Account"),
        };
        return { approved: true, note: "reviewed the form; deposit and type are correct" };
      },
    });

    const result = await replay({
      capability: riskyCapability(stack.origin),
      params: PARAMS,
      surface: stack.surface,
      logger: stack.logger,
      handoff: stack.handoff,
      secrets: TEST_SECRETS,
    });

    expect(asked?.risk).toBe("irreversible_write");
    expect(asked?.sawScreen).toBe(true);

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(String(result.outputs.confirmationNumber)).toMatch(/^SA-\d+$/);
  });

  it("does not commit when a person refuses", async () => {
    stack = await testStack({
      onConfirmationRequired: async () => ({
        approved: false,
        note: "member has a pending dispute; do not open further accounts",
      }),
    });

    const result = await replay({
      capability: riskyCapability(stack.origin),
      params: PARAMS,
      surface: stack.surface,
      logger: stack.logger,
      handoff: stack.handoff,
      secrets: TEST_SECRETS,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.class).toBe("confirmation_denied");
    // The refusal reaches the caller with the reviewer's reasoning attached.
    expect(result.failure.observed).toMatch(/pending dispute/);
  });

  it("only stops on the step that commits, not on the ones that fill the form", () => {
    // Pure classification, stated as a claim rather than left implicit in the
    // run above: filling a field is a write, but nothing has happened yet.
    expect(classifyAction({ type: "type", ref: "r", text: "500" })).toBe("reversible_write");
    expect(classifyAction({ type: "select", ref: "r", value: "Savings" })).toBe("reversible_write");
    expect(
      classifyAction({ type: "click", ref: "r" }, { targetName: "Submit Request", targetRole: "button" }),
    ).toBe("irreversible_write");
    expect(
      classifyAction({ type: "click", ref: "r" }, { targetName: "Open Sub-Account", targetRole: "link" }),
    ).toBe("read_only");
  });
});

describe("validation results are business outcomes", () => {
  it("reports a below-minimum deposit as an outcome, not a crash", async () => {
    // The application refuses deposits under $25. That is an answer the caller
    // needs — the request was well-formed and the product rejected it.
    stack = await testStack({
      onConfirmationRequired: async () => ({ approved: true, note: "approved" }),
    });

    const result = await replay({
      capability: riskyCapability(stack.origin),
      params: { ...PARAMS, initialDeposit: "5" },
      surface: stack.surface,
      logger: stack.logger,
      handoff: stack.handoff,
      secrets: TEST_SECRETS,
    });

    expect(result.status).toBe("business_outcome");
    if (result.status !== "business_outcome") return;
    expect(result.code).toBe("DEPOSIT_BELOW_MINIMUM");
  });
});
