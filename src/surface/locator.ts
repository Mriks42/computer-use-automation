/**
 * Durable element targeting.
 *
 * The problem this solves: at discovery time the model acts on ephemeral refs.
 * Those refs are meaningless a second later. To replay a flow we need a
 * description of "which control" that survives a fresh session, a different
 * day, and a tenant running a slightly different build of the same product.
 *
 * Legacy back-office markup gives us nothing to hang that on — no test IDs, no
 * stable ids, no `for`/`id` label association, class names that are either
 * absent or generated. So a single selector is the wrong shape. Instead a
 * LocatorDescriptor is an *ordered ladder* of strategies, recorded strongest
 * first, and replay walks down it until one resolves.
 *
 * Two properties make this worth the complexity:
 *
 *   1. Degradation is graceful. A build that renames a CSS class does not break
 *      a flow that primarily targets by role and accessible name.
 *
 *   2. Degradation is *observable*. Replay records which rung resolved. A step
 *      that has always resolved at rung 0 and now resolves at rung 2 is a drift
 *      signal — which is how per-tenant drift gets detected without anyone
 *      hand-auditing thousands of app instances.
 *
 * The ladder is ordered by how much each strategy assumes about the surface.
 * Semantic strategies (role + accessible name) sit at the top because they are
 * the ones that also hold on a desktop accessibility tree. Coordinates sit at
 * the bottom because they assume everything.
 */

import { z } from "zod";

export const LocatorStrategySchema = z.discriminatedUnion("kind", [
  /**
   * Rung 0. Role plus accessible name. Survives layout changes, restyling and
   * most markup rewrites, and is the one strategy that transfers unchanged to a
   * desktop AX/UIA tree.
   */
  z.object({
    kind: z.literal("role_name"),
    role: z.string(),
    name: z.string(),
    exact: z.boolean().default(true),
  }),

  /**
   * Rung 1. Role plus name, scoped to an enclosing region (a titled panel, a
   * landmark, a frame). Disambiguates the common back-office case of the same
   * control name appearing in several panels on one screen.
   */
  z.object({
    kind: z.literal("role_name_in_region"),
    role: z.string(),
    name: z.string(),
    region: z.string(),
    exact: z.boolean().default(true),
  }),

  /**
   * Rung 2. The workhorse for table-based layouts. Finds the row whose first
   * cell matches an anchor, then takes a control or cell by column index within
   * that row.
   *
   * The anchor may itself be parameterized — "the row for the member ID the
   * caller passed in" — which is what makes a recorded grid interaction
   * reusable across different inputs rather than pinned to whatever record
   * happened to be on screen during discovery.
   */
  z.object({
    kind: z.literal("row_anchored"),
    anchorText: z.string().optional(),
    anchorParam: z.string().optional(),
    targetRole: z.string(),
    columnIndex: z.number().int().nonnegative().optional(),
    targetName: z.string().optional(),
  }),

  /**
   * Rung 3. For inputs with no accessible name at all, which is the norm in
   * these apps. Targets a control by the visible text that a human reads as its
   * label — typically the table cell immediately to its left — even though no
   * markup connects the two.
   */
  z.object({
    kind: z.literal("label_adjacent"),
    labelText: z.string(),
    targetRole: z.string(),
    exact: z.boolean().default(false),
  }),

  /**
   * Rung 4. Positional within a role. Brittle by construction, but on a form
   * with three unlabelled text inputs and no other distinguishing feature it is
   * sometimes the only honest option. Recorded with low confidence so the
   * confidence score of the whole artifact reflects it.
   */
  z.object({
    kind: z.literal("nth_of_role"),
    role: z.string(),
    index: z.number().int().nonnegative(),
    frame: z.string().optional(),
  }),

  /**
   * Rung 5. A raw CSS selector. Web-only, and therefore a dead end for the
   * desktop story — included because refusing to record it would just push
   * people to hand-edit artifacts, which is worse. Flagged so reviewers can see
   * where a flow has taken on web-specific debt.
   */
  z.object({
    kind: z.literal("css"),
    selector: z.string(),
    frame: z.string().optional(),
  }),

  /**
   * Rung 6. Viewport coordinates, normalized 0..1 so a different window size
   * degrades rather than misfires outright. Last resort, and the only strategy
   * that cannot be reviewed meaningfully by a human reading the artifact.
   */
  z.object({
    kind: z.literal("coordinates"),
    xRatio: z.number().min(0).max(1),
    yRatio: z.number().min(0).max(1),
    frame: z.string().optional(),
  }),
]);

export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

/** How much trust the recorder places in a ladder's strongest rung. */
export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const LocatorDescriptorSchema = z.object({
  /** Human-readable, for artifact review. Not used for matching. */
  description: z.string(),
  /** Frame or window this element lived in at record time. */
  frame: z.string().default("main"),
  /** Ordered ladder, strongest first. Replay walks it top down. */
  strategies: z.array(LocatorStrategySchema).min(1),
  confidence: ConfidenceSchema,
  /**
   * Why this ladder was chosen. Written by the recorder, read by humans during
   * artifact review. This is what makes "reviewable" mean something.
   */
  rationale: z.string().optional(),
});

export type LocatorDescriptor = z.infer<typeof LocatorDescriptorSchema>;

/** Rung ordering, used to score confidence and to detect drift. */
const STRATEGY_RANK: Record<LocatorStrategy["kind"], number> = {
  role_name: 0,
  role_name_in_region: 1,
  row_anchored: 2,
  label_adjacent: 3,
  nth_of_role: 4,
  css: 5,
  coordinates: 6,
};

export function strategyRank(strategy: LocatorStrategy): number {
  return STRATEGY_RANK[strategy.kind];
}

/**
 * Confidence follows the *strongest* rung available, because that is the one
 * replay will normally use. A ladder whose best option is positional is low
 * confidence no matter how many fallbacks sit beneath it.
 */
export function scoreConfidence(strategies: LocatorStrategy[]): Confidence {
  const best = Math.min(...strategies.map(strategyRank));
  if (best <= 1) return "high";
  if (best <= 3) return "medium";
  return "low";
}

/** Sort a ladder into canonical order and drop exact duplicates. */
export function normalizeLadder(strategies: LocatorStrategy[]): LocatorStrategy[] {
  const seen = new Set<string>();
  const unique: LocatorStrategy[] = [];
  for (const s of strategies) {
    const key = JSON.stringify(s);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
  }
  return unique.sort((a, b) => strategyRank(a) - strategyRank(b));
}

/**
 * Substitute invocation parameters into a strategy.
 *
 * Only `row_anchored.anchorParam` is parameterizable today. That is a
 * deliberate limit: every additional parameterizable field is another place a
 * caller-supplied value can steer targeting, and targeting that a caller can
 * steer is targeting an attacker can steer. Widening this needs a policy
 * conversation, not just a schema change.
 */
export function bindStrategy(
  strategy: LocatorStrategy,
  params: Record<string, unknown>,
): LocatorStrategy {
  if (strategy.kind !== "row_anchored") return strategy;
  if (!strategy.anchorParam) return strategy;

  const bound = params[strategy.anchorParam];
  if (bound === undefined || bound === null) return strategy;

  return { ...strategy, anchorText: String(bound) };
}

export function describeStrategy(strategy: LocatorStrategy): string {
  switch (strategy.kind) {
    case "role_name":
      return `${strategy.role} named "${strategy.name}"`;
    case "role_name_in_region":
      return `${strategy.role} named "${strategy.name}" in region "${strategy.region}"`;
    case "row_anchored":
      return `${strategy.targetRole} in row anchored by "${
        strategy.anchorParam ? `{${strategy.anchorParam}}` : strategy.anchorText
      }"${strategy.columnIndex !== undefined ? ` at column ${strategy.columnIndex}` : ""}`;
    case "label_adjacent":
      return `${strategy.targetRole} labelled "${strategy.labelText}"`;
    case "nth_of_role":
      return `${strategy.role} #${strategy.index}`;
    case "css":
      return `css(${strategy.selector})`;
    case "coordinates":
      return `point(${strategy.xRatio.toFixed(3)}, ${strategy.yRatio.toFixed(3)})`;
  }
}
