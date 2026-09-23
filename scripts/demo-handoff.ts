/**
 * Reproducible demonstration of the human handoff.
 *
 * A real handoff needs a person, which makes it awkward to capture as
 * committed evidence. This script keeps every part of the mechanism real — the
 * intervention, the lease transitions, the live session, the action recording,
 * the resume-and-verify — and scripts only the human's side: a simulated
 * operator that takes control, clicks a link in the browser the automation was
 * already driving, and hands control back.
 *
 * The operator acts through the raw page, outside the lease, exactly as a
 * person at the keyboard does. Nothing about the transfer is stubbed.
 *
 * To do it manually instead, run any `npm run replay` headed and use the
 * operator console at :4610. This script exists so the evidence in the repo is
 * reproducible by someone who just cloned it.
 *
 *   npm run demo:handoff
 */

import "dotenv/config";
import { startMeridian } from "../apps/meridian/server.js";
import { escalatingCapability } from "../tests/fixtures/escalating-capability.js";
import { meridianAllowlist, PATHS, PORTS } from "../src/config.js";
import { startOperatorConsole } from "../src/escalation/console.js";
import { HandoffCoordinator } from "../src/escalation/handoff.js";
import { InterventionStore, type InterventionRequest } from "../src/escalation/intervention.js";
import { ControlBroker, ControlViolationError } from "../src/escalation/lease.js";
import { RunLogger } from "../src/evidence/logger.js";
import { Allowlist } from "../src/policy/allowlist.js";
import { replay } from "../src/replay/executor.js";
import { describeResult } from "../src/replay/result.js";
import { GuardedSurface } from "../src/surface/guarded.js";
import { PlaywrightSurface } from "../src/surface/playwright-surface.js";

const OPERATOR = "operator-jane";
/**
 * `--manual` hands the operator's half to a real person instead of scripting
 * it: the run pauses, and you take control from the console and drive the
 * browser yourself. Nothing else changes — it is the same code path, with a
 * human where the simulated operator would be.
 */
const manual = process.argv.includes("--manual");
const headless = !process.argv.includes("--headed") && !manual;

async function waitForOpenIntervention(store: InterventionStore, timeoutMs = 60_000): Promise<InterventionRequest> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = store.list("open")[0];
    if (open) return open;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("no intervention was raised");
}

const app = await startMeridian(PORTS.meridian);
const logger = new RunLogger({ kind: "replay", root: PATHS.runs, runId: `handoff-${new Date().toISOString().replace(/[:.]/g, "-")}` });
const broker = new ControlBroker(logger.runId);
const interventions = new InterventionStore();

const adapter = await PlaywrightSurface.launch({ app: "meridian-core", entryPoint: app.url, headless });
const surface = new GuardedSurface(adapter, { broker, allowlist: new Allowlist(meridianAllowlist(app.url)) });
const handoff = new HandoffCoordinator(broker, surface, interventions, logger);
const console_ = await startOperatorConsole(interventions, handoff, broker, PORTS.operator);

process.stdout.write(`\n  target app:       ${app.url}\n  operator console: ${console_.url}\n  evidence:         ${logger.dir}\n\n`);

const capability = escalatingCapability(app.url);

const running = replay({
  capability,
  params: { memberId: "10001" },
  surface,
  logger,
  handoff,
  secrets: {
    MERIDIAN_USERNAME: process.env.MERIDIAN_USERNAME ?? "teller01",
    MERIDIAN_PASSWORD: process.env.MERIDIAN_PASSWORD ?? "demo-pass-2024",
  },
});

const request = await waitForOpenIntervention(interventions);

process.stdout.write(`  intervention ${request.id} raised at step ${request.stepId}\n`);
process.stdout.write(`  lease is now: ${broker.current}\n`);

// Automation has genuinely stood down — the surface refuses it, rather than
// relying on the caller to be well behaved.
try {
  await surface.act({ type: "press", key: "Escape" });
  process.stdout.write(`  !! automation acted while a human held the lease — this is a bug\n`);
} catch (error) {
  if (error instanceof ControlViolationError) {
    logger.event("lease_enforced", { note: "automation was refused while the lease was held for a human" });
    process.stdout.write(`  lease enforced: automation was refused while standing down\n`);
  } else {
    throw error;
  }
}

if (manual) {
  process.stdout.write(
    `\n  ── YOUR TURN ──────────────────────────────────────────────────────\n` +
      `  1. Open the operator console:  ${console_.url}\n` +
      `  2. Enter any operator ID and click "Take control of live session"\n` +
      `  3. In the Chrome window that is already open, click member 10001\n` +
      `  4. Back in the console, click "Hand control back"\n\n` +
      `  Automation is paused and will resume when you hand control back.\n` +
      `  ───────────────────────────────────────────────────────────────────\n\n`,
  );

  const resumed = await broker.waitForAutomation(10 * 60_000);
  if (resumed !== "resumed") {
    process.stdout.write(`  handoff ended: ${resumed}\n`);
    await surface.dispose();
    await console_.close();
    await app.close();
    process.exit(1);
  }
  process.stdout.write(`  control returned — lease: ${broker.current}\n\n`);

  const result = await running;
  logger.writeDocument("result.json", result);
  logger.writeDocument("intervention.json", interventions.get(request.id));
  logger.writeDocument("lease-history.json", broker.state());
  process.stdout.write(`  ${describeResult(result)}\n`);
  if (result.status === "success") process.stdout.write(`  outputs: ${JSON.stringify(result.outputs)}\n`);
  process.stdout.write(`  evidence: ${logger.dir}\n`);

  await surface.dispose();
  await console_.close();
  await app.close();
  process.exit(result.status === "success" ? 0 : 1);
}

handoff.takeControl(request.id, OPERATOR);
process.stdout.write(`  ${OPERATOR} took control — lease: ${broker.current}\n`);

// The operator drives the same live session. It is already signed on and
// sitting on the search results; a fresh browser would be on the sign-on page.
const contentFrame = adapter.livePage().frames().find((f) => f.name() === "mainframe");
if (!contentFrame) throw new Error("the automation's content frame is gone");
process.stdout.write(`  operator sees: ${contentFrame.url()}\n`);

await contentFrame.click('a:has-text("10001")');

// `waitForLoadState` resolves against the document that is loaded *now*, which
// is still the previous one, so it returns before the click's navigation
// commits. Wait for the frame's URL to actually change instead.
const frameUrl = async () =>
  adapter.livePage().frames().find((f) => f.name() === "mainframe")?.url() ?? "";
const before = await frameUrl();
const deadline = Date.now() + 10_000;
while (Date.now() < deadline && (await frameUrl()) === before) {
  await new Promise((r) => setTimeout(r, 100));
}
process.stdout.write(`  operator navigated to: ${await frameUrl()}\n`);

await handoff.returnControl(request.id, {
  actor: OPERATOR,
  note: "Selected member 10001 from the candidate records.",
  decision: "approved",
});
process.stdout.write(`  control returned — lease: ${broker.current}\n\n`);

const result = await running;
logger.writeDocument("result.json", result);
logger.writeDocument("intervention.json", interventions.get(request.id));
logger.writeDocument("lease-history.json", broker.state());

process.stdout.write(`  ${describeResult(result)}\n`);
if (result.status === "success") process.stdout.write(`  outputs: ${JSON.stringify(result.outputs)}\n`);
process.stdout.write(`  evidence: ${logger.dir}\n`);

await surface.dispose();
await console_.close();
await app.close();
process.exit(result.status === "success" ? 0 : 1);
