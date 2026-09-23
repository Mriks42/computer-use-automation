/**
 * The human handoff, end to end, against a live browser.
 *
 * The claim being tested is narrow and specific: automation pauses mid-flow, a
 * person takes over **the session the automation was already driving**, does
 * something the automation could not do for itself, hands control back, and the
 * run resumes and completes using the state they left behind.
 *
 * That is deliberately harder to satisfy than "an intervention object was
 * created". The operator here navigates to a screen the replay never visited,
 * and the very next step reads a value that only exists on that screen. If
 * control transfer were cosmetic — a fresh session, or a flag nobody enforces —
 * the run could not finish.
 *
 * The operator is simulated by driving the raw Playwright page directly, which
 * is exactly what a person at the keyboard does: act on the browser from
 * outside the lease.
 */

import { afterEach, describe, expect, it } from "vitest";
import { replay } from "../src/replay/executor.js";
import { ControlViolationError } from "../src/escalation/lease.js";
import type { InterventionRequest, InterventionStore } from "../src/escalation/intervention.js";
import { escalatingCapability } from "./fixtures/escalating-capability.js";
import { TEST_SECRETS, testStack } from "./helpers/stack.js";

let stack: Awaited<ReturnType<typeof testStack>> | undefined;

afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

/** Poll until the run raises an intervention, the way a console would. */
async function waitForOpenIntervention(
  store: InterventionStore,
  timeoutMs = 30_000,
): Promise<InterventionRequest> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = store.list("open")[0];
    if (open) return open;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no intervention was raised within the timeout");
}

describe("human-in-the-loop handoff", () => {
  it("pauses, lets a human drive the same session, and resumes from where they left it", async () => {
    stack = await testStack();
    const capability = escalatingCapability(stack.origin);

    const running = replay({
      capability,
      params: { memberId: "10001" },
      surface: stack.surface,
      logger: stack.logger,
      handoff: stack.handoff,
      secrets: TEST_SECRETS,
    });

    const request = await waitForOpenIntervention(stack.interventions);

    // --- The request has to be actionable on its own ---------------------
    expect(request.kind).toBe("risky_action_confirmation");
    expect(request.capabilityId).toBe("member.savings_balance.assisted_read");
    expect(request.stepId).toBe("s7_operator_selects_record");
    expect(request.reason).toMatch(/operator judgement/i);
    expect(request.suggestedAction).toMatch(/open the correct member record/i);
    // Context captured at the moment of escalation, before standing down.
    expect(request.context.screenshotPath).toMatch(/\.png$/);
    expect(request.context.textExcerpt).toMatch(/record\(s\) matched/);

    // --- Automation has genuinely stood down ------------------------------
    expect(stack.broker.current).toBe("pending_human");
    // Not a flag anyone politely checks: the surface refuses.
    await expect(stack.surface.act({ type: "press", key: "Escape" })).rejects.toThrow(
      ControlViolationError,
    );

    // --- An operator arrives ----------------------------------------------
    stack.handoff.takeControl(request.id, "operator-jane");
    expect(stack.broker.current).toBe("human");

    // --- They drive the SAME live session ---------------------------------
    // The session is already signed on and sitting on search results. A fresh
    // browser would be on the sign-on page and this would fail.
    const page = stack.adapter.livePage();
    const contentFrame = page.frames().find((f) => f.name() === "mainframe");
    expect(contentFrame, "the automation's content frame should still be live").toBeTruthy();
    expect(contentFrame!.url()).toContain("/search/results");

    await contentFrame!.click('a:has-text("10001")');
    await contentFrame!.waitForLoadState("domcontentloaded");

    // --- And hand control back --------------------------------------------
    await stack.handoff.returnControl(request.id, {
      actor: "operator-jane",
      note: "Selected member 10001 from the two candidate records.",
      decision: "approved",
    });

    const result = await running;

    // --- The run completed from the state the operator left ---------------
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.outputs.savingsBalance).toBeCloseTo(8241.55, 2);

    // --- The handoff is recorded ------------------------------------------
    const resolved = stack.interventions.get(request.id)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution?.actor).toBe("operator-jane");
    expect(resolved.resolution?.humanActions.length).toBeGreaterThan(0);

    const clicked = resolved.resolution!.humanActions.find((a) => a.type === "click");
    expect(clicked, "the operator's click should have been captured").toBeTruthy();

    // --- The audit trail names who held the session, and when -------------
    const history = stack.broker.state().history.map((h) => h.to);
    expect(history).toEqual(["pending_human", "human", "automation"]);
    expect(stack.broker.state().history[1]!.actor).toBe("operator-jane");
  });

  it("records what the operator did without recording what they typed", async () => {
    stack = await testStack();
    const capability = escalatingCapability(stack.origin);

    const running = replay({
      capability,
      params: { memberId: "10001" },
      surface: stack.surface,
      logger: stack.logger,
      handoff: stack.handoff,
      secrets: TEST_SECRETS,
    });

    const request = await waitForOpenIntervention(stack.interventions);
    stack.handoff.takeControl(request.id, "operator-sam");

    const page = stack.adapter.livePage();
    const contentFrame = page.frames().find((f) => f.name() === "mainframe")!;
    await contentFrame.click('a:has-text("10001")');
    await contentFrame.waitForLoadState("domcontentloaded");

    await stack.handoff.returnControl(request.id, {
      actor: "operator-sam",
      note: "Opened the member record.",
      decision: "approved",
    });
    await running;

    const actions = stack.interventions.get(request.id)!.resolution!.humanActions;

    // Every action names the control it touched, so the trail is reviewable.
    expect(actions.every((a) => typeof a.at === "string")).toBe(true);
    expect(actions.some((a) => (a.target ?? "").length > 0)).toBe(true);

    // But no action carries a value. Recording what an operator typed into a
    // member record would defeat the entire redaction layer.
    for (const action of actions) {
      expect(action).not.toHaveProperty("value");
      expect(JSON.stringify(action)).not.toContain("demo-pass-2024");
    }
  });

  it("ends the run when the operator aborts instead of handing control back", async () => {
    stack = await testStack();
    const capability = escalatingCapability(stack.origin);

    const running = replay({
      capability,
      params: { memberId: "10001" },
      surface: stack.surface,
      logger: stack.logger,
      handoff: stack.handoff,
      secrets: TEST_SECRETS,
    });

    const request = await waitForOpenIntervention(stack.interventions);
    stack.handoff.takeControl(request.id, "operator-rae");

    await stack.handoff.returnControl(request.id, {
      actor: "operator-rae",
      note: "Neither candidate record is the right member; escalating to the branch.",
      decision: "rejected",
    });

    const result = await running;

    // An abort is a failure of the run, not a success and not a business
    // outcome — the caller's question was never answered.
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.stepId).toBe("s7_operator_selects_record");
    expect(stack.broker.current).toBe("released");
    expect(stack.interventions.get(request.id)!.status).toBe("aborted");
  });
});
