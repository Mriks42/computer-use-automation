/**
 * Deterministic replay.
 *
 * This module does not import a model client, and that is the point. "No LLM in
 * the decision loop" is enforced structurally rather than by discipline — there
 * is no model to call from here even if a future change wanted one.
 *
 * The evaluation order inside every step is the most important thing in this
 * file, and it is always the same:
 *
 *   1. Did a declared business outcome occur?   → return it. Not an error.
 *   2. Is there a recovery rule for this state? → apply it and retry.
 *   3. Is this a known surface condition?       → classify it specifically.
 *   4. Otherwise                                → structured failure.
 *
 * Checking business outcomes first is what stops "no such member" from being
 * reported as a broken locator: on that screen the member row genuinely is not
 * present, so a targeting-first implementation would report locator_unresolved
 * and be both technically accurate and completely useless to the caller.
 */

import { performance } from "node:perf_hooks";
import {
  interpolate,
  type BusinessOutcomeSpec,
  type Capability,
  type RecoveryRule,
  type Step,
  type StepAction,
  type ValueSource,
} from "../capability/schema.js";
import { bindStrategy, describeStrategy, type LocatorDescriptor } from "../surface/locator.js";
import { classifySurfaceCondition, evaluateCheckpoint, type LocatorResolver } from "./checkpoint.js";
import { coerceOutput, type ReplayFailure, type ReplayResult, type StepTrace } from "./result.js";
import { ConfirmationDeniedError, PolicyViolationError } from "../policy/errors.js";
import type { HandoffCoordinator } from "../escalation/handoff.js";
import type { RunLogger } from "../evidence/logger.js";
import type { Observation, Surface } from "../surface/types.js";

export interface ReplayOptions {
  capability: Capability;
  params: Record<string, unknown>;
  surface: Surface;
  logger: RunLogger;
  handoff?: HandoffCoordinator;
  /** Resolved credential values, by secret name. Never written anywhere. */
  secrets?: Record<string, string>;
  /**
   * Unattended invocation is what an AI agent does in production, and it
   * requires an approved artifact. Attended invocation is a human running a
   * draft on purpose.
   */
  mode?: "attended" | "unattended";
  /** Retries for transient conditions — a slow load, a page mid-render. */
  transientRetries?: number;
  transientDelayMs?: number;
}

export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  const {
    capability,
    surface,
    logger,
    handoff,
    secrets = {},
    mode = "attended",
    transientRetries = 3,
    transientDelayMs = 600,
  } = options;

  for (const [name, value] of Object.entries(secrets)) logger.registerSecret(value, name);

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const trace: StepTrace[] = [];
  const outputs: Record<string, unknown> = {};
  let degradedResolutions = 0;

  const base = () => ({
    runId: logger.runId,
    capabilityId: capability.id,
    capabilityVersion: capability.version,
    startedAt,
    durationMs: Math.round(performance.now() - started),
    trace,
    evidenceDir: logger.dir,
    degradedResolutions,
  });

  const fail = async (failure: Omit<ReplayFailure, "evidence">): Promise<ReplayResult> => {
    let evidence: ReplayFailure["evidence"];
    try {
      const captured = await logger.capture(surface, `failure-${failure.class}`);
      evidence = { screenshot: captured.screenshot, raw: captured.raw };
    } catch {
      // Capture can itself fail if the surface is gone; the structured failure
      // is still worth returning.
    }
    logger.event("replay_failed", { ...failure });
    return { ...base(), status: "failure", failure: { ...failure, evidence } };
  };

  // ---- Input validation. Nothing is attempted until the contract holds. ----

  const params: Record<string, unknown> = {};
  for (const spec of capability.inputs) {
    const supplied = options.params[spec.name] ?? spec.default;
    if (supplied === undefined || supplied === "") {
      if (spec.required) {
        return fail({
          class: "input_invalid",
          expected: `parameter "${spec.name}" (${spec.type}) to be supplied`,
          observed: "missing",
          detail: spec.description,
          recoveryAttempted: [],
        });
      }
      continue;
    }
    const asString = String(supplied);
    if (spec.pattern && !new RegExp(spec.pattern).test(asString)) {
      return fail({
        class: "input_invalid",
        expected: `parameter "${spec.name}" to match /${spec.pattern}/`,
        // Never echo the offending value: it may be the regulated data itself.
        observed: `a ${asString.length}-character value that did not match`,
        detail: spec.description,
        recoveryAttempted: [],
      });
    }
    if (spec.enum && !spec.enum.includes(asString)) {
      return fail({
        class: "input_invalid",
        expected: `parameter "${spec.name}" to be one of ${spec.enum.join(", ")}`,
        observed: spec.sensitivity === "public" ? asString : "a value outside the permitted set",
        detail: spec.description,
        recoveryAttempted: [],
      });
    }
    if ((spec.type === "number" || spec.type === "currency") && Number.isNaN(Number(asString.replace(/[^0-9.-]/g, "")))) {
      return fail({
        class: "input_invalid",
        expected: `parameter "${spec.name}" to be numeric`,
        observed: "a non-numeric value",
        detail: spec.description,
        recoveryAttempted: [],
      });
    }
    params[spec.name] = asString;
  }

  if (mode === "unattended" && capability.approval.state !== "approved") {
    return fail({
      class: "not_approved",
      expected: "an approved artifact for unattended invocation",
      observed: `artifact is in state "${capability.approval.state}"`,
      detail:
        "Unattended replay is gated on human approval. Promote the artifact, or invoke it in attended mode.",
      recoveryAttempted: [],
    });
  }

  logger.event("replay_started", {
    capability: capability.id,
    version: capability.version,
    mode,
    params: Object.fromEntries(
      capability.inputs.map((spec) => [
        spec.name,
        spec.sensitivity === "pii" || spec.sensitivity === "secret"
          ? `<redacted:${spec.name}>`
          : params[spec.name],
      ]),
    ),
  });

  // ---- Locator resolution ------------------------------------------------

  /**
   * Walk the ladder. Returns the first rung that resolves to exactly one
   * element, along with which rung it was — the rung index is the drift signal.
   */
  const resolveWith = async (
    observation: Observation,
    locator: LocatorDescriptor,
  ): Promise<{ ref: string; rung: number; by: string } | undefined> => {
    for (let rung = 0; rung < locator.strategies.length; rung++) {
      const strategy = bindStrategy(locator.strategies[rung]!, params);
      const ref = await surface.resolve({ observation, strategy });
      if (ref) {
        if (rung > 0) {
          degradedResolutions++;
          logger.event("locator_degraded", {
            locator: locator.description,
            rung,
            strategy: describeStrategy(strategy),
            note: "a stronger strategy failed; this is a drift signal for this tenant's build",
          });
        }
        return { ref, rung, by: describeStrategy(strategy) };
      }
    }
    return undefined;
  };

  const makeResolver =
    (observation: Observation): LocatorResolver =>
    async (locator) => {
      const resolved = await resolveWith(observation, locator);
      return resolved ? { ref: resolved.ref, rung: resolved.rung } : undefined;
    };

  const checkpointCtx = (observation: Observation) => ({
    observation,
    params,
    resolveLocator: makeResolver(observation),
  });

  // ---- Business outcomes and recovery ------------------------------------

  const matchOutcome = async (observation: Observation): Promise<BusinessOutcomeSpec | undefined> => {
    for (const outcome of capability.knownOutcomes) {
      const result = await evaluateCheckpoint(outcome.detect, checkpointCtx(observation));
      if (result.passed) return outcome;
    }
    return undefined;
  };

  const recoveryUsage = new Map<string, number>();

  const matchRecovery = async (
    observation: Observation,
    step: Step | undefined,
  ): Promise<RecoveryRule | undefined> => {
    const rules = [...(step?.recovery ?? []), ...capability.globalRecovery];
    for (const rule of rules) {
      const used = recoveryUsage.get(rule.name) ?? 0;
      if (used >= rule.maxAttempts) continue;
      const result = await evaluateCheckpoint(rule.when, checkpointCtx(observation));
      if (result.passed) return rule;
    }
    return undefined;
  };

  // ---- Action execution --------------------------------------------------

  const resolveValue = (source: ValueSource): string | undefined => {
    switch (source.kind) {
      case "literal":
        return source.value;
      case "param": {
        const value = params[source.param];
        return value === undefined ? undefined : String(value);
      }
      case "secret": {
        const value = secrets[source.ref] ?? process.env[source.ref];
        return value;
      }
      case "step_output": {
        const value = outputs[source.stepId];
        return value === undefined ? undefined : String(value);
      }
    }
  };

  /** Execute one action. Returns a failure description, or undefined on success. */
  const performAction = async (
    action: StepAction,
    observation: Observation,
    step: Step,
  ): Promise<{ error: Omit<ReplayFailure, "evidence"> } | { resolved?: { rung: number; by: string } }> => {
    const failAt = (
      klass: ReplayFailure["class"],
      expected: string,
      observed: string,
      detail: string,
    ): { error: Omit<ReplayFailure, "evidence"> } => ({
      error: {
        class: klass,
        stepId: step.id,
        stepIndex: trace.length,
        intent: step.intent,
        expected,
        observed,
        detail,
        recoveryAttempted: [...recoveryUsage.keys()],
      },
    });

    switch (action.kind) {
      case "navigate": {
        await surface.act({ type: "navigate", url: interpolate(action.url, params) });
        return {};
      }

      case "press": {
        await surface.act({ type: "press", key: action.key });
        return {};
      }

      case "wait_for": {
        const deadline = Date.now() + action.timeoutMs;
        while (Date.now() < deadline) {
          const current = await surface.observe();
          const result = await evaluateCheckpoint(action.until, checkpointCtx(current));
          if (result.passed) return {};
          await delay(250);
        }
        return failAt("timeout", "the awaited condition to hold", "it did not within the timeout", `waited ${action.timeoutMs}ms`);
      }

      case "click":
      case "type":
      case "select": {
        const resolved = await resolveWith(observation, action.target);
        if (!resolved) {
          return failAt(
            "locator_unresolved",
            `to locate ${action.target.description}`,
            `no strategy resolved (tried: ${action.target.strategies.map(describeStrategy).join(" → ")})`,
            action.target.rationale ?? "",
          );
        }

        if (action.kind === "click") {
          await surface.act({ type: "click", ref: resolved.ref });
        } else {
          const value = resolveValue(action.value);
          if (value === undefined) {
            const label =
              action.value.kind === "secret"
                ? `secret "${action.value.ref}"`
                : action.value.kind === "param"
                  ? `parameter "${action.value.param}"`
                  : "a value";
            return failAt(
              "input_invalid",
              `${label} to be available`,
              "it was not supplied or could not be resolved from the environment",
              action.value.kind === "secret"
                ? "Set this secret in the environment before replaying."
                : "",
            );
          }
          if (action.kind === "type") {
            await surface.act({ type: "type", ref: resolved.ref, text: value, clearFirst: action.clearFirst });
          } else {
            await surface.act({ type: "select", ref: resolved.ref, value });
          }
        }

        return { resolved: { rung: resolved.rung, by: resolved.by } };
      }

      case "extract": {
        if (action.target) {
          const resolved = await resolveWith(observation, action.target);
          if (!resolved) {
            return failAt(
              "output_missing",
              `to locate the source of output "${action.output}"`,
              "no strategy resolved",
              action.target.description,
            );
          }
          const result = await surface.act({ type: "extract", ref: resolved.ref, as: action.output });
          if (!result.ok) {
            return failAt("output_missing", `to read output "${action.output}"`, result.error ?? "read failed", "");
          }
          outputs[action.output] = result.value ?? "";
          return { resolved: { rung: resolved.rung, by: resolved.by } };
        }

        if (action.pattern) {
          const result = await surface.act({ type: "extract", pattern: action.pattern, as: action.output });
          if (!result.ok) {
            return failAt(
              "output_missing",
              `pattern /${action.pattern}/ to match for output "${action.output}"`,
              "no match on the current screen",
              "",
            );
          }
          outputs[action.output] = result.value ?? "";
          return {};
        }

        return failAt("internal", "an extract step with a target or pattern", "neither was present", "");
      }

      case "escalate": {
        if (!handoff) {
          return failAt(
            "handoff_timeout",
            "a handoff coordinator for this designed escalation point",
            "none was configured",
            "This capability requires a human decision but replay was started without escalation support.",
          );
        }
        const outcome = await handoff.escalate(
          {
            kind: "risky_action_confirmation",
            reason: action.reason,
            detail: `Capability ${capability.id} reached a step that requires a person.`,
            capabilityId: capability.id,
            capabilityVersion: capability.version,
            stepId: step.id,
            stepIndex: trace.length,
            suggestedAction: action.suggestedAction,
          },
          observation,
        );
        if (outcome.status !== "resumed") {
          return failAt(
            "handoff_timeout",
            "an operator to complete the manual step",
            `handoff ended: ${outcome.status}`,
            action.suggestedAction,
          );
        }
        return {};
      }
    }
  };

  // ---- Main loop ---------------------------------------------------------

  try {
    await surface.act({ type: "navigate", url: interpolate(capability.surface.entryPoint, params) });

    if (capability.preflight) {
      const observation = await surface.observe();
      const result = await evaluateCheckpoint(capability.preflight, checkpointCtx(observation));
      if (!result.passed) {
        return fail({
          class: "precondition_failed",
          expected: result.expected,
          observed: result.observed,
          detail: "Preflight failed; the entry point is not the screen this capability was recorded against.",
          recoveryAttempted: [],
        });
      }
    }

    for (let index = 0; index < capability.steps.length; index++) {
      const step = capability.steps[index]!;
      const stepStarted = performance.now();
      const recoveriesApplied: string[] = [];
      let resolvedInfo: { rung: number; by: string } | undefined;
      let settled = false;

      for (let attempt = 0; attempt <= transientRetries && !settled; attempt++) {
        let observation = await surface.observe();

        // 1. A declared business outcome ends the run, successfully, right here.
        const outcome = await matchOutcome(observation);
        if (outcome) {
          await logger.capture(surface, `outcome-${outcome.code}`);
          logger.event("business_outcome", { code: outcome.code, stepId: step.id });
          trace.push({
            stepId: step.id,
            index,
            intent: step.intent,
            status: "ok",
            durationMs: Math.round(performance.now() - stepStarted),
            note: `stopped on business outcome ${outcome.code}`,
          });
          return {
            ...base(),
            status: "business_outcome",
            code: outcome.code,
            message: interpolate(outcome.message, params),
            description: outcome.description,
            outputs: Object.fromEntries(
              outcome.partialOutputs.map((name) => [name, outputs[name]]).filter(([, v]) => v !== undefined),
            ),
          };
        }

        // 2. A recoverable condition: clear it and re-evaluate from the top.
        const rule = await matchRecovery(observation, step);
        if (rule) {
          recoveryUsage.set(rule.name, (recoveryUsage.get(rule.name) ?? 0) + 1);
          recoveriesApplied.push(rule.name);
          logger.event("recovery_applied", { rule: rule.name, stepId: step.id, reason: rule.description });
          for (const recoveryAction of rule.do) {
            await performAction(recoveryAction, observation, step);
          }
          observation = await surface.observe();
          attempt--; // A handled interstitial should not consume a transient retry.
          continue;
        }

        // 3. Steps that are already satisfied are skipped, not re-run.
        if (step.skipIf) {
          const skip = await evaluateCheckpoint(step.skipIf, checkpointCtx(observation));
          if (skip.passed) {
            trace.push({
              stepId: step.id,
              index,
              intent: step.intent,
              status: "skipped",
              durationMs: Math.round(performance.now() - stepStarted),
              note: skip.observed,
            });
            settled = true;
            break;
          }
        }

        if (step.precondition) {
          const pre = await evaluateCheckpoint(step.precondition, checkpointCtx(observation));
          if (!pre.passed) {
            const condition = classifySurfaceCondition(observation);
            // Waiting will not turn a sign-on page back into a search screen.
            if (!condition && attempt < transientRetries) {
              await delay(transientDelayMs);
              continue;
            }
            return fail({
              class: condition?.class ?? "precondition_failed",
              stepId: step.id,
              stepIndex: index,
              intent: step.intent,
              expected: pre.expected,
              observed: condition ? `${condition.detail}; ${pre.observed}` : pre.observed,
              detail: "The screen was not in the expected state before this step ran.",
              recoveryAttempted: recoveriesApplied,
            });
          }
        }

        const performed = await performAction(step.action, observation, step);
        if ("error" in performed) {
          // Never retry into a screen we already recognise as broken. Retrying
          // a step against a sign-on page cannot succeed, and it is actively
          // harmful: the strong locator rungs find nothing, execution falls
          // through to the positional fallback, and that fallback happily
          // matches whatever occupies the same ordinal position on the wrong
          // screen. Observed in practice — a member ID typed into the operator
          // ID field and the sign-on button clicked, which also destroyed the
          // expiry message that would have explained the failure.
          const condition = classifySurfaceCondition(await surface.observe());
          if (condition) {
            return fail({
              class: condition.class,
              stepId: step.id,
              stepIndex: index,
              intent: step.intent,
              expected: performed.error.expected,
              observed: condition.detail,
              detail: "Stopped without retrying: the surface is in a state this step cannot proceed from.",
              recoveryAttempted: recoveriesApplied,
            });
          }

          if (attempt < transientRetries && isRetryable(performed.error.class)) {
            await delay(transientDelayMs);
            continue;
          }

          // A failure to act can itself be the business answer: the row is
          // missing because the record does not exist.
          const after = await surface.observe();
          const lateOutcome = await matchOutcome(after);
          if (lateOutcome) {
            logger.event("business_outcome", { code: lateOutcome.code, stepId: step.id });
            return {
              ...base(),
              status: "business_outcome",
              code: lateOutcome.code,
              message: interpolate(lateOutcome.message, params),
              description: lateOutcome.description,
              outputs: {},
            };
          }
          return fail({ ...performed.error, recoveryAttempted: recoveriesApplied });
        }
        resolvedInfo = performed.resolved;

        // 4. Verify. A step without a checkpoint is trusted, which is why the
        //    recorder tries hard to derive one for every step.
        if (step.checkpoint) {
          const after = await surface.observe();

          const postOutcome = await matchOutcome(after);
          if (postOutcome) {
            await logger.capture(surface, `outcome-${postOutcome.code}`);
            logger.event("business_outcome", { code: postOutcome.code, stepId: step.id });
            trace.push({
              stepId: step.id,
              index,
              intent: step.intent,
              status: "ok",
              resolvedRung: resolvedInfo?.rung,
              resolvedBy: resolvedInfo?.by,
              durationMs: Math.round(performance.now() - stepStarted),
              note: `stopped on business outcome ${postOutcome.code}`,
            });
            return {
              ...base(),
              status: "business_outcome",
              code: postOutcome.code,
              message: interpolate(postOutcome.message, params),
              description: postOutcome.description,
              outputs: Object.fromEntries(
                postOutcome.partialOutputs
                  .map((name) => [name, outputs[name]])
                  .filter(([, v]) => v !== undefined),
              ),
            };
          }

          const check = await evaluateCheckpoint(step.checkpoint, checkpointCtx(after));
          if (!check.passed) {
            // Same reasoning as above: a recognised surface condition is not a
            // transient one, and retrying past it takes wrong actions.
            const hardCondition = classifySurfaceCondition(after);
            if (hardCondition) {
              return fail({
                class: hardCondition.class,
                stepId: step.id,
                stepIndex: index,
                intent: step.intent,
                expected: check.expected,
                observed: `${hardCondition.detail}; ${check.observed}`,
                detail: "Stopped without retrying: the application changed state underneath the run.",
                recoveryAttempted: recoveriesApplied,
              });
            }

            const postRecovery = await matchRecovery(after, step);
            if (postRecovery) {
              recoveryUsage.set(postRecovery.name, (recoveryUsage.get(postRecovery.name) ?? 0) + 1);
              recoveriesApplied.push(postRecovery.name);
              logger.event("recovery_applied", { rule: postRecovery.name, stepId: step.id, phase: "post" });
              for (const recoveryAction of postRecovery.do) {
                await performAction(recoveryAction, after, step);
              }
              const recheck = await evaluateCheckpoint(step.checkpoint, checkpointCtx(await surface.observe()));
              if (recheck.passed) {
                settled = true;
                break;
              }
            }

            if (attempt < transientRetries) {
              await delay(transientDelayMs);
              continue;
            }

            const condition = classifySurfaceCondition(after);
            return fail({
              class: condition?.class ?? "checkpoint_failed",
              stepId: step.id,
              stepIndex: index,
              intent: step.intent,
              expected: check.expected,
              observed: condition ? `${condition.detail}; ${check.observed}` : check.observed,
              detail: `Step "${step.intent}" ran but the screen does not show the expected result.`,
              recoveryAttempted: recoveriesApplied,
            });
          }
        }

        settled = true;
      }

      if (!settled) {
        return fail({
          class: "timeout",
          stepId: step.id,
          stepIndex: index,
          intent: step.intent,
          expected: "the step to complete within its retry budget",
          observed: `exhausted ${transientRetries} retries`,
          detail: "",
          recoveryAttempted: recoveriesApplied,
        });
      }

      if (trace.at(-1)?.stepId !== step.id) {
        trace.push({
          stepId: step.id,
          index,
          intent: step.intent,
          status: recoveriesApplied.length ? "recovered" : "ok",
          resolvedRung: resolvedInfo?.rung,
          resolvedBy: resolvedInfo?.by,
          recoveriesApplied: recoveriesApplied.length ? recoveriesApplied : undefined,
          durationMs: Math.round(performance.now() - stepStarted),
        });
      }
    }

    // ---- Success condition and outputs ----------------------------------

    const finalObservation = await surface.observe();

    const finalOutcome = await matchOutcome(finalObservation);
    if (finalOutcome) {
      logger.event("business_outcome", { code: finalOutcome.code, phase: "final" });
      return {
        ...base(),
        status: "business_outcome",
        code: finalOutcome.code,
        message: interpolate(finalOutcome.message, params),
        description: finalOutcome.description,
        outputs: {},
      };
    }

    const success = await evaluateCheckpoint(capability.successCondition, checkpointCtx(finalObservation));
    if (!success.passed) {
      const condition = classifySurfaceCondition(finalObservation);
      return fail({
        class: condition?.class ?? "checkpoint_failed",
        expected: success.expected,
        observed: condition ? `${condition.detail}; ${success.observed}` : success.observed,
        detail: "All steps ran but the capability's success condition does not hold.",
        recoveryAttempted: [...recoveryUsage.keys()],
      });
    }

    const typedOutputs: Record<string, unknown> = {};
    for (const spec of capability.outputs) {
      const raw = outputs[spec.name];
      if (raw === undefined) {
        if (spec.required) {
          return fail({
            class: "output_missing",
            expected: `declared output "${spec.name}" to be produced`,
            observed: "no step populated it",
            detail: spec.description,
            recoveryAttempted: [],
          });
        }
        continue;
      }
      typedOutputs[spec.name] = coerceOutput(String(raw), spec.type);
    }

    await logger.capture(surface, "replay-success");
    logger.event("replay_succeeded", {
      outputs: Object.fromEntries(
        capability.outputs.map((spec) => [
          spec.name,
          spec.sensitivity === "pii" || spec.sensitivity === "secret"
            ? `<redacted:${spec.name}>`
            : typedOutputs[spec.name],
        ]),
      ),
      degradedResolutions,
    });

    return { ...base(), status: "success", outputs: typedOutputs };
  } catch (error) {
    if (error instanceof PolicyViolationError) {
      return fail({
        class: "policy_denied",
        expected: "the action to be permitted by policy",
        observed: error.decision.reason,
        detail: `Rule: ${error.decision.rule ?? "unspecified"}`,
        recoveryAttempted: [],
      });
    }
    if (error instanceof ConfirmationDeniedError) {
      return fail({
        class: "confirmation_denied",
        expected: "authorization for a risky action",
        observed: error.note,
        detail: `Risk class: ${error.decision.risk}`,
        recoveryAttempted: [],
      });
    }
    return fail({
      class: "internal",
      expected: "replay to complete",
      observed: (error as Error).message,
      detail: (error as Error).stack ?? "",
      recoveryAttempted: [],
    });
  }
}

function isRetryable(klass: ReplayFailure["class"]): boolean {
  // Only conditions that a slow or mid-render page could plausibly cause.
  return klass === "locator_unresolved" || klass === "timeout" || klass === "output_missing";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
