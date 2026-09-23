/**
 * Checkpoint evaluation.
 *
 * Checkpoints are evaluated against an observation rather than against the
 * surface directly, so the same evaluation runs in tests over fixture data with
 * no browser involved. The one exception is element presence, which needs to
 * walk a locator ladder, so the caller injects a resolver.
 *
 * Every evaluation returns a human-readable description of what it checked and
 * what it saw, because a failed checkpoint is the single most common thing a
 * person will have to debug, and "checkpoint failed" on its own is useless.
 */

import { interpolate, type Checkpoint } from "../capability/schema.js";
import type { LocatorDescriptor } from "../surface/locator.js";
import type { Observation } from "../surface/types.js";

export interface CheckpointResult {
  passed: boolean;
  /** What was required. */
  expected: string;
  /** What was actually there. */
  observed: string;
}

export type LocatorResolver = (
  locator: LocatorDescriptor,
) => Promise<{ ref: string; rung: number } | undefined>;

export interface CheckpointContext {
  observation: Observation;
  params: Record<string, unknown>;
  resolveLocator: LocatorResolver;
}

function excerptAround(text: string, needle: string, radius = 60): string {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return text.slice(0, 160).replace(/\s+/g, " ").trim();
  return `…${text.slice(Math.max(0, idx - radius), idx + needle.length + radius).replace(/\s+/g, " ").trim()}…`;
}

export async function evaluateCheckpoint(
  checkpoint: Checkpoint,
  ctx: CheckpointContext,
): Promise<CheckpointResult> {
  const { observation, params } = ctx;

  switch (checkpoint.kind) {
    case "text_present": {
      const needle = interpolate(checkpoint.text, params);
      const haystack = checkpoint.caseSensitive ? observation.text : observation.text.toLowerCase();
      const probe = checkpoint.caseSensitive ? needle : needle.toLowerCase();
      const passed = haystack.includes(probe);
      return {
        passed,
        expected: `text ${JSON.stringify(needle)} present on screen`,
        observed: passed
          ? excerptAround(observation.text, needle)
          : `not found; screen shows ${JSON.stringify(observation.text.slice(0, 160).replace(/\s+/g, " ").trim())}`,
      };
    }

    case "text_absent": {
      const needle = interpolate(checkpoint.text, params);
      const haystack = checkpoint.caseSensitive ? observation.text : observation.text.toLowerCase();
      const probe = checkpoint.caseSensitive ? needle : needle.toLowerCase();
      const passed = !haystack.includes(probe);
      return {
        passed,
        expected: `text ${JSON.stringify(needle)} absent`,
        observed: passed ? "absent as required" : excerptAround(observation.text, needle),
      };
    }

    case "element_present": {
      const resolved = await ctx.resolveLocator(checkpoint.locator);
      return {
        passed: Boolean(resolved),
        expected: `element present: ${checkpoint.locator.description}`,
        observed: resolved ? `resolved at rung ${resolved.rung}` : "no rung of the locator ladder resolved",
      };
    }

    case "element_absent": {
      const resolved = await ctx.resolveLocator(checkpoint.locator);
      return {
        passed: !resolved,
        expected: `element absent: ${checkpoint.locator.description}`,
        observed: resolved ? `still present (rung ${resolved.rung})` : "absent as required",
      };
    }

    case "location_matches": {
      const pattern = interpolate(checkpoint.pattern, params);
      const passed = new RegExp(pattern).test(observation.location);
      return {
        passed,
        expected: `location matching /${pattern}/`,
        observed: observation.location,
      };
    }

    case "title_matches": {
      const pattern = interpolate(checkpoint.pattern, params);
      const passed = new RegExp(pattern).test(observation.title);
      return {
        passed,
        expected: `title matching /${pattern}/`,
        observed: observation.title || "(no title)",
      };
    }

    case "all": {
      const results = await Promise.all(checkpoint.of.map((c) => evaluateCheckpoint(c, ctx)));
      const failed = results.find((r) => !r.passed);
      return {
        passed: !failed,
        expected: `all of: ${results.map((r) => r.expected).join(" AND ")}`,
        observed: failed ? failed.observed : "all conditions held",
      };
    }

    case "any": {
      const results = await Promise.all(checkpoint.of.map((c) => evaluateCheckpoint(c, ctx)));
      const passed = results.find((r) => r.passed);
      return {
        passed: Boolean(passed),
        expected: `any of: ${results.map((r) => r.expected).join(" OR ")}`,
        observed: passed ? passed.observed : results.map((r) => r.observed).join(" | "),
      };
    }

    case "not": {
      const inner = await evaluateCheckpoint(checkpoint.of, ctx);
      return {
        passed: !inner.passed,
        expected: `NOT (${inner.expected})`,
        observed: inner.observed,
      };
    }
  }
}

/**
 * Conditions recognised without the artifact having to declare them.
 *
 * Only consulted once something has already gone wrong, so a page that happens
 * to contain the word "error" in body copy cannot derail a healthy run. The
 * purpose is to turn a generic "checkpoint failed" into a specific, actionable
 * class — "the application signed us out" is a very different ticket from
 * "the button moved".
 */
export function classifySurfaceCondition(
  observation: Observation,
): { class: "session_expired" | "surface_error"; detail: string } | undefined {
  const text = observation.text.toLowerCase();

  if (/session has expired|please sign on again|your session has timed out|sign on/i.test(text) &&
      /expired|timed out/i.test(text)) {
    return { class: "session_expired", detail: "the application returned a sign-on page mid-flow" };
  }

  if (observation.signals.some((s) => s.kind === "http_error")) {
    const signal = observation.signals.find((s) => s.kind === "http_error")!;
    return { class: "surface_error", detail: signal.detail };
  }

  if (/an unexpected error occurred|system error|reference mc-\d+/i.test(text)) {
    return { class: "surface_error", detail: "the application rendered a system error page" };
  }

  return undefined;
}
