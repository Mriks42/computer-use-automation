/**
 * Builds an accessibility-equivalent view of a document.
 *
 * Why not just use Playwright's accessibility snapshot: on the markup this
 * system targets, it returns almost nothing useful. An unlabelled `<input>`
 * inside a layout table has no accessible name, so it arrives as an anonymous
 * textbox indistinguishable from the two other anonymous textboxes on the form.
 * A human operator has no such trouble — they read the words in the cell to the
 * left and know exactly which field it is.
 *
 * So this extractor computes two things per element: the real accessible name
 * where the markup earns one, and a *derived* name reconstructed from layout
 * context where it does not. The derived name is what makes rung-3
 * (`label_adjacent`) targeting possible, and rung 3 is where most legacy form
 * fields actually get hit.
 *
 * This function is serialized and executed inside the page, once per frame, so
 * it must not close over anything outside its own body.
 */

import type { UiElement } from "./types.js";

/** Runs in the browser. One frame per call. */
export function extractElements(frameId: string): {
  elements: UiElement[];
  text: string;
  title: string;
  signals: { kind: string; detail: string }[];
} {
  const REF_ATTR = "data-cua-ref";

  const roleOf = (el: Element): string | undefined => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;

    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : undefined;
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "table") return "table";
    if (tag === "tr") return "row";
    if (tag === "th") return "columnheader";
    if (tag === "td") return "cell";
    if (tag === "form") return "form";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return "img";
    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "hidden") return undefined;
      return "textbox";
    }
    return undefined;
  };

  const textOf = (el: Element | null | undefined): string => {
    if (!el) return "";
    return (el.textContent ?? "").replace(/\s+/g, " ").trim();
  };

  /**
   * Accessible name, following the ARIA precedence order closely enough for
   * this purpose. Returns empty string when the markup provides none — which
   * on these surfaces is the common case, and is the signal to fall back to a
   * derived name rather than to invent one.
   */
  const accessibleName = (el: Element): string => {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => textOf(el.ownerDocument.getElementById(id)))
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }

    const tag = el.tagName.toLowerCase();

    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") {
        return (el.getAttribute("value") ?? "").trim();
      }
      const id = el.getAttribute("id");
      if (id) {
        const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label) return textOf(label);
      }
      const wrapping = el.closest("label");
      if (wrapping) return textOf(wrapping);
      return "";
    }

    if (tag === "img") return (el.getAttribute("alt") ?? "").trim();

    if (tag === "a" || tag === "button" || /^h[1-6]$/.test(tag) || tag === "td" || tag === "th") {
      return textOf(el);
    }

    return (el.getAttribute("title") ?? "").trim();
  };

  /**
   * Reconstructs the label a human reads. In table-based layouts the field's
   * meaning sits in the previous cell; in linear forms it sits in the text node
   * or element immediately before the control.
   */
  const derivedName = (el: Element): string => {
    const cell = el.closest("td, th");
    if (cell) {
      let prev = cell.previousElementSibling;
      while (prev) {
        const t = textOf(prev);
        if (t) return t;
        prev = prev.previousElementSibling;
      }
      // Some layouts put the label in the row above rather than to the left.
      const row = cell.closest("tr");
      const prevRow = row?.previousElementSibling;
      if (prevRow) {
        const cells = Array.from(row!.children);
        const idx = cells.indexOf(cell);
        const above = prevRow.children[idx];
        const t = textOf(above);
        if (t) return t;
      }
    }

    let sib = el.previousElementSibling;
    while (sib) {
      const t = textOf(sib);
      if (t) return t;
      sib = sib.previousElementSibling;
    }

    const parent = el.parentElement;
    if (parent) {
      const own = textOf(parent).replace(textOf(el), "").trim();
      if (own) return own;
    }
    return "";
  };

  /** Nearest titled panel, landmark, or fieldset. Used to scope rung-1 lookups. */
  const regionOf = (el: Element): string | undefined => {
    let node: Element | null = el;
    while (node) {
      const role = node.getAttribute?.("role");
      if (role === "region" || role === "dialog" || role === "alertdialog") {
        const labelled = node.getAttribute("aria-label");
        if (labelled) return labelled.trim();
      }
      if (node.tagName?.toLowerCase() === "fieldset") {
        const legend = node.querySelector("legend");
        if (legend) return textOf(legend);
      }
      // Titled-panel convention: a heading-like first child acting as a caption.
      // Matched structurally (first element child, visually distinct) rather
      // than by class name, so this is not specific to one app's stylesheet.
      const first = node.firstElementChild;
      if (first && first !== el && node.children.length > 1) {
        const t = textOf(first);
        const isCaption =
          t.length > 0 &&
          t.length < 80 &&
          !first.querySelector("input, select, table, a, button");
        if (isCaption) {
          const style = node.ownerDocument.defaultView?.getComputedStyle(first);
          const bold = style ? Number(style.fontWeight) >= 600 || style.fontWeight === "bold" : false;
          if (bold) return t;
        }
      }
      node = node.parentElement;
    }
    return undefined;
  };

  const isVisible = (el: Element): boolean => {
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (!style) return false;
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const doc = document;
  const elements: UiElement[] = [];
  const roleCounts: Record<string, number> = {};

  const candidates = Array.from(
    doc.querySelectorAll(
      "a[href], button, input, select, textarea, td, th, h1, h2, h3, h4, h5, h6, [role]",
    ),
  );

  let seq = 0;
  for (const el of candidates) {
    const role = roleOf(el);
    if (!role) continue;

    // Skip cells that contain their own interactive controls — the control is
    // the meaningful target, not its container.
    if ((role === "cell" || role === "columnheader") && el.querySelector("a, button, input, select")) {
      continue;
    }

    const name = accessibleName(el);
    const derived = name ? "" : derivedName(el);

    // A cell with no text and no control carries no information.
    if ((role === "cell" || role === "columnheader") && !name) continue;

    const ref = `${frameId}#${seq++}`;
    el.setAttribute(REF_ATTR, ref);

    const cell = el.closest("td, th");
    const row = el.closest("tr");
    let rowAnchor: string | undefined;
    let columnIndex: number | undefined;
    if (row) {
      const cells = Array.from(row.children);
      const firstCellText = textOf(cells[0]);
      if (firstCellText) rowAnchor = firstCellText;
      if (cell) {
        const idx = cells.indexOf(cell);
        if (idx >= 0) columnIndex = idx;
      }
    }

    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
    const rect = el.getBoundingClientRect();

    const value =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el.value
        : el instanceof HTMLSelectElement
          ? el.value
          : undefined;

    elements.push({
      ref,
      role,
      name,
      derivedName: derived || undefined,
      value: value || undefined,
      disabled: (el as HTMLInputElement).disabled === true || undefined,
      visible: isVisible(el),
      context: {
        frame: frameId,
        region: regionOf(el),
        rowAnchor,
        columnIndex,
        labelText: derived || undefined,
        roleIndex: roleCounts[role]! - 1,
      },
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }

  /**
   * Signals are limited on purpose.
   *
   * We report only what ARIA actually tells us — a dialog role, an alert role.
   * Legacy surfaces almost never provide those, so most of the time this list
   * is empty, and that is the honest answer. Recognising "this red box means
   * the transfer was rejected" is semantic, app-specific knowledge; it belongs
   * in the artifact's declared outcomes as a text checkpoint, not in a
   * heuristic here that would guess from background colours and be wrong in
   * ways nobody could debug.
   */
  const signals: { kind: string; detail: string }[] = [];
  const dialog = doc.querySelector('[role="dialog"], [role="alertdialog"]');
  if (dialog) signals.push({ kind: "dialog_present", detail: textOf(dialog).slice(0, 200) });
  const alert = doc.querySelector('[role="alert"]');
  if (alert) signals.push({ kind: "error_banner", detail: textOf(alert).slice(0, 200) });
  if (doc.readyState !== "complete") {
    signals.push({ kind: "load_incomplete", detail: doc.readyState });
  }

  return {
    elements,
    text: (doc.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim(),
    title: doc.title,
    signals,
  };
}
