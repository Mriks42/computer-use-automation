/**
 * Artifact storage.
 *
 * Files on disk, one JSON document per capability version, committed to the
 * repository alongside the code. For a system whose artifacts must be reviewed
 * and approved by humans at a regulated institution, that is a feature rather
 * than a limitation: an artifact becomes a pull request, approval becomes a
 * review, and the audit trail is the thing the institution already knows how to
 * operate.
 *
 * A database would buy queryability and lose all of that. The interface here is
 * narrow enough that swapping the backing store later is a contained change.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCapability, type Capability } from "./schema.js";
import { assertArtifactIsClean } from "./recorder.js";

export class CapabilityStore {
  constructor(private readonly dir: string) {
    mkdirSync(this.dir, { recursive: true });
  }

  private fileName(id: string, version: string): string {
    return `${id}@${version}.json`;
  }

  path(id: string, version: string): string {
    return join(this.dir, this.fileName(id, version));
  }

  /**
   * Artifacts are checked for regulated data on the way to disk, not only on
   * the way out of the recorder. This is the path a hand-edited artifact takes
   * too, and hand-editing is expected — a reviewer tightening a checkpoint
   * could paste in a line they copied off the screen.
   */
  save(capability: Capability): string {
    assertArtifactIsClean(capability);
    const path = this.path(capability.id, capability.version);
    writeFileSync(path, `${JSON.stringify(capability, null, 2)}\n`, "utf8");
    return path;
  }

  loadFile(path: string): Capability {
    return parseCapability(JSON.parse(readFileSync(path, "utf8")));
  }

  get(id: string, version?: string): Capability | undefined {
    if (version) {
      const path = this.path(id, version);
      return existsSync(path) ? this.loadFile(path) : undefined;
    }
    const versions = this.list()
      .filter((c) => c.id === id)
      .sort((a, b) => compareSemver(a.version, b.version));
    return versions.at(-1);
  }

  list(): Capability[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return this.loadFile(join(this.dir, f));
        } catch {
          return undefined;
        }
      })
      .filter((c): c is Capability => Boolean(c));
  }

  /**
   * Promote a draft.
   *
   * Recorded as a distinct act with an actor and a timestamp, because "who
   * approved this automation to run unattended against member accounts" is a
   * question that will be asked.
   */
  approve(id: string, version: string, actor: string, note: string): Capability {
    const capability = this.get(id, version);
    if (!capability) throw new Error(`no capability ${id}@${version}`);
    const approved: Capability = {
      ...capability,
      approval: { state: "approved", approvedBy: actor, approvedAt: new Date().toISOString(), note },
    };
    this.save(approved);
    return approved;
  }

  /** Record the result of a replay against the artifact's stability counters. */
  recordReplay(
    id: string,
    version: string,
    outcome: { succeeded: boolean; degradedResolutions: number },
  ): void {
    const capability = this.get(id, version);
    if (!capability) return;
    this.save({
      ...capability,
      stability: {
        attempts: capability.stability.attempts + 1,
        successes: capability.stability.successes + (outcome.succeeded ? 1 : 0),
        lastReplayAt: new Date().toISOString(),
        degradedResolutions: capability.stability.degradedResolutions + outcome.degradedResolutions,
      },
    });
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The agent-facing view of an artifact.
 *
 * What a calling model needs in order to decide whether to invoke this, and
 * with what. Notably it includes the risk class and the approval state: an
 * agent choosing between capabilities should be able to see that one of them
 * posts an irreversible transaction.
 */
export function toCatalogEntry(capability: Capability) {
  return {
    name: capability.id,
    version: capability.version,
    description: capability.description,
    risk: capability.riskClass,
    approval: capability.approval.state,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        capability.inputs.map((input) => [
          input.name,
          {
            type: input.type === "currency" ? "number" : input.type,
            description: input.description,
            ...(input.enum ? { enum: input.enum } : {}),
          },
        ]),
      ),
      required: capability.inputs.filter((i) => i.required).map((i) => i.name),
    },
    returns: Object.fromEntries(
      capability.outputs.map((output) => [
        output.name,
        { type: output.type, description: output.description },
      ]),
    ),
    outcomes: capability.knownOutcomes.map((o) => ({
      code: o.code,
      description: o.description,
      verified: o.verified,
    })),
  };
}
