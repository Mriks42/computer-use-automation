import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeridian } from "../../apps/meridian/server.js";
import { meridianAllowlist } from "../../src/config.js";
import { HandoffCoordinator } from "../../src/escalation/handoff.js";
import { InterventionStore } from "../../src/escalation/intervention.js";
import { ControlBroker } from "../../src/escalation/lease.js";
import { RunLogger } from "../../src/evidence/logger.js";
import { Allowlist } from "../../src/policy/allowlist.js";
import { Redactor } from "../../src/policy/redact.js";
import { GuardedSurface } from "../../src/surface/guarded.js";
import { PlaywrightSurface } from "../../src/surface/playwright-surface.js";

let portCursor = 4800;

/**
 * Bring up the full stack against a throwaway instance of the target app.
 *
 * Each test gets its own port and its own app instance so injected faults in
 * one test cannot leak into another.
 */
export async function testStack() {
  const port = portCursor++;
  const app = await startMeridian(port);

  const logger = new RunLogger({
    kind: "replay",
    root: mkdtempSync(join(tmpdir(), "cua-test-")),
    echo: false,
    redactor: new Redactor(),
  });

  const broker = new ControlBroker(logger.runId);
  const interventions = new InterventionStore();
  const adapter = await PlaywrightSurface.launch({
    app: "meridian-core",
    entryPoint: app.url,
    headless: true,
  });

  const surface = new GuardedSurface(adapter, {
    broker,
    allowlist: new Allowlist(meridianAllowlist(app.url)),
  });

  const handoff = new HandoffCoordinator(broker, surface, interventions, logger, { waitMs: 2_000 });

  return {
    origin: app.url,
    surface,
    logger,
    broker,
    interventions,
    handoff,
    async inject(body: Record<string, unknown>) {
      await fetch(`${app.url}/control/inject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async close() {
      await surface.dispose();
      await app.close();
    },
  };
}

export const TEST_SECRETS = {
  MERIDIAN_USERNAME: "teller01",
  MERIDIAN_PASSWORD: "demo-pass-2024",
};
