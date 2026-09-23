/**
 * Pure matching of a locator strategy against an observation.
 *
 * Kept free of any browser dependency so the targeting rules — the part most
 * likely to be subtly wrong — can be tested against fixture observations
 * without launching anything. The two strategies that genuinely need the live
 * page (css, coordinates) are handled by the adapter instead.
 */

import type { LocatorStrategy } from "./locator.js";
import type { Observation, UiElement } from "./types.js";

/**
 * Text comparison tuned for back-office markup.
 *
 * Collapses whitespace, ignores case, and strips a trailing colon — because a
 * cell reading "Member ID or Last Name:" is the label for a field a reviewer
 * would describe as "Member ID or Last Name", and a flow should not break over
 * the punctuation.
 */
export function normalizeText(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim().replace(/[:：]\s*$/, "").toLowerCase();
}

function textMatches(candidate: string | undefined, expected: string, exact: boolean): boolean {
  const a = normalizeText(candidate);
  const b = normalizeText(expected);
  if (!b) return false;
  return exact ? a === b : a.includes(b);
}

/** An element's name for matching purposes: the real one, or the derived one. */
function namesOf(el: UiElement): string[] {
  return [el.name, el.derivedName, el.context.labelText].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

function matchesAnyName(el: UiElement, expected: string, exact: boolean): boolean {
  return namesOf(el).some((n) => textMatches(n, expected, exact));
}

/**
 * Returns every element satisfying the strategy, in document order.
 *
 * Callers decide what a multi-match means. Replay treats it as ambiguity and
 * falls to the next rung rather than guessing, because picking the first of
 * several matching "Submit" buttons is exactly how automation posts the wrong
 * form.
 */
export function matchStrategy(observation: Observation, strategy: LocatorStrategy): UiElement[] {
  const visible = observation.elements.filter((e) => e.visible);

  switch (strategy.kind) {
    case "role_name":
      return visible.filter(
        (e) => e.role === strategy.role && matchesAnyName(e, strategy.name, strategy.exact),
      );

    case "role_name_in_region":
      return visible.filter(
        (e) =>
          e.role === strategy.role &&
          matchesAnyName(e, strategy.name, strategy.exact) &&
          textMatches(e.context.region, strategy.region, true),
      );

    case "row_anchored": {
      const anchor = strategy.anchorText;
      if (!anchor) return [];
      return visible.filter((e) => {
        if (e.role !== strategy.targetRole) return false;
        if (!textMatches(e.context.rowAnchor, anchor, true)) return false;
        if (strategy.columnIndex !== undefined && e.context.columnIndex !== strategy.columnIndex) {
          return false;
        }
        if (strategy.targetName && !matchesAnyName(e, strategy.targetName, false)) return false;
        return true;
      });
    }

    case "label_adjacent":
      return visible.filter(
        (e) =>
          e.role === strategy.targetRole &&
          (textMatches(e.derivedName, strategy.labelText, strategy.exact) ||
            textMatches(e.context.labelText, strategy.labelText, strategy.exact) ||
            textMatches(e.name, strategy.labelText, strategy.exact)),
      );

    case "nth_of_role":
      return visible.filter(
        (e) =>
          e.role === strategy.role &&
          e.context.roleIndex === strategy.index &&
          (!strategy.frame || e.context.frame === strategy.frame),
      );

    case "css":
    case "coordinates":
      // Require the live page; resolved by the adapter.
      return [];
  }
}

/**
 * Read a value out of an observation for output extraction.
 *
 * Prefers the element's own value, then its accessible name, then its text —
 * which for a table cell is the cell contents, and that is usually what a
 * capability wants to return.
 */
export function readElementValue(el: UiElement): string {
  return (el.value ?? el.name ?? el.derivedName ?? "").trim();
}
