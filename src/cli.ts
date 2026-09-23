#!/usr/bin/env node
/**
 * Command-line entry point.
 *
 * Every command assembles the same stack, because discovery and replay differ
 * only in what sits at the top of it:
 *
 *   PlaywrightSurface  — drives the browser
 *   GuardedSurface     — enforces the allowlist and the session lease
 *   ControlBroker      — owns who is allowed to act
 *   HandoffCoordinator — routes interventions to the operator console
 *   RunLogger          — writes redacted evidence
 *
 * Discovery puts the model on top. Replay puts the executor on top. Nothing
 * below changes, which is what makes the guarantees identical on both paths.
 */

import "dotenv/config";
import { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMeridian } from "../apps/meridian/server.js";
import { runDiscovery } from "./agent/loop.js";
import { goalParts, loadGoal } from "./agent/goal.js";
import { OpenAiProvider } from "./agent/llm.js";
import { recordCapability } from "./capability/recorder.js";
import { profileFor } from "./capability/profiles.js";
import { CapabilityStore, toCatalogEntry } from "./capability/store.js";
import { meridianAllowlist, PATHS, PORTS } from "./config.js";
import { startOperatorConsole } from "./escalation/console.js";
import { HandoffCoordinator } from "./escalation/handoff.js";
import { InterventionStore } from "./escalation/intervention.js";
import { ControlBroker } from "./escalation/lease.js";
import { RunLogger } from "./evidence/logger.js";
import { Allowlist } from "./policy/allowlist.js";
import { replay } from "./replay/executor.js";
import { describeResult } from "./replay/result.js";
import { GuardedSurface } from "./surface/guarded.js";
import { PlaywrightSurface } from "./surface/playwright-surface.js";

const program = new Command();
program.name("cua").description("Computer-use automation: record once, replay many").version("1.0.0");

/**
 * Sign-on credentials for the bundled stand-in app, used when the environment
 * does not supply them.
 *
 * These are fake by construction, for a local demo app whose source is in this
 * repository and whose credentials are printed in the README. Defaulting them
 * means a reviewer who clones and runs the documented replay command gets a
 * working demo instead of a failure on their first attempt.
 *
 * Scoped deliberately to this one app. Nothing here defaults a secret for a
 * real system: an unset credential for any other surface still fails closed
 * with `input_invalid` naming the missing secret.
 */
const DEMO_CREDENTIALS: Record<string, string> = {
  MERIDIAN_USERNAME: "teller01",
  MERIDIAN_PASSWORD: "demo-pass-2024",
};

function collectParam(value: string, previous: Record<string, string>): Record<string, string> {
  const idx = value.indexOf("=");
  if (idx === -1) throw new Error(`--param expects key=value, got "${value}"`);
  return { ...previous, [value.slice(0, idx)]: value.slice(idx + 1) };
}

/** Bring up the local target app, the operator console, and a guarded surface. */
async function buildStack(options: {
  kind: "discovery" | "replay";
  headless: boolean;
  target?: string;
}) {
  const meridian = options.target ? undefined : await startMeridian(PORTS.meridian);
  const origin = options.target ?? meridian!.url;

  const logger = new RunLogger({ kind: options.kind, root: PATHS.runs });
  const broker = new ControlBroker(logger.runId);
  const interventions = new InterventionStore();
  const allowlist = new Allowlist(meridianAllowlist(origin));

  const adapter = await PlaywrightSurface.launch({
    app: "meridian-core",
    entryPoint: origin,
    headless: options.headless,
  });

  const handoffRef: { current?: HandoffCoordinator } = {};

  const surface = new GuardedSurface(adapter, {
    broker,
    allowlist,
    onDecision: (action, decision) => {
      if (decision.effect !== "allow") {
        logger.event("policy_decision", { action: action.type, effect: decision.effect, reason: decision.reason });
      }
    },
    // A risky action does not fail and does not proceed — it becomes a question
    // for a person, carrying the screen it would have acted on.
    onConfirmationRequired: async (action, decision, observation) => {
      const coordinator = handoffRef.current;
      if (!coordinator) return { approved: false, note: "no escalation path configured" };
      const outcome = await coordinator.escalate(
        {
          kind: "risky_action_confirmation",
          reason: `authorization required for a ${decision.risk} action`,
          detail: decision.reason,
          suggestedAction: "Review the screen and approve only if this action should be committed.",
          proposedAction: { description: `${action.type}`, risk: decision.risk },
        },
        observation,
      );
      return outcome.status === "resumed"
        ? { approved: true, note: outcome.note }
        : { approved: false, note: outcome.status === "rejected" ? outcome.note : "no operator responded" };
    },
  });

  const handoff = new HandoffCoordinator(broker, surface, interventions, logger);
  handoffRef.current = handoff;

  const console_ = await startOperatorConsole(interventions, handoff, broker, PORTS.operator);

  process.stdout.write(`\n  target app:       ${origin}\n`);
  process.stdout.write(`  operator console: ${console_.url}\n`);
  process.stdout.write(`  evidence:         ${logger.dir}\n\n`);

  return {
    origin,
    logger,
    broker,
    surface,
    handoff,
    interventions,
    async shutdown(keepOpen: boolean) {
      if (keepOpen) {
        process.stdout.write("\n  --keep-open set; leaving the browser and console running. Ctrl-C to exit.\n");
        return;
      }
      await surface.dispose();
      await console_.close();
      await meridian?.close();
    },
  };
}

/** Drive the app's fault-injection plane. Test harness only, never the agent. */
async function inject(origin: string, fault: string): Promise<void> {
  const map: Record<string, Record<string, unknown>> = {
    session_timeout: { sessionTimeout: true },
    // Expires the session mid-flow rather than before it, which is the case
    // that actually exercises the failure path.
    session_timeout_midflow: { sessionTimeoutAfter: 5 },
    interstitial: { interstitial: true },
    app_error: { appError: true },
    permission_denied: { permissionDenied: true },
    slow: { slowMs: 1500 },
  };
  const body = map[fault];
  if (!body) throw new Error(`unknown fault "${fault}". Known: ${Object.keys(map).join(", ")}`);
  await fetch(`${origin}/control/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  process.stdout.write(`  injected fault: ${fault}\n`);
}

// ---------------------------------------------------------------------------

program
  .command("app")
  .description("Run the Meridian Core stand-in application on its own")
  .action(async () => {
    const meridian = await startMeridian(PORTS.meridian);
    process.stdout.write(`Meridian Core running at ${meridian.url}\n`);
    process.stdout.write(`Sign on with ${process.env.MERIDIAN_USERNAME ?? "teller01"} / ${process.env.MERIDIAN_PASSWORD ?? "demo-pass-2024"}\n`);
  });

program
  .command("discover")
  .description("Run an LLM-driven discovery run and record a capability artifact")
  .requiredOption("--goal <path>", "path to a goal definition file")
  .option("--headless", "run the browser headless", false)
  .option("--keep-open", "leave the browser and console running afterwards", false)
  .option("--target <origin>", "use an existing target instead of starting the local app")
  .action(async (opts) => {
    const goal = loadGoal(opts.goal);
    const { params, paramSpecs, secrets } = goalParts(goal);

    const stack = await buildStack({ kind: "discovery", headless: opts.headless, target: opts.target });

    try {
      const provider = new OpenAiProvider();

      const outcome = await runDiscovery({
        goal: goal.goal,
        surface: stack.surface,
        provider,
        logger: stack.logger,
        handoff: stack.handoff,
        params,
        secrets,
        expectedOutputs: goal.expectedOutputs,
        maxSteps: goal.maxSteps,
      });

      stack.logger.writeDocument("transcript.json", {
        status: outcome.status,
        goal: outcome.goal,
        model: outcome.model,
        completion: outcome.completion,
        // Observations are large and contain member data; the per-step summary
        // is what a reviewer actually needs.
        entries: outcome.entries.map((e) =>
          "kind" in e
            ? e
            : {
                index: e.index,
                tool: e.tool,
                why: e.why,
                target: e.target
                  ? { role: e.target.role, name: e.target.name, derivedName: e.target.derivedName }
                  : undefined,
                ok: e.ok,
                error: e.error,
              },
        ),
      });

      if (outcome.status !== "succeeded") {
        process.stdout.write(`\n  discovery ended: ${outcome.status}${outcome.error ? ` — ${outcome.error}` : ""}\n`);
        process.exitCode = 1;
        return;
      }

      const capability = recordCapability(outcome, {
        capabilityId: goal.capabilityId,
        name: goal.name,
        description: goal.description,
        tenantId: goal.tenantId,
        product: goal.product,
        profile: profileFor(goal.product),
        paramSpecs,
      });

      // The recorder infers the entry point from where the run ended; pin it to
      // the origin the run actually started from.
      capability.surface.entryPoint = stack.origin;

      const store = new CapabilityStore(PATHS.capabilities);
      const path = store.save(capability);
      stack.logger.writeDocument("capability.json", capability);

      process.stdout.write(`\n  recorded ${capability.id}@${capability.version} (${capability.steps.length} steps, risk: ${capability.riskClass})\n`);
      process.stdout.write(`  artifact: ${path}\n`);
      process.stdout.write(`  state:    ${capability.approval.state} — approve before unattended use\n`);
    } finally {
      await stack.shutdown(opts.keepOpen);
    }
  });

program
  .command("replay")
  .description("Replay a recorded capability deterministically, with no model involved")
  .requiredOption("--capability <id>", "capability id")
  .option("--artifact-version <semver>", "specific version (defaults to the newest)")
  .option("--param <key=value>", "input parameter, repeatable", collectParam, {})
  .option("--mode <mode>", "attended or unattended", "attended")
  .option("--inject <fault>", "inject a runtime fault before replaying")
  .option("--headless", "run the browser headless", false)
  .option("--keep-open", "leave the browser and console running afterwards", false)
  .option("--target <origin>", "use an existing target instead of starting the local app")
  .action(async (opts) => {
    const store = new CapabilityStore(PATHS.capabilities);
    const capability = store.get(opts.capability, opts.artifactVersion);
    if (!capability) {
      process.stderr.write(`no capability "${opts.capability}"${opts.artifactVersion ? `@${opts.artifactVersion}` : ""}\n`);
      process.exitCode = 1;
      return;
    }

    const stack = await buildStack({ kind: "replay", headless: opts.headless, target: opts.target });

    try {
      if (opts.inject) await inject(stack.origin, opts.inject);

      const secrets: Record<string, string> = {};
      for (const step of capability.steps) {
        if (step.action.kind === "type" && step.action.value.kind === "secret") {
          const value = process.env[step.action.value.ref] ?? DEMO_CREDENTIALS[step.action.value.ref];
          if (value) secrets[step.action.value.ref] = value;
        }
      }

      const result = await replay({
        capability,
        params: opts.param,
        surface: stack.surface,
        logger: stack.logger,
        handoff: stack.handoff,
        secrets,
        mode: opts.mode === "unattended" ? "unattended" : "attended",
      });

      stack.logger.writeDocument("result.json", result);
      store.recordReplay(capability.id, capability.version, {
        succeeded: result.status === "success",
        degradedResolutions: result.degradedResolutions,
      });

      process.stdout.write(`\n  ${describeResult(result)}\n`);
      if (result.status === "success") {
        process.stdout.write(`  outputs: ${JSON.stringify(result.outputs)}\n`);
      }
      if (result.status === "failure") {
        process.stdout.write(`  expected: ${result.failure.expected}\n`);
        process.stdout.write(`  observed: ${result.failure.observed}\n`);
        if (result.failure.evidence?.screenshot) {
          process.stdout.write(`  screenshot: ${result.failure.evidence.screenshot}\n`);
        }
      }
      process.stdout.write(`  evidence: ${stack.logger.dir}\n`);

      // A business outcome is a successful run. Only a genuine failure is a
      // non-zero exit, so callers can script against it correctly.
      process.exitCode = result.status === "failure" ? 1 : 0;
    } finally {
      await stack.shutdown(opts.keepOpen);
    }
  });

const capabilities = program.command("capabilities").description("Inspect and approve recorded capabilities");

capabilities
  .command("list")
  .description("List recorded capabilities as an agent would see them")
  .action(() => {
    const store = new CapabilityStore(PATHS.capabilities);
    const all = store.list();
    if (!all.length) {
      process.stdout.write("no capabilities recorded yet\n");
      return;
    }
    for (const capability of all) {
      const rate = capability.stability.attempts
        ? ` ${capability.stability.successes}/${capability.stability.attempts} replays`
        : "";
      process.stdout.write(
        `${capability.id}@${capability.version}  [${capability.approval.state}] ${capability.riskClass}${rate}\n    ${capability.description}\n`,
      );
    }
  });

capabilities
  .command("show")
  .description("Print the agent-facing contract for a capability")
  .requiredOption("--capability <id>")
  .option("--artifact-version <semver>")
  .action((opts) => {
    const store = new CapabilityStore(PATHS.capabilities);
    const capability = store.get(opts.capability, opts.artifactVersion);
    if (!capability) {
      process.stderr.write("not found\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(toCatalogEntry(capability), null, 2)}\n`);
  });

capabilities
  .command("approve")
  .description("Promote a draft artifact so it can be invoked unattended")
  .requiredOption("--capability <id>")
  .requiredOption("--artifact-version <semver>")
  .requiredOption("--actor <name>", "who is approving")
  .option("--note <text>", "review note", "")
  .action((opts) => {
    const store = new CapabilityStore(PATHS.capabilities);
    const approved = store.approve(opts.capability, opts.artifactVersion, opts.actor, opts.note);
    process.stdout.write(`${approved.id}@${approved.version} approved by ${opts.actor}\n`);
  });

program
  .command("catalog")
  .description("Write the capability catalog an agent would discover")
  .action(() => {
    const store = new CapabilityStore(PATHS.capabilities);
    const catalog = store.list().map(toCatalogEntry);
    mkdirSync(PATHS.evidence, { recursive: true });
    const path = join(PATHS.evidence, "catalog.json");
    writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
  });

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
