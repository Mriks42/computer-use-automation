/**
 * End-to-end replay against the real target application in a real browser.
 *
 * These are the tests that matter. Unit tests over the matcher and the policy
 * layer are cheap and worth having, but the claims this system makes — that a
 * recorded flow replays deterministically, that business outcomes are separated
 * from failures, that recovery rules clear interstitials, that session expiry is
 * classified rather than reported as a broken locator — are all claims about
 * behaviour against a live surface. Nothing short of driving one tests them.
 */

import { afterEach, describe, expect, it } from "vitest";
import { replay } from "../src/replay/executor.js";
import { fixtureCapability } from "./fixtures/capability.js";
import { TEST_SECRETS, testStack } from "./helpers/stack.js";

let stack: Awaited<ReturnType<typeof testStack>> | undefined;

afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

async function run(params: Record<string, unknown>, opts: { mode?: "attended" | "unattended" } = {}) {
  stack = await testStack();
  const capability = fixtureCapability(stack.origin);
  return {
    capability,
    stack,
    result: await replay({
      capability,
      params,
      surface: stack.surface,
      logger: stack.logger,
      handoff: stack.handoff,
      secrets: TEST_SECRETS,
      mode: opts.mode ?? "attended",
    }),
  };
}

describe("deterministic replay", () => {
  it("completes the flow and returns typed outputs", async () => {
    const { result } = await run({ memberId: "10001" });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    // Currency is returned as a number, not the formatted string, so a caller
    // can do arithmetic without reparsing.
    expect(result.outputs.savingsBalance).toBeCloseTo(8241.55, 2);
    expect(result.trace.every((t) => t.status !== "failed")).toBe(true);
  });

  it("produces the same outputs on a second run with the same inputs", async () => {
    const first = await run({ memberId: "10002" });
    await stack?.close();
    stack = undefined;
    const second = await run({ memberId: "10002" });

    expect(first.result.status).toBe("success");
    expect(second.result.status).toBe("success");
    if (first.result.status !== "success" || second.result.status !== "success") return;
    expect(second.result.outputs).toEqual(first.result.outputs);
  });

  it("follows the caller's input rather than the member recorded at discovery", async () => {
    // The fixture was authored against member 10001. Targeting is parameterized,
    // so a different member must work without any change to the artifact.
    const { result } = await run({ memberId: "10003" });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.outputs.savingsBalance).toBeCloseTo(15630.42, 2);
  });
});

describe("business outcomes are not failures", () => {
  it("reports a missing record as a business outcome with a code", async () => {
    const { result } = await run({ memberId: "99999" });

    expect(result.status).toBe("business_outcome");
    if (result.status !== "business_outcome") return;
    expect(result.code).toBe("RECORD_NOT_FOUND");
    expect(result.message).toMatch(/no record matched/i);
  });

  it("reports a restricted record as a business outcome, not an error", async () => {
    const { result } = await run({ memberId: "99001" });

    expect(result.status).toBe("business_outcome");
    if (result.status !== "business_outcome") return;
    expect(result.code).toBe("PERMISSION_DENIED");
  });
});

describe("recoverable conditions", () => {
  it("dismisses an unexpected interstitial and still completes", async () => {
    stack = await testStack();
    const capability = fixtureCapability(stack.origin);
    await stack.inject({ interstitial: true });

    const result = await replay({
      capability,
      params: { memberId: "10001" },
      surface: stack.surface,
      logger: stack.logger,
      handoff: stack.handoff,
      secrets: TEST_SECRETS,
    });

    expect(result.status).toBe("success");
    // The interstitial must show up in the trace. A recovery that succeeds
    // silently is indistinguishable from one that never fired.
    const recovered = result.trace.some((t) => t.recoveriesApplied?.includes("dismiss_system_notice"));
    expect(recovered).toBe(true);
  });
});

describe("hard failures are classified, not generic", () => {
  it("classifies a mid-flow session expiry as session_expired", async () => {
    stack = await testStack();
    const capability = fixtureCapability(stack.origin);
    // Expire after sign-on, while the flow is already in progress.
    await stack.inject({ sessionTimeoutAfter: 5 });

    const result = await replay({
      capability,
      params: { memberId: "10001" },
      surface: stack.surface,
      logger: stack.logger,
      handoff: stack.handoff,
      secrets: TEST_SECRETS,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.class).toBe("session_expired");
    // The failure has to say where it happened and what was expected, or it is
    // not debuggable.
    expect(result.failure.stepId).toBeTruthy();
    expect(result.failure.expected).toBeTruthy();
    expect(result.failure.observed).toBeTruthy();
  });

  it("classifies an application error page as surface_error", async () => {
    stack = await testStack();
    const capability = fixtureCapability(stack.origin);
    await stack.inject({ appError: true });

    const result = await replay({
      capability,
      params: { memberId: "10001" },
      surface: stack.surface,
      logger: stack.logger,
      handoff: stack.handoff,
      secrets: TEST_SECRETS,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.class).toBe("surface_error");
  });

  it("captures evidence on failure", async () => {
    stack = await testStack();
    const capability = fixtureCapability(stack.origin);
    await stack.inject({ appError: true });

    const result = await replay({
      capability,
      params: { memberId: "10001" },
      surface: stack.surface,
      logger: stack.logger,
      handoff: stack.handoff,
      secrets: TEST_SECRETS,
    });

    if (result.status !== "failure") throw new Error("expected a failure");
    expect(result.failure.evidence?.screenshot).toMatch(/\.png$/);
    expect(result.failure.evidence?.raw).toMatch(/\.html$/);
  });
});

describe("the contract is enforced before anything is touched", () => {
  it("rejects a parameter that fails its declared pattern without acting", async () => {
    const { result } = await run({ memberId: "not-a-member" });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.class).toBe("input_invalid");
    expect(result.trace).toHaveLength(0);
    // The rejected value must not be echoed back — it may be the regulated data.
    expect(JSON.stringify(result.failure)).not.toContain("not-a-member");
  });

  it("refuses unattended invocation of a draft artifact", async () => {
    const { result } = await run({ memberId: "10001" }, { mode: "unattended" });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.class).toBe("not_approved");
  });

  it("allows unattended invocation once approved", async () => {
    stack = await testStack();
    const capability = {
      ...fixtureCapability(stack.origin),
      approval: { state: "approved" as const, approvedBy: "reviewer", approvedAt: "2026-01-01T00:00:00.000Z" },
    };

    const result = await replay({
      capability,
      params: { memberId: "10001" },
      surface: stack.surface,
      logger: stack.logger,
      handoff: stack.handoff,
      secrets: TEST_SECRETS,
      mode: "unattended",
    });

    expect(result.status).toBe("success");
  });
});
