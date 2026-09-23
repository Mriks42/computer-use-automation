/**
 * Unit tests for the pieces whose correctness is not obvious by inspection and
 * whose failure modes are quiet: locator matching, redaction, risk
 * classification, allowlist enforcement, and the control lease.
 *
 * Quiet is the operative word. A broken locator throws a visible error. A
 * redactor that silently stops matching tax IDs, or an allowlist that stops
 * denying a path, fails by doing nothing at all — which is exactly the kind of
 * regression that survives to production.
 */

import { describe, expect, it } from "vitest";

import { matchStrategy, normalizeText } from "../src/surface/matcher.js";
import { bindStrategy, scoreConfidence, normalizeLadder } from "../src/surface/locator.js";
import { Redactor } from "../src/policy/redact.js";
import { classifyAction } from "../src/policy/risk.js";
import { Allowlist } from "../src/policy/allowlist.js";
import { ControlBroker, ControlViolationError } from "../src/escalation/lease.js";
import { evaluateCheckpoint, classifySurfaceCondition } from "../src/replay/checkpoint.js";
import { interpolate } from "../src/capability/schema.js";
import type { Observation, UiElement } from "../src/surface/types.js";

// ---------------------------------------------------------------------------

function element(overrides: Partial<UiElement> & { ref: string; role: string }): UiElement {
  return {
    name: "",
    visible: true,
    context: { frame: "main", roleIndex: 0 },
    ...overrides,
  } as UiElement;
}

function observation(elements: UiElement[], text = ""): Observation {
  return {
    surface: { kind: "web", app: "test", entryPoint: "http://localhost" },
    location: "http://localhost/screen",
    title: "Screen",
    elements,
    text,
    signals: [],
    capturedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------

describe("locator matching", () => {
  it("treats a trailing colon on a label as insignificant", () => {
    // Back-office layouts render labels as "Member ID:" in a neighbouring cell.
    // A flow should not break over the punctuation.
    expect(normalizeText("Member ID or Last Name:")).toBe("member id or last name");
    expect(normalizeText("  MEMBER   ID  ")).toBe("member id");
  });

  it("matches an unlabelled field by the text beside it", () => {
    const obs = observation([
      element({ ref: "a", role: "textbox", derivedName: "Operator ID:" }),
      element({ ref: "b", role: "textbox", derivedName: "Password:" }),
    ]);

    const matches = matchStrategy(obs, {
      kind: "label_adjacent",
      labelText: "Operator ID",
      targetRole: "textbox",
      exact: false,
    });

    expect(matches.map((m) => m.ref)).toEqual(["a"]);
  });

  it("returns every match so the caller can refuse ambiguity", () => {
    // Two identically named buttons must not silently resolve to the first.
    const obs = observation([
      element({ ref: "a", role: "button", name: "Submit" }),
      element({ ref: "b", role: "button", name: "Submit" }),
    ]);

    const matches = matchStrategy(obs, { kind: "role_name", role: "button", name: "Submit", exact: true });
    expect(matches).toHaveLength(2);
  });

  it("disambiguates identical names by enclosing region", () => {
    const obs = observation([
      element({ ref: "a", role: "button", name: "Search", context: { frame: "main", region: "Members", roleIndex: 0 } }),
      element({ ref: "b", role: "button", name: "Search", context: { frame: "main", region: "Accounts", roleIndex: 1 } }),
    ]);

    const matches = matchStrategy(obs, {
      kind: "role_name_in_region",
      role: "button",
      name: "Search",
      region: "Accounts",
      exact: true,
    });

    expect(matches.map((m) => m.ref)).toEqual(["b"]);
  });

  it("finds a cell by its row anchor and column index", () => {
    const obs = observation([
      element({ ref: "s", role: "cell", name: "$8,241.55", context: { frame: "main", rowAnchor: "Savings", columnIndex: 2, roleIndex: 0 } }),
      element({ ref: "c", role: "cell", name: "$1,902.13", context: { frame: "main", rowAnchor: "Checking", columnIndex: 2, roleIndex: 1 } }),
    ]);

    const matches = matchStrategy(obs, {
      kind: "row_anchored",
      anchorText: "Savings",
      targetRole: "cell",
      columnIndex: 2,
    });

    expect(matches.map((m) => m.ref)).toEqual(["s"]);
  });

  it("binds a row anchor from an invocation parameter", () => {
    const bound = bindStrategy(
      { kind: "row_anchored", anchorParam: "memberId", targetRole: "link", columnIndex: 0 },
      { memberId: "10002" },
    );
    expect(bound).toMatchObject({ anchorText: "10002" });
  });

  it("refuses to bind anything other than a row anchor", () => {
    // Widening what a caller can steer widens what an attacker can steer.
    const strategy = { kind: "role_name", role: "button", name: "Sign On", exact: true } as const;
    expect(bindStrategy(strategy, { name: "Delete" })).toEqual(strategy);
  });

  it("scores confidence from the strongest available rung", () => {
    expect(scoreConfidence([{ kind: "role_name", role: "button", name: "Go", exact: true }])).toBe("high");
    expect(scoreConfidence([{ kind: "nth_of_role", role: "textbox", index: 2 }])).toBe("low");
    // A weak best rung is not rescued by having many fallbacks beneath it.
    expect(
      scoreConfidence([
        { kind: "nth_of_role", role: "textbox", index: 2 },
        { kind: "css", selector: "#x" },
      ]),
    ).toBe("low");
  });

  it("orders a ladder strongest-first regardless of insertion order", () => {
    const ladder = normalizeLadder([
      { kind: "nth_of_role", role: "button", index: 0 },
      { kind: "role_name", role: "button", name: "Go", exact: true },
    ]);
    expect(ladder[0]!.kind).toBe("role_name");
  });
});

// ---------------------------------------------------------------------------

describe("redaction", () => {
  it("masks tax IDs that arrive from the application, not from us", () => {
    const redactor = new Redactor();
    expect(redactor.redact("Tax ID: 412-55-9034")).toBe("Tax ID: <redacted:ssn>");
  });

  it("masks registered secrets by label so the reader knows what was removed", () => {
    const redactor = new Redactor();
    redactor.register("demo-pass-2024", "MERIDIAN_PASSWORD");
    expect(redactor.redact("signing on with demo-pass-2024")).toBe(
      "signing on with <redacted:MERIDIAN_PASSWORD>",
    );
  });

  it("does not mask long numbers that are not card numbers", () => {
    // Account numbers are 10 digits and fail Luhn; masking every long number
    // would make logs useless.
    const redactor = new Redactor();
    expect(redactor.redact("Account 4410029947")).toContain("4410029947");
  });

  it("masks a value that passes Luhn", () => {
    const redactor = new Redactor();
    expect(redactor.redact("card 4242424242424242")).toBe("card <redacted:card>");
  });

  it("redacts by declared classification, not by shape", () => {
    // A member ID matches no pattern at all. Classification is the only thing
    // that keeps it out of the log.
    const redactor = new Redactor();
    const out = redactor.redactParams(
      { memberId: "10001", branch: "Riverside" },
      { memberId: "pii", branch: "public" },
    );
    expect(out).toEqual({ memberId: "<redacted:memberId>", branch: "Riverside" });
  });

  it("redacts recursively through nested structures", () => {
    const redactor = new Redactor();
    const out = redactor.redactValue({ a: [{ b: "ssn 412-55-9034" }] });
    expect(JSON.stringify(out)).toContain("<redacted:ssn>");
  });
});

// ---------------------------------------------------------------------------

describe("risk classification", () => {
  it("treats a commit verb as irreversible", () => {
    expect(classifyAction({ type: "click", ref: "r" }, { targetName: "Submit Request", targetRole: "button" })).toBe(
      "irreversible_write",
    );
    expect(classifyAction({ type: "click", ref: "r" }, { targetName: "Post Transaction", targetRole: "button" })).toBe(
      "irreversible_write",
    );
  });

  it("treats navigation and query verbs as read-only", () => {
    expect(classifyAction({ type: "click", ref: "r" }, { targetName: "Search", targetRole: "button" })).toBe("read_only");
    expect(classifyAction({ type: "click", ref: "r" }, { targetName: "Acknowledge", targetRole: "button" })).toBe("read_only");
  });

  it("assumes an unrecognised button writes", () => {
    // Failing toward caution: an unknown control is not assumed harmless.
    expect(classifyAction({ type: "click", ref: "r" }, { targetName: "Zorp", targetRole: "button" })).toBe(
      "reversible_write",
    );
  });

  it("treats filling a field as reversible, since nothing is committed yet", () => {
    expect(classifyAction({ type: "type", ref: "r", text: "x" })).toBe("reversible_write");
  });
});

// ---------------------------------------------------------------------------

describe("allowlist", () => {
  const allowlist = new Allowlist({
    allowedOrigins: ["http://127.0.0.1:4600"],
    allowedPaths: ["^/search", "^/member/"],
    deniedPaths: ["^/control/", "^/logout"],
  });

  it("denies the fault-injection plane even though the origin is allowed", () => {
    // This is the case an origin-only allowlist would let through.
    const decision = allowlist.checkLocation("http://127.0.0.1:4600/control/inject");
    expect(decision.effect).toBe("deny");
    expect(decision.rule).toContain("deny");
  });

  it("denies a path that is not on the allowlist", () => {
    expect(allowlist.checkLocation("http://127.0.0.1:4600/admin/users").effect).toBe("deny");
  });

  it("denies another origin entirely", () => {
    expect(allowlist.checkLocation("http://evil.example.com/search").effect).toBe("deny");
  });

  it("denies non-http protocols", () => {
    expect(allowlist.checkLocation("file:///etc/passwd").effect).toBe("deny");
  });

  it("allows a permitted path", () => {
    expect(allowlist.checkLocation("http://127.0.0.1:4600/member/10001").effect).toBe("allow");
  });

  it("asks for confirmation rather than denying an irreversible action", () => {
    // Refusing outright would make it impossible to build capabilities that
    // legitimately commit something.
    const decision = allowlist.checkAction({ type: "click", ref: "r" }, "irreversible_write");
    expect(decision.effect).toBe("confirm");
  });
});

// ---------------------------------------------------------------------------

describe("session control lease", () => {
  it("refuses an action from whoever does not hold the lease", () => {
    const broker = new ControlBroker("s1");
    broker.requestHuman("stuck");
    broker.takeControl("operator-1");

    expect(() => broker.assertControl("automation")).toThrow(ControlViolationError);
  });

  it("walks the full handoff cycle and records every transition", () => {
    const broker = new ControlBroker("s1");
    broker.requestHuman("needs a person");
    expect(broker.current).toBe("pending_human");

    broker.takeControl("operator-1");
    expect(broker.current).toBe("human");

    broker.returnControl("did the thing");
    expect(broker.current).toBe("automation");

    // The audit trail is the point: who held the session, when, and why.
    const history = broker.state().history;
    expect(history.map((h) => h.to)).toEqual(["pending_human", "human", "automation"]);
    expect(history[1]!.actor).toBe("operator-1");
  });

  it("models the gap between standing down and a person arriving", () => {
    // pending_human exists precisely because nobody is driving during it.
    const broker = new ControlBroker("s1");
    broker.requestHuman("stuck");
    expect(() => broker.assertControl("automation")).toThrow();
    expect(() => broker.assertControl("human")).toThrow();
  });

  it("refuses out-of-order transitions", () => {
    const broker = new ControlBroker("s1");
    expect(() => broker.takeControl("operator-1")).toThrow();
    expect(() => broker.returnControl("nope")).toThrow();
  });

  it("resolves waiters when control comes back", async () => {
    const broker = new ControlBroker("s1");
    broker.requestHuman("stuck");
    const waiting = broker.waitForAutomation(2_000);
    broker.takeControl("operator-1");
    broker.returnControl("done");
    await expect(waiting).resolves.toBe("resumed");
  });
});

// ---------------------------------------------------------------------------

describe("checkpoints", () => {
  const ctx = (text: string) => ({
    observation: observation([], text),
    params: { memberId: "10001" },
    resolveLocator: async () => undefined,
  });

  it("interpolates parameters into the asserted text", async () => {
    const result = await evaluateCheckpoint(
      { kind: "text_present", text: "Member Detail — {memberId}" },
      ctx("Member Detail — 10001"),
    );
    expect(result.passed).toBe(true);
  });

  it("reports what it saw when an assertion fails", async () => {
    const result = await evaluateCheckpoint(
      { kind: "text_present", text: "Share Accounts" },
      ctx("Access Denied. This record is restricted."),
    );
    expect(result.passed).toBe(false);
    expect(result.observed).toContain("Access Denied");
  });

  it("combines conditions", async () => {
    const both = await evaluateCheckpoint(
      {
        kind: "all",
        of: [
          { kind: "text_present", text: "Share" },
          { kind: "text_absent", text: "Denied" },
        ],
      },
      ctx("Share Accounts"),
    );
    expect(both.passed).toBe(true);
  });

  it("recognises a mid-flow sign-out as session expiry", () => {
    const condition = classifySurfaceCondition(
      observation([], "Your session has expired. Please sign on again."),
    );
    expect(condition?.class).toBe("session_expired");
  });

  it("recognises an application error page", () => {
    const condition = classifySurfaceCondition(
      observation([], "An unexpected error occurred while processing your request. Reference MC-5000."),
    );
    expect(condition?.class).toBe("surface_error");
  });

  it("does not see a condition on an ordinary screen", () => {
    // False positives here would derail healthy runs.
    expect(classifySurfaceCondition(observation([], "Member Detail — 10001. Share Accounts."))).toBeUndefined();
  });
});

describe("interpolation", () => {
  it("leaves unknown placeholders untouched rather than emptying them", () => {
    // Silently substituting an empty string turns "/member/{id}" into "/member/",
    // which is a different, valid-looking request.
    expect(interpolate("/member/{memberId}/{other}", { memberId: "10001" })).toBe("/member/10001/{other}");
  });
});

// ---------------------------------------------------------------------------

describe("artifacts never carry regulated data", () => {
  it("refuses to write an artifact containing a tax ID", async () => {
    // Regression. The first real discovery run derived a step checkpoint from
    // the most distinctive new line on the member detail screen — which was the
    // row containing the member's tax ID. Evidence writes were redacted, but
    // the artifact takes a different path to disk and was not.
    const { assertArtifactIsClean } = await import("../src/capability/recorder.js");
    const { fixtureCapability } = await import("./fixtures/capability.js");

    const leaky = fixtureCapability("http://127.0.0.1:4600");
    leaky.steps[6]!.checkpoint = {
      kind: "text_present",
      text: "Member Since: 2014-03-11 Tax ID: 412-55-9034",
    };

    expect(() => assertArtifactIsClean(leaky)).toThrow(/regulated data.*ssn/is);
  });

  it("accepts an artifact whose checkpoints assert only UI chrome", async () => {
    const { assertArtifactIsClean } = await import("../src/capability/recorder.js");
    const { fixtureCapability } = await import("./fixtures/capability.js");
    expect(() => assertArtifactIsClean(fixtureCapability("http://127.0.0.1:4600"))).not.toThrow();
  });
});
