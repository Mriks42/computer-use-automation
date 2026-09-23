/**
 * The discovery loop: observe, decide, act.
 *
 * Structure worth noting: the model is given one action per turn and the result
 * of that action is a fresh observation, not a success/failure string. That is
 * deliberate. Telling a model "click succeeded" invites it to proceed on faith;
 * showing it the new screen forces it to verify, which is the same discipline
 * the replay engine enforces with checkpoints. The two paths reason the same
 * way, which makes the recorded artifact a fair description of what happened.
 *
 * The loop terminates on four conditions, and all four are represented in the
 * outcome rather than thrown: goal met, model escalated, step budget exhausted,
 * or a hard failure. A discovery run that ends in escalation is a legitimate
 * result — it means the system correctly recognised that it could not proceed
 * and asked for help, which is the behaviour the environment requires.
 */

import { randomUUID } from "node:crypto";
import type { LlmProvider, LlmMessage } from "./llm.js";
import { agentTools, renderObservation, systemPrompt } from "./prompts.js";
import type { DiscoveryOutcome, TranscriptEntry } from "./transcript.js";
import type { HandoffCoordinator } from "../escalation/handoff.js";
import type { RunLogger } from "../evidence/logger.js";
import { PolicyViolationError, ConfirmationDeniedError } from "../policy/errors.js";
import type { Action, Observation, Surface, UiElement } from "../surface/types.js";

export interface DiscoveryOptions {
  goal: string;
  surface: Surface;
  provider: LlmProvider;
  logger: RunLogger;
  handoff: HandoffCoordinator;
  /** Concrete values for this run. Rewritten into named parameters by the recorder. */
  params?: Record<string, string>;
  /** Secret names the agent may reference. Values resolved here, never shown to it. */
  secrets?: Record<string, string>;
  /** Output names the goal is expected to produce, used to steer extraction. */
  expectedOutputs?: string[];
  maxSteps?: number;
}

export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryOutcome> {
  const {
    goal,
    surface,
    provider,
    logger,
    handoff,
    params = {},
    secrets = {},
    expectedOutputs = [],
    maxSteps = 25,
  } = options;

  const entries: TranscriptEntry[] = [];
  const tools = agentTools(expectedOutputs);

  // Register every secret with the logger before the first action, so a value
  // cannot reach the evidence trail even if something later goes wrong.
  for (const [name, value] of Object.entries(secrets)) logger.registerSecret(value, name);

  const messages: LlmMessage[] = [
    {
      role: "system",
      content: systemPrompt({
        goal,
        entryPoint: surface.descriptor.entryPoint,
        app: surface.descriptor.app,
        paramNames: Object.keys(params),
        secretRefs: Object.keys(secrets),
        maxSteps,
      }),
    },
  ];

  logger.event("discovery_started", { goal, model: provider.name, maxSteps, params: Object.keys(params) });

  await surface.act({ type: "navigate", url: surface.descriptor.entryPoint });
  let observation = await surface.observe();
  await logger.capture(surface, "discovery-entry");

  const finish = (
    status: DiscoveryOutcome["status"],
    extra: Partial<DiscoveryOutcome> = {},
  ): DiscoveryOutcome => {
    logger.event("discovery_finished", { status, steps: entries.length, ...("error" in extra ? { error: extra.error } : {}) });
    return {
      status,
      goal,
      runId: logger.runId,
      model: provider.name,
      entries,
      params,
      finalObservation: observation,
      ...extra,
    };
  };

  for (let step = 0; step < maxSteps; step++) {
    messages.push({
      role: "user",
      content:
        step === 0
          ? `Current screen:\n\n${renderObservation(observation)}`
          : `Result of your last action — current screen:\n\n${renderObservation(observation)}`,
    });

    let decision;
    try {
      decision = await provider.decide(messages, tools);
    } catch (error) {
      return finish("failed", { error: `model call failed: ${(error as Error).message}` });
    }

    const args = decision.arguments;
    const why = String(args.why ?? decision.commentary ?? "");
    logger.event("agent_decision", { step, tool: decision.toolName, why, args: redactArgs(args) });

    messages.push({
      role: "assistant",
      content: decision.commentary ?? "",
      toolCalls: [
        { id: decision.toolCallId, name: decision.toolName, arguments: JSON.stringify(args) },
      ],
    });

    // ---- Terminal tools -------------------------------------------------

    if (decision.toolName === "done") {
      const successEvidence = String(args.successEvidence ?? "");
      const present = observation.text.toLowerCase().includes(successEvidence.toLowerCase());
      if (!successEvidence || !present) {
        // The model claims success but cannot point at evidence for it. Do not
        // record an artifact whose success condition fails on the very screen
        // it was recorded from — that artifact would never replay.
        messages.push({
          role: "tool",
          toolCallId: decision.toolCallId,
          content: `Rejected: the text ${JSON.stringify(successEvidence)} is not visible on the current screen. Quote a distinctive phrase that is actually present, or keep working.`,
        });
        logger.event("done_rejected", { successEvidence, reason: "evidence not visible on screen" });
        observation = await surface.observe();
        continue;
      }

      await logger.capture(surface, "discovery-success");
      return finish("succeeded", {
        completion: {
          summary: String(args.summary ?? ""),
          successEvidence,
          knownOutcomes: Array.isArray(args.knownOutcomes)
            ? (args.knownOutcomes as NonNullable<DiscoveryOutcome["completion"]>["knownOutcomes"])
            : [],
        },
      });
    }

    if (decision.toolName === "escalate") {
      const outcome = await handoff.escalate(
        {
          kind: "discovery_stuck",
          reason: String(args.reason ?? "agent reported it was stuck"),
          detail: String(args.detail ?? ""),
          goal,
          suggestedAction: String(args.suggestedAction ?? ""),
        },
        observation,
      );

      if (outcome.status !== "resumed") {
        return finish("escalated", { error: `handoff ended: ${outcome.status}` });
      }

      entries.push({
        index: entries.length,
        at: new Date().toISOString(),
        kind: "handoff",
        interventionId: "",
        reason: String(args.reason ?? ""),
        actor: outcome.actor,
        note: outcome.note,
        actionCount: outcome.humanActions.length,
      });

      observation = await surface.observe();
      messages.push({
        role: "tool",
        toolCallId: decision.toolCallId,
        content: `A human operator took control and reported: ${outcome.note}. They performed ${outcome.humanActions.length} action(s). Control is back with you. Re-read the screen and continue.`,
      });
      continue;
    }

    // ---- Acting tools ---------------------------------------------------

    const ref = typeof args.ref === "string" ? args.ref : undefined;
    const target: UiElement | undefined = ref
      ? observation.elements.find((e) => e.ref === ref)
      : undefined;

    if (ref && !target) {
      messages.push({
        role: "tool",
        toolCallId: decision.toolCallId,
        content: `Ref ${ref} is not in the current observation. Refs expire every turn — pick one from the list above.`,
      });
      observation = await surface.observe();
      continue;
    }

    const observationBefore = observation;
    let action: Action | undefined;
    let typedText: string | undefined;
    let secretRef: string | undefined;

    switch (decision.toolName) {
      case "click":
        action = { type: "click", ref: ref! };
        break;
      case "type":
        typedText = String(args.text ?? "");
        action = { type: "type", ref: ref!, text: typedText };
        break;
      case "type_secret": {
        secretRef = String(args.secretRef ?? "");
        const value = secrets[secretRef];
        if (value === undefined) {
          messages.push({
            role: "tool",
            toolCallId: decision.toolCallId,
            content: `No secret named ${secretRef} is available. Available: ${Object.keys(secrets).join(", ") || "none"}.`,
          });
          continue;
        }
        action = { type: "type", ref: ref!, text: value };
        break;
      }
      case "select":
        action = { type: "select", ref: ref!, value: String(args.value ?? "") };
        break;
      case "extract":
        action = { type: "extract", ref: ref!, as: String(args.output ?? "value") };
        break;
      default:
        messages.push({
          role: "tool",
          toolCallId: decision.toolCallId,
          content: `Unknown tool ${decision.toolName}.`,
        });
        continue;
    }

    let ok = true;
    let error: string | undefined;
    let extractedValue: string | undefined;

    try {
      const result = await surface.act(action);
      ok = result.ok;
      error = result.error;
      extractedValue = result.value;
    } catch (caught) {
      ok = false;
      if (caught instanceof PolicyViolationError || caught instanceof ConfirmationDeniedError) {
        error = caught.message;
        logger.event("policy_blocked_agent", { tool: decision.toolName, reason: caught.message });
      } else {
        error = (caught as Error).message;
      }
    }

    observation = await surface.observe();

    entries.push({
      index: entries.length,
      at: new Date().toISOString(),
      tool: decision.toolName,
      why,
      target,
      observationBefore,
      observationAfter: observation,
      typedText,
      secretRef,
      selectedValue: decision.toolName === "select" ? String(args.value ?? "") : undefined,
      output:
        decision.toolName === "extract"
          ? {
              name: String(args.output ?? "value"),
              valueType: String(args.valueType ?? "string"),
              description: String(args.description ?? ""),
              value: extractedValue ?? "",
            }
          : undefined,
      ok,
      error,
    });

    messages.push({
      role: "tool",
      toolCallId: decision.toolCallId,
      content: ok
        ? decision.toolName === "extract"
          ? `Extracted ${JSON.stringify(extractedValue ?? "")} as output "${String(args.output)}".`
          : "Action performed. The new screen follows."
        : `Action failed: ${error}. The current screen follows; decide what to do about it.`,
    });
  }

  await logger.capture(surface, "discovery-exhausted");
  return finish("exhausted", { error: `step budget of ${maxSteps} exhausted without reaching the goal` });
}

/** Keep anything that looks like a credential out of the decision log. */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  if ("text" in out) out.text = `<${String(out.text).length} chars>`;
  return out;
}

export function newRunId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
