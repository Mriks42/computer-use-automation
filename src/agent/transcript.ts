/**
 * The discovery transcript.
 *
 * This is the intermediate representation between the model run and the
 * artifact, and it exists so the two can be decoupled. The brief asks for an
 * artifact "decoupled from the raw model transcript", and the reason that
 * matters is practical: the model's messages contain refs that are already
 * stale, reasoning that may be wrong, and phrasing that will change the next
 * time the provider ships a model. None of that belongs in a file a bank has to
 * approve and keep.
 *
 * So the loop records what *happened* — which element was acted on, with the
 * full structural context it had at that moment, and what the screen looked like
 * before and after — and the recorder turns that into durable targeting. The
 * model's own words survive in exactly one place: the `why` on each step, which
 * is there for human reviewers.
 */

import type { Observation, UiElement } from "../surface/types.js";

export interface TranscriptAction {
  index: number;
  at: string;
  /** Tool the model called. */
  tool: string;
  /** The model's stated reason. Becomes the step's intent. */
  why: string;

  /**
   * The element acted upon, captured *before* the action, along with the
   * observation it came from. Both are needed to build a locator ladder: the
   * element supplies role, names and table context; the observation supplies
   * the uniqueness information that decides which rungs are viable.
   */
  target?: UiElement;
  observationBefore: Observation;
  observationAfter: Observation;

  /** For type: the literal text entered. Rewritten to a param or secret later. */
  typedText?: string;
  /** For type_secret: the secret's name. The value is never recorded. */
  secretRef?: string;
  /** For select. */
  selectedValue?: string;
  /** For navigate. */
  url?: string;

  /** For extract. */
  output?: { name: string; valueType: string; description: string; value: string };

  ok: boolean;
  error?: string;
}

/** A human took over mid-discovery. */
export interface TranscriptHandoff {
  index: number;
  at: string;
  kind: "handoff";
  interventionId: string;
  reason: string;
  actor: string;
  note: string;
  actionCount: number;
}

export type TranscriptEntry = TranscriptAction | TranscriptHandoff;

export function isHandoff(entry: TranscriptEntry): entry is TranscriptHandoff {
  return "kind" in entry && entry.kind === "handoff";
}

export interface DiscoveryOutcome {
  status: "succeeded" | "escalated" | "exhausted" | "failed";
  goal: string;
  runId: string;
  model: string;
  entries: TranscriptEntry[];
  /** Present when the run completed the goal. */
  completion?: {
    summary: string;
    successEvidence: string;
    knownOutcomes: { code: string; description: string; detectText: string; message: string }[];
  };
  /** Parameter values supplied for this run, used to parameterize the artifact. */
  params: Record<string, string>;
  finalObservation?: Observation;
  error?: string;
}
