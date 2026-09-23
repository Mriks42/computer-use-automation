/**
 * Goal definitions.
 *
 * A discovery run needs more than a sentence. It needs to know which parameters
 * the resulting capability should expose, how each is classified, and which
 * credentials the agent may use without seeing them. Putting that in a file
 * rather than in CLI flags means the parameter contract is reviewed and
 * versioned alongside the artifact it produces — and it is the contract, not
 * the prose goal, that a calling agent ends up depending on.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { SensitivitySchema, ValueTypeSchema } from "../capability/schema.js";

export const GoalParamSchema = z.object({
  /** Concrete value used for the discovery run. Becomes a named parameter. */
  value: z.string(),
  type: ValueTypeSchema.default("string"),
  description: z.string(),
  sensitivity: SensitivitySchema.default("internal"),
  pattern: z.string().optional(),
  enum: z.array(z.string()).optional(),
});

export const GoalFileSchema = z.object({
  capabilityId: z.string(),
  name: z.string(),
  description: z.string(),
  /** Natural-language instruction given to the model. */
  goal: z.string(),
  /** Vendor product, used to pick the surface profile. */
  product: z.string(),
  tenantId: z.string(),
  entryPoint: z.string().optional(),
  params: z.record(z.string(), GoalParamSchema).default({}),
  /** Environment variable names the agent may reference via type_secret. */
  secrets: z.array(z.string()).default([]),
  expectedOutputs: z.array(z.string()).default([]),
  maxSteps: z.number().int().positive().default(25),
});

export type GoalFile = z.infer<typeof GoalFileSchema>;

export function loadGoal(path: string): GoalFile {
  return GoalFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Split a goal file into the pieces the loop and the recorder each need. */
export function goalParts(goal: GoalFile) {
  const params = Object.fromEntries(Object.entries(goal.params).map(([k, v]) => [k, v.value]));

  const paramSpecs = Object.fromEntries(
    Object.entries(goal.params).map(([k, v]) => [
      k,
      {
        type: v.type,
        description: v.description,
        sensitivity: v.sensitivity,
        pattern: v.pattern,
        enum: v.enum,
      },
    ]),
  );

  const secrets: Record<string, string> = {};
  for (const name of goal.secrets) {
    const value = process.env[name];
    if (value) secrets[name] = value;
  }

  return { params, paramSpecs, secrets };
}
