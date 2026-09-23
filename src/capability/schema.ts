/**
 * The capability artifact.
 *
 * This is the contract between three different readers, and its shape is driven
 * by the fact that all three have to be served at once:
 *
 *   - a calling AI agent, which needs typed inputs, typed outputs, and a
 *     truthful statement of what invoking this will do to the world;
 *   - the replay engine, which needs enough precision to execute without a
 *     model in the loop;
 *   - a human reviewer at a regulated institution, who has to be able to read
 *     it and decide whether to approve it.
 *
 * The third reader is why intents, rationales and descriptions are carried
 * alongside the machine-readable parts rather than being stripped out. An
 * artifact that only a machine can check is not reviewable, and an unreviewable
 * artifact does not get approved for unattended use in a bank.
 *
 * Two structural decisions carry most of the weight:
 *
 *   1. `knownOutcomes` sits beside `steps` as a first-class field. A flow is
 *      not "the happy path, plus errors". It is a set of legitimate
 *      destinations, only one of which is the one you were hoping for. This is
 *      what keeps "no such member" from being modelled as a crash.
 *
 *   2. Values are never inlined. Steps reference parameters and secrets by
 *      name. The artifact records that a field was filled with `{memberId}`,
 *      never with `10001`, and that a password came from secret `MERIDIAN_PASSWORD`,
 *      never the password. Reuse and non-disclosure turn out to want the same
 *      thing.
 */

import { z } from "zod";
import { LocatorDescriptorSchema } from "../surface/locator.js";

export const SCHEMA_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Typed values
// ---------------------------------------------------------------------------

export const ValueTypeSchema = z.enum(["string", "number", "currency", "date", "boolean"]);
export type ValueType = z.infer<typeof ValueTypeSchema>;

/**
 * Data classification, which drives redaction.
 *
 * `pii` and `secret` values are never written to artifacts, logs, or evidence.
 * Classification lives on the parameter rather than being inferred from the
 * value, because inferring it means guessing, and guessing wrong about
 * regulated data is the expensive direction to be wrong in.
 */
export const SensitivitySchema = z.enum(["public", "internal", "pii", "secret"]);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const ParamSpecSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: ValueTypeSchema,
  required: z.boolean().default(true),
  description: z.string(),
  sensitivity: SensitivitySchema.default("internal"),
  /** Validated before any action is taken. A bad input should never reach the UI. */
  pattern: z.string().optional(),
  enum: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Safe to show in a catalog. Omitted entirely for pii/secret params. */
  example: z.string().optional(),
});
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

/** Where a value comes from when a step needs one. */
export const ValueSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("param"), param: z.string() }),
  /**
   * A pointer to a credential, resolved from the environment or a vault at
   * replay time. The artifact holds the name of the secret and never its value,
   * so an artifact file is safe to commit, diff, and review.
   */
  z.object({ kind: z.literal("secret"), ref: z.string() }),
  /** The value produced by an earlier extract step in the same run. */
  z.object({ kind: z.literal("step_output"), stepId: z.string() }),
]);
export type ValueSource = z.infer<typeof ValueSourceSchema>;

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/**
 * A condition asserted against an observation.
 *
 * Checkpoints do three different jobs in this schema — verifying a step landed,
 * detecting a business outcome, and triggering a recovery rule — and they are
 * the same type in all three because the question is always the same: is the
 * surface in this state right now?
 *
 * Text is matched against the observation's flattened text rather than against
 * markup, so a checkpoint keeps working when the app is restyled, and means the
 * same thing if the surface is later a desktop window.
 */
export type Checkpoint =
  | { kind: "text_present"; text: string; scope?: z.infer<typeof LocatorDescriptorSchema>; caseSensitive?: boolean }
  | { kind: "text_absent"; text: string; caseSensitive?: boolean }
  | { kind: "element_present"; locator: z.infer<typeof LocatorDescriptorSchema> }
  | { kind: "element_absent"; locator: z.infer<typeof LocatorDescriptorSchema> }
  | { kind: "location_matches"; pattern: string }
  | { kind: "title_matches"; pattern: string }
  | { kind: "all"; of: Checkpoint[] }
  | { kind: "any"; of: Checkpoint[] }
  | { kind: "not"; of: Checkpoint };

export const CheckpointSchema: z.ZodType<Checkpoint> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("text_present"),
      /** Supports {paramName} interpolation, so assertions can be input-specific. */
      text: z.string(),
      scope: LocatorDescriptorSchema.optional(),
      caseSensitive: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("text_absent"),
      text: z.string(),
      caseSensitive: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("element_present"), locator: LocatorDescriptorSchema }),
    z.object({ kind: z.literal("element_absent"), locator: LocatorDescriptorSchema }),
    z.object({ kind: z.literal("location_matches"), pattern: z.string() }),
    z.object({ kind: z.literal("title_matches"), pattern: z.string() }),
    z.object({ kind: z.literal("all"), of: z.array(CheckpointSchema) }),
    z.object({ kind: z.literal("any"), of: z.array(CheckpointSchema) }),
    z.object({ kind: z.literal("not"), of: CheckpointSchema }),
  ]) as z.ZodType<Checkpoint>,
);

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const RiskClassSchema = z.enum(["read_only", "reversible_write", "irreversible_write"]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const StepActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: z.string() }),
  z.object({ kind: z.literal("click"), target: LocatorDescriptorSchema }),
  z.object({
    kind: z.literal("type"),
    target: LocatorDescriptorSchema,
    value: ValueSourceSchema,
    clearFirst: z.boolean().default(true),
  }),
  z.object({ kind: z.literal("select"), target: LocatorDescriptorSchema, value: ValueSourceSchema }),
  z.object({ kind: z.literal("press"), key: z.string() }),
  z.object({ kind: z.literal("wait_for"), until: CheckpointSchema, timeoutMs: z.number().int().positive() }),
  z.object({
    kind: z.literal("extract"),
    /** Name of the declared output this populates. */
    output: z.string(),
    target: LocatorDescriptorSchema.optional(),
    /** Regex over observation text; capture group 1 wins if present. */
    pattern: z.string().optional(),
  }),
  /**
   * A designed human decision point.
   *
   * Escalation is not only an error path. Some flows legitimately require a
   * person — a judgement call, a four-eyes check on an irreversible posting —
   * and a capability that models that explicitly is safer than one that pretends
   * to be fully autonomous and gets overridden in practice. Replay pauses here,
   * raises an intervention, and continues once control comes back.
   */
  z.object({
    kind: z.literal("escalate"),
    reason: z.string(),
    suggestedAction: z.string(),
  }),
]);
export type StepAction = z.infer<typeof StepActionSchema>;

export const RecoveryRuleSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** Recognises the condition. Evaluated before the step's own checkpoint. */
  when: CheckpointSchema,
  /** Actions that clear it. Must themselves be read_only or reversible. */
  do: z.array(StepActionSchema).min(1),
  maxAttempts: z.number().int().positive().default(2),
});
export type RecoveryRule = z.infer<typeof RecoveryRuleSchema>;

export const StepSchema = z.object({
  id: z.string(),
  /**
   * Why this step exists, in the words of whoever recorded it. Carried for the
   * human reviewer and for debugging output; never used for matching.
   */
  intent: z.string(),
  action: StepActionSchema,
  /** Asserted before acting. Guards against replaying into an unexpected screen. */
  precondition: CheckpointSchema.optional(),
  /** Asserted after acting. A step with no checkpoint is a step you cannot trust. */
  checkpoint: CheckpointSchema.optional(),
  /**
   * Skip this step when the condition already holds — for example a sign-on
   * step when the session is still valid. Keeps a recorded flow usable from
   * more than one starting state.
   */
  skipIf: CheckpointSchema.optional(),
  /** Step-scoped recovery, tried before the capability-wide rules. */
  recovery: z.array(RecoveryRuleSchema).default([]),
  riskClass: RiskClassSchema.default("read_only"),
  timeoutMs: z.number().int().positive().default(15_000),
});
export type Step = z.infer<typeof StepSchema>;

// ---------------------------------------------------------------------------
// Outcomes and outputs
// ---------------------------------------------------------------------------

/**
 * A legitimate, non-exceptional end state that is not success.
 *
 * "No such member" belongs here. So does "account restricted". The caller asked
 * a question, the system has an answer, and the answer is not the one the happy
 * path produces. Modelling these as failures is the single most common design
 * mistake in this problem space: it turns a normal business answer into a page,
 * an alert, and a retry that will never succeed.
 */
export const BusinessOutcomeSpecSchema = z.object({
  /** Stable machine-readable code the calling agent branches on. */
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  description: z.string(),
  /** How replay recognises it. Checked before failure classification. */
  detect: CheckpointSchema,
  /** Message template returned to the caller; supports {param} interpolation. */
  message: z.string(),
  /** Outputs that are still meaningful when this outcome fires. */
  partialOutputs: z.array(z.string()).default([]),
  /**
   * Whether this outcome's detection has actually been confirmed against the
   * application.
   *
   * Outcomes arrive from two places and they do not deserve equal trust.
   * Profile outcomes are written per vendor product against observed screens.
   * Model-proposed outcomes are inferred by an agent that completed the happy
   * path and never saw the failure screen — so its detection text is a guess,
   * and in the first real run here it guessed wrong twice ("0 record(s)
   * matched" appears nowhere in this application).
   *
   * An unverified outcome is not harmful — text that never appears never
   * matches — but presenting it beside a vetted one as though both were
   * established is misleading to the reviewer who has to approve the artifact.
   * This flag is what makes the difference legible.
   */
  verified: z.boolean().default(false),
});
export type BusinessOutcomeSpec = z.infer<typeof BusinessOutcomeSpecSchema>;

export const OutputSpecSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: ValueTypeSchema,
  description: z.string(),
  required: z.boolean().default(true),
  sensitivity: SensitivitySchema.default("internal"),
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

/**
 * Tenant scoping.
 *
 * Not built out in this implementation, but present in the schema because
 * retrofitting tenancy onto an artifact format is the kind of migration that
 * takes a quarter. The shape is: one artifact per (vendor product, flow),
 * carrying an optional per-tenant override layer keyed by tenant id. Replay
 * resolves base-then-override, so a tenant whose "Search" button says "Find"
 * needs a three-line override, not a re-recording.
 */
export const TenantBindingSchema = z.object({
  /** The vendor product this flow was recorded against. */
  product: z.string(),
  /** Product version or build recorded at discovery time, for drift triage. */
  productVersion: z.string().optional(),
  /** Tenant the recording was made on. */
  recordedOnTenant: z.string(),
  /** Tenants known to replay cleanly against this artifact. */
  verifiedTenants: z.array(z.string()).default([]),
  /**
   * Per-tenant patches applied over the base artifact, addressed by JSON
   * pointer so an override is reviewable as a diff rather than a fork.
   */
  overrides: z
    .record(
      z.string(),
      z.array(z.object({ path: z.string(), value: z.unknown(), note: z.string().optional() })),
    )
    .default({}),
});
export type TenantBinding = z.infer<typeof TenantBindingSchema>;

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

export const ProvenanceSchema = z.object({
  recordedAt: z.string(),
  /** Model that drove the discovery run. */
  recordedBy: z.string(),
  discoveryRunId: z.string(),
  /** True once a human has edited the artifact by hand. */
  humanEdited: z.boolean().default(false),
  notes: z.string().optional(),
});

/**
 * Approval gate.
 *
 * A freshly recorded artifact is a draft. Drafts can be replayed on request but
 * are not eligible for unattended invocation by an agent. Promotion is a human
 * act. This is the cheapest useful control in the whole system: it means a
 * model's first guess at a flow can never silently become production behaviour
 * at a bank.
 */
export const ApprovalSchema = z.object({
  state: z.enum(["draft", "approved", "deprecated"]).default("draft"),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
  note: z.string().optional(),
});

export const StabilitySchema = z.object({
  attempts: z.number().int().nonnegative().default(0),
  successes: z.number().int().nonnegative().default(0),
  lastReplayAt: z.string().optional(),
  /**
   * How often each step resolved below its strongest locator rung. A rising
   * count here is the early warning that a tenant's build has drifted, well
   * before the flow actually breaks.
   */
  degradedResolutions: z.number().int().nonnegative().default(0),
});

export const CapabilitySchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** Stable dotted identifier. This is the name an agent calls. */
  id: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string(),
  /** Written for the calling agent's tool description. */
  description: z.string(),

  surface: z.object({
    kind: z.enum(["web", "desktop", "terminal"]),
    app: z.string(),
    /** Supports {param} interpolation. */
    entryPoint: z.string(),
  }),

  tenant: TenantBindingSchema,

  inputs: z.array(ParamSpecSchema).default([]),
  outputs: z.array(OutputSpecSchema).default([]),

  /** Asserted once before step 1. Confirms we are where we think we are. */
  preflight: CheckpointSchema.optional(),
  steps: z.array(StepSchema).min(1),
  /** The assertion that the goal was actually met. */
  successCondition: CheckpointSchema,

  knownOutcomes: z.array(BusinessOutcomeSpecSchema).default([]),
  /** Recovery rules evaluated at every step, e.g. dismissing interstitials. */
  globalRecovery: z.array(RecoveryRuleSchema).default([]),

  /** The worst risk class of any step. Drives whether approval is required. */
  riskClass: RiskClassSchema,

  provenance: ProvenanceSchema,
  approval: ApprovalSchema,
  stability: StabilitySchema.default({
    attempts: 0,
    successes: 0,
    degradedResolutions: 0,
  }),
});

export type Capability = z.infer<typeof CapabilitySchema>;

export function parseCapability(input: unknown): Capability {
  return CapabilitySchema.parse(input);
}

/** Interpolate {param} placeholders. Used for URLs, checkpoint text, messages. */
export function interpolate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (whole, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? whole : String(value);
  });
}

/** The strictest risk class present in a set of steps. */
export function aggregateRisk(steps: Step[]): RiskClass {
  if (steps.some((s) => s.riskClass === "irreversible_write")) return "irreversible_write";
  if (steps.some((s) => s.riskClass === "reversible_write")) return "reversible_write";
  return "read_only";
}
