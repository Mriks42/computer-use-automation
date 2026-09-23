/**
 * Transcript → capability artifact.
 *
 * The interesting work is building the locator ladder. At record time we have
 * something replay will never have: the element that was actually acted on,
 * *and* the full observation it sat in. That means we can test each candidate
 * strategy for uniqueness before committing to it, and record only the ones
 * that actually identified this element and nothing else.
 *
 * This is why the model is kept away from selectors. A model asked to produce a
 * selector guesses from markup it half-remembers. The recorder does not guess —
 * it proposes candidates and checks each one against the real screen. A rung
 * that would have been ambiguous never makes it into the artifact.
 *
 * Parameterization happens here too. The run typed "10001" into a field; if
 * that string is the value of the `memberId` parameter, the step records
 * `{kind: "param", param: "memberId"}` instead. Same for the row anchor of a
 * grid click. The concrete value is never written down, which is what makes the
 * artifact both reusable and safe to commit.
 */

import {
  aggregateRisk,
  SCHEMA_VERSION,
  type BusinessOutcomeSpec,
  type Capability,
  type Checkpoint,
  type OutputSpec,
  type ParamSpec,
  type RiskClass,
  type Step,
  type StepAction,
  type ValueSource,
} from "./schema.js";
import type { SurfaceProfile } from "./profiles.js";
import {
  normalizeLadder,
  scoreConfidence,
  type LocatorDescriptor,
  type LocatorStrategy,
} from "../surface/locator.js";
import { matchStrategy } from "../surface/matcher.js";
import { classifyAction } from "../policy/risk.js";
import { defaultRedactor } from "../policy/redact.js";
import type { DiscoveryOutcome, TranscriptAction } from "../agent/transcript.js";
import { isHandoff } from "../agent/transcript.js";
import type { Observation, UiElement } from "../surface/types.js";

export interface RecorderOptions {
  capabilityId: string;
  name: string;
  description: string;
  version?: string;
  tenantId: string;
  product: string;
  profile?: SurfaceProfile;
  paramSpecs?: Record<string, Partial<ParamSpec>>;
  /** Names of secrets used, so they can be declared without their values. */
  notes?: string;
}

/**
 * Build the ladder for one element.
 *
 * Every candidate is verified: `matchStrategy` must return exactly this
 * element and no other. An ambiguous candidate is dropped rather than recorded,
 * because replay treats ambiguity as failure anyway and a rung that always
 * fails is worse than no rung — it hides the real fallback behind a wasted try.
 */
export function buildLocator(
  target: UiElement,
  observation: Observation,
  params: Record<string, string>,
  purpose: "act" | "extract" = "act",
): LocatorDescriptor {
  const candidates: LocatorStrategy[] = [];
  const reasons: string[] = [];

  const isUnique = (strategy: LocatorStrategy): boolean => {
    const matches = matchStrategy(observation, strategy);
    return matches.length === 1 && matches[0]!.ref === target.ref;
  };

  const name = target.name?.trim();
  const derived = target.derivedName?.trim();

  /**
   * A strategy must never encode data from this particular run.
   *
   * Two ways that happens, and both look fine until the first replay with
   * different inputs:
   *
   *   - The element's name *is* a parameter value. "Click the link named 10001"
   *     works forever on member 10001 and never on anyone else. The row-anchored
   *     rung expresses the same intent parameterized, so use that instead.
   *
   *   - The element is the cell being extracted from. Locating a balance by
   *     searching for the balance is circular: it can only find a value you
   *     already know, which is precisely the value you do not have yet.
   *
   * In both cases the name is data, not identity, and identity has to come from
   * the element's position relative to something stable.
   */
  const nameIsParamValue = Boolean(name) && Object.values(params).some((value) => value === name);
  const nameIsExtractedData = purpose === "extract" && (target.role === "cell" || target.role === "columnheader");
  const nameIsData = nameIsParamValue || nameIsExtractedData;

  if (nameIsData) {
    reasons.push(
      nameIsParamValue
        ? "skipped name-based targeting: this element's label is a parameter value and would pin the step to one input"
        : "skipped name-based targeting: this cell's text is the value being extracted",
    );
  }

  if (name && !nameIsData) {
    const s: LocatorStrategy = { kind: "role_name", role: target.role, name, exact: true };
    if (isUnique(s)) {
      candidates.push(s);
      reasons.push("accessible name is unique for this role on the screen");
    } else if (target.context.region) {
      const scoped: LocatorStrategy = {
        kind: "role_name_in_region",
        role: target.role,
        name,
        region: target.context.region,
        exact: true,
      };
      if (isUnique(scoped)) {
        candidates.push(scoped);
        reasons.push("name repeats on the screen; scoped to its panel to disambiguate");
      }
    }
  }

  // Grid targeting. The anchor is parameterized when it matches an input value,
  // which is what turns "click the row for member 10001" into "click the row
  // for whichever member the caller asked about".
  if (target.context.rowAnchor) {
    const anchor = target.context.rowAnchor;
    const matchingParam = Object.entries(params).find(([, value]) => value === anchor)?.[0];
    const s: LocatorStrategy = {
      kind: "row_anchored",
      anchorText: anchor,
      anchorParam: matchingParam,
      targetRole: target.role,
      columnIndex: target.context.columnIndex,
    };
    if (isUnique({ ...s, anchorParam: undefined })) {
      candidates.push(s);
      reasons.push(
        matchingParam
          ? `row is located by the ${matchingParam} parameter, so the step follows the caller's input`
          : "row is located by its leading cell",
      );
    }
  }

  if (derived) {
    const s: LocatorStrategy = {
      kind: "label_adjacent",
      labelText: derived,
      targetRole: target.role,
      exact: false,
    };
    if (isUnique(s)) {
      candidates.push(s);
      reasons.push("field has no accessible name; identified by the visible text beside it");
    }
  }

  const positional: LocatorStrategy = {
    kind: "nth_of_role",
    role: target.role,
    index: target.context.roleIndex,
    frame: target.context.frame,
  };
  if (isUnique(positional)) {
    candidates.push(positional);
    reasons.push("positional fallback within the frame");
  }

  // Coordinates only when nothing semantic worked. Recording them routinely
  // would mean replay silently clicking a point on screen whenever a better
  // rung failed, which is how automation ends up doing something nobody
  // intended.
  if (candidates.length === 0 && target.box) {
    const viewportWidth = 1280;
    const viewportHeight = 900;
    candidates.push({
      kind: "coordinates",
      xRatio: Math.min(1, (target.box.x + target.box.width / 2) / viewportWidth),
      yRatio: Math.min(1, (target.box.y + target.box.height / 2) / viewportHeight),
      frame: target.context.frame,
    });
    reasons.push("no semantic strategy was unique; recorded as coordinates and flagged low confidence");
  }

  const strategies = normalizeLadder(candidates);

  return {
    description: `${target.role} ${JSON.stringify(name || derived || "(unnamed)")}${
      target.context.region ? ` in ${target.context.region}` : ""
    }`,
    frame: target.context.frame,
    strategies,
    confidence: scoreConfidence(strategies),
    rationale: reasons.join("; "),
  };
}

/** Replace concrete parameter values in text with {paramName} placeholders. */
function parameterizeText(text: string, params: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(params)) {
    if (value && value.length >= 2) out = out.split(value).join(`{${key}}`);
  }
  return out;
}

/**
 * Is this text safe and stable enough to assert on?
 *
 * Two independent reasons to reject a candidate, and the first version of this
 * recorder had neither, which produced a genuinely bad artifact:
 *
 *   - It contained regulated data. The member detail screen renders a tax ID,
 *     and "newest distinctive line on screen" happily selected the row
 *     containing it — writing an SSN into a file intended to be committed and
 *     code-reviewed. Redaction at the evidence writer did not catch it because
 *     the artifact takes a different path to disk. Anything the redactor would
 *     touch is rejected outright rather than masked: a checkpoint asserting
 *     "<redacted:ssn>" would never match anything anyway.
 *
 *   - It was a concatenated table row. "10001\tWhitfield, Dana\tRiverside" is
 *     one specific record's field values. It passes on the member it was
 *     recorded against and fails on every other one, which is the opposite of
 *     a reusable capability.
 *
 * What survives is UI chrome — panel titles, headings, status lines — which is
 * what a human would point at to say "yes, we got there".
 */
function isSafeCheckpointText(text: string): boolean {
  if (defaultRedactor.redact(text) !== text) return false;
  if (text.includes("\t")) return false;
  return true;
}

/** Prefer label-like text over data-like text. */
function checkpointScore(text: string, params: Record<string, string>): number {
  const parameterized = parameterizeText(text, params);
  const digits = (parameterized.replace(/\{[a-zA-Z0-9_]+\}/g, "").match(/\d/g) ?? []).length;
  const digitRatio = digits / Math.max(1, parameterized.length);
  // Length is evidence of specificity; leftover digits are evidence of
  // record-specific data that will not hold for another input.
  return parameterized.length - digitRatio * 200;
}

/**
 * Derive a post-condition for a step from what actually changed on screen.
 *
 * Preference order is deliberate: newly-appeared distinctive text is the
 * strongest evidence that the *intended* thing happened, whereas a title or URL
 * change only shows that *something* happened. A step that navigated to the
 * right page but rendered an error would pass a URL check and fail a text one.
 */
function deriveCheckpoint(
  entry: TranscriptAction,
  params: Record<string, string>,
): Checkpoint | undefined {
  const before = entry.observationBefore;
  const after = entry.observationAfter;

  const beforeLines = new Set(
    before.text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const newLines = after.text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 8 && l.length <= 70 && !beforeLines.has(l))
    .filter(isSafeCheckpointText);

  if (newLines.length) {
    const best = newLines.sort((a, b) => checkpointScore(b, params) - checkpointScore(a, params))[0]!;
    return { kind: "text_present", text: parameterizeText(best, params) };
  }

  if (after.title && after.title !== before.title) {
    return { kind: "title_matches", pattern: escapeRegex(parameterizeText(after.title, params)) };
  }

  if (after.location !== before.location) {
    const path = safePath(after.location);
    return { kind: "location_matches", pattern: escapeRegex(parameterizeText(path, params)) };
  }

  return undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safePath(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return url.pathname + url.search;
  } catch {
    return rawUrl;
  }
}

/** Decide where a typed value should come from in the artifact. */
function valueSourceFor(entry: TranscriptAction, params: Record<string, string>): ValueSource {
  if (entry.secretRef) return { kind: "secret", ref: entry.secretRef };

  const typed = entry.typedText ?? entry.selectedValue ?? "";
  const match = Object.entries(params).find(([, value]) => value === typed);
  if (match) return { kind: "param", param: match[0] };

  return { kind: "literal", value: typed };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 32) || "step";
}

/**
 * Final guard before an artifact is written.
 *
 * The checkpoint filter above is a heuristic over one known path into the
 * artifact. This is the backstop: serialize the finished artifact and refuse it
 * if anything the redactor recognises survives anywhere in it — a checkpoint, a
 * locator description, an intent string the model wrote, a parameter example.
 *
 * It throws rather than masking. An artifact is meant to be committed and code
 * reviewed; silently writing a file with regulated data masked out would hide
 * the fact that a new path to disk had opened up. A loud failure gets the leak
 * fixed at its source.
 */
export function assertArtifactIsClean(capability: Capability): void {
  const serialized = JSON.stringify(capability);
  const redacted = defaultRedactor.redact(serialized);
  if (redacted === serialized) return;

  const leaked = [...redacted.matchAll(/<redacted:([a-z_]+)>/g)].map((m) => m[1]);
  throw new Error(
    `refusing to write artifact ${capability.id}@${capability.version}: it contains regulated data ` +
      `(${[...new Set(leaked)].join(", ")}). This is a recorder bug — the value should never have ` +
      `reached the artifact. Check checkpoint derivation and locator descriptions.`,
  );
}

export function recordCapability(outcome: DiscoveryOutcome, options: RecorderOptions): Capability {
  if (outcome.status !== "succeeded" || !outcome.completion) {
    throw new Error(
      `cannot record a capability from a discovery run that ended "${outcome.status}". ` +
        "Only a run that reached the goal produces a replayable artifact.",
    );
  }

  const params = outcome.params;
  const steps: Step[] = [];
  const outputs: OutputSpec[] = [];
  const usedIds = new Set<string>();

  const actions = outcome.entries.filter((e): e is TranscriptAction => !isHandoff(e));
  // Only successful actions belong in the artifact. A failed attempt the model
  // recovered from describes the discovery process, not the flow.
  const successful = actions.filter((e) => e.ok);

  for (const entry of successful) {
    const locator = entry.target
      ? buildLocator(
          entry.target,
          entry.observationBefore,
          params,
          entry.tool === "extract" ? "extract" : "act",
        )
      : undefined;

    let action: StepAction;
    let risk: RiskClass = "read_only";

    switch (entry.tool) {
      case "click":
        if (!locator) continue;
        action = { kind: "click", target: locator };
        risk = classifyAction(
          { type: "click", ref: entry.target!.ref },
          { targetName: entry.target!.name || entry.target!.derivedName, targetRole: entry.target!.role },
        );
        break;

      case "type":
      case "type_secret":
        if (!locator) continue;
        action = { kind: "type", target: locator, value: valueSourceFor(entry, params), clearFirst: true };
        risk = "reversible_write";
        break;

      case "select":
        if (!locator) continue;
        action = { kind: "select", target: locator, value: valueSourceFor(entry, params) };
        risk = "reversible_write";
        break;

      case "extract": {
        if (!entry.output) continue;
        action = { kind: "extract", output: entry.output.name, target: locator };
        outputs.push({
          name: entry.output.name,
          type: (entry.output.valueType as OutputSpec["type"]) ?? "string",
          description: entry.output.description,
          required: true,
          // Extracted values come off a member record. Treating them as
          // internal rather than public keeps them out of catalog listings.
          sensitivity: "internal",
        });
        break;
      }

      default:
        continue;
    }

    let id = `s${steps.length + 1}_${slugify(entry.why || entry.tool)}`;
    while (usedIds.has(id)) id = `${id}_x`;
    usedIds.add(id);

    /**
     * Assert the screen before acting on it.
     *
     * Without this, a step whose strong locator rungs all fail still proceeds
     * to its positional fallback — and a positional fallback will match
     * *something* on almost any screen. When a session expires mid-flow the
     * result is a step typing a member number into a login form. Carrying the
     * previous step's checkpoint forward as this step's precondition closes
     * that gap: it is already known to be a stable, parameterized assertion
     * about exactly the screen this step expects.
     */
    const previous = steps.at(-1);
    const precondition = previous?.checkpoint;

    steps.push({
      id,
      intent: entry.why,
      action,
      precondition,
      checkpoint: deriveCheckpoint(entry, params),
      recovery: [],
      riskClass: risk,
      timeoutMs: 15_000,
    });
  }

  if (steps.length === 0) {
    throw new Error("discovery produced no replayable steps");
  }

  const inputs: ParamSpec[] = Object.entries(params).map(([name, value]) => {
    const override = options.paramSpecs?.[name] ?? {};
    const sensitivity = override.sensitivity ?? "internal";
    return {
      name,
      type: override.type ?? "string",
      required: override.required ?? true,
      description: override.description ?? `Value supplied by the caller for ${name}.`,
      sensitivity,
      pattern: override.pattern,
      enum: override.enum,
      default: override.default,
      // Never advertise an example for regulated data, even a synthetic one —
      // examples get copied into tickets and test fixtures.
      example: sensitivity === "pii" || sensitivity === "secret" ? undefined : (override.example ?? value),
    };
  });

  const modelOutcomes: BusinessOutcomeSpec[] = outcome.completion.knownOutcomes.map((o) => ({
    code: o.code,
    description: o.description,
    detect: { kind: "text_present", text: o.detectText },
    message: o.message,
    partialOutputs: [],
    // Proposed by a model that only ever saw the happy path. Its detection
    // text has not been confirmed against the screen it claims to identify.
    verified: false,
  }));

  // Profile outcomes win on code collision: they are vetted per product, the
  // model's are proposed from a single run.
  const byCode = new Map<string, BusinessOutcomeSpec>();
  for (const o of modelOutcomes) byCode.set(o.code, o);
  for (const o of options.profile?.knownOutcomes ?? []) byCode.set(o.code, o);

  const handoffs = outcome.entries.filter(isHandoff);
  const notes = [
    options.notes,
    handoffs.length
      ? `This flow required ${handoffs.length} human intervention(s) during discovery. The operator's actions were not recorded as steps because their precise targets are unknown; review this artifact for a gap where manual work occurred.`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  const capability: Capability = {
    schemaVersion: SCHEMA_VERSION,
    id: options.capabilityId,
    version: options.version ?? "1.0.0",
    name: options.name,
    description: options.description,

    surface: {
      kind: "web",
      app: options.product,
      entryPoint: outcome.finalObservation
        ? new URL(outcome.finalObservation.location).origin
        : "",
    },

    tenant: {
      product: options.product,
      recordedOnTenant: options.tenantId,
      verifiedTenants: [options.tenantId],
      overrides: {},
    },

    inputs,
    outputs,

    steps,
    successCondition: {
      kind: "text_present",
      text: parameterizeText(outcome.completion.successEvidence, params),
    },

    knownOutcomes: [...byCode.values()],
    globalRecovery: options.profile?.globalRecovery ?? [],

    riskClass: aggregateRisk(steps),

    provenance: {
      recordedAt: new Date().toISOString(),
      recordedBy: outcome.model,
      discoveryRunId: outcome.runId,
      humanEdited: false,
      notes: notes || undefined,
    },

    // Every recording starts as a draft. Promotion to approved is a human act,
    // and unattended invocation requires it.
    approval: { state: "draft" },
    stability: { attempts: 0, successes: 0, degradedResolutions: 0 },
  };

  assertArtifactIsClean(capability);
  return capability;
}
