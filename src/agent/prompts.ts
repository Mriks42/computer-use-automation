/**
 * Prompt construction and the agent's tool surface.
 *
 * Two decisions here shape everything downstream:
 *
 * 1. The model acts on refs, never on selectors. It is shown a numbered list of
 *    controls and picks one. This is what makes the recording trustworthy: the
 *    model cannot invent a fragile CSS path because it is never in a position
 *    to express one. Turning a ref into something durable is the recorder's job,
 *    and the recorder can see the full structural context the model never needs.
 *
 * 2. Every tool takes a `why`. That text becomes the step's `intent` in the
 *    artifact, which is what a human reviewer at a bank actually reads when
 *    deciding whether to approve the capability. Asking for it at the moment of
 *    action gets a real reason; asking for it afterwards gets a rationalisation.
 */

import type { Observation, UiElement } from "../surface/types.js";
import type { ToolSpec } from "./llm.js";

const INTERACTIVE_ROLES = new Set(["button", "link", "textbox", "combobox", "checkbox", "radio"]);

/**
 * Render an observation for the model.
 *
 * Interactive controls are listed first and never truncated away, because an
 * action the model cannot see is an action it cannot take. Cells and headings
 * are included after, trimmed to a budget, since they carry the data the flow
 * usually exists to read.
 */
export function renderObservation(observation: Observation, elementBudget = 90): string {
  const describe = (el: UiElement): string => {
    const parts = [`[${el.ref}]`, el.role];
    const label = el.name || el.derivedName || "";
    if (label) parts.push(JSON.stringify(label.slice(0, 80)));
    if (el.derivedName && el.name) parts.push(`derived=${JSON.stringify(el.derivedName.slice(0, 40))}`);
    if (el.value) parts.push(`value=${JSON.stringify(el.value.slice(0, 40))}`);
    if (el.context.frame !== "main") parts.push(`frame=${el.context.frame}`);
    if (el.context.region) parts.push(`region=${JSON.stringify(el.context.region.slice(0, 40))}`);
    if (el.context.rowAnchor) parts.push(`row=${JSON.stringify(el.context.rowAnchor.slice(0, 40))}`);
    if (el.context.columnIndex !== undefined) parts.push(`col=${el.context.columnIndex}`);
    if (el.disabled) parts.push("disabled");
    return parts.join(" ");
  };

  const visible = observation.elements.filter((e) => e.visible);
  const interactive = visible.filter((e) => INTERACTIVE_ROLES.has(e.role));
  const rest = visible.filter((e) => !INTERACTIVE_ROLES.has(e.role));
  const budgetForRest = Math.max(0, elementBudget - interactive.length);

  const sections = [
    `LOCATION: ${observation.location}`,
    `TITLE: ${observation.title}`,
    observation.signals.length
      ? `SIGNALS: ${observation.signals.map((s) => `${s.kind} (${s.detail})`).join("; ")}`
      : "SIGNALS: none",
    "",
    "CONTROLS (act on these by ref):",
    interactive.length ? interactive.map(describe).join("\n") : "  (none)",
    "",
    "CONTENT:",
    rest.slice(0, budgetForRest).map(describe).join("\n") || "  (none)",
    rest.length > budgetForRest ? `  ... ${rest.length - budgetForRest} more not shown` : "",
    "",
    "VISIBLE TEXT:",
    observation.text.slice(0, 2500),
  ];

  return sections.filter(Boolean).join("\n");
}

export function systemPrompt(input: {
  goal: string;
  entryPoint: string;
  app: string;
  paramNames: string[];
  secretRefs: string[];
  maxSteps: number;
}): string {
  return `You are operating a legacy back-office banking application through a computer-use interface, the way a trained human operator would. You cannot call any API. The only way to accomplish anything is to read the screen and act on the controls you are shown.

APPLICATION: ${input.app}
ENTRY POINT: ${input.entryPoint}
GOAL: ${input.goal}

Each turn you receive a description of what is currently on screen: a list of controls, each with a bracketed ref like [main#12], and the visible text. You act by calling exactly one tool, referencing a control by its ref. Refs change every turn — always use refs from the most recent observation, never from an earlier one.

You have at most ${input.maxSteps} actions. Work efficiently and do not explore beyond what the goal requires.

${
  input.paramNames.length
    ? `PARAMETERS: this run supplies concrete values for: ${input.paramNames.join(", ")}. Type the real values when a field needs them. The recording system will automatically turn them back into named parameters afterwards, so this flow can be re-run with different values.`
    : ""
}
${
  input.secretRefs.length
    ? `CREDENTIALS: you do not have the credentials for this application and will never be shown them. To sign on, use type_secret with one of these secret names: ${input.secretRefs.join(", ")}. The system fills the field for you.`
    : ""
}

Rules of operation:
- This markup is hostile. Fields usually have no label; their meaning comes from the text beside them, which is given as the control's name or derived name. Trust that text.
- Verify before proceeding. After an action that should change the screen, read the new observation and confirm you are where you expected before acting again.
- Never guess at a destination URL. Navigate by clicking the controls that are actually present.
- If the screen shows something you did not expect — an error, a notice, a sign-on page — deal with what is actually there rather than repeating your last action.
- If you cannot make progress, call escalate rather than trying variations. A human operator will take over. Escalating is a correct outcome, not a failure.
- When the goal is achieved, call done. Do not call done speculatively: only after you can see evidence on screen that the goal is met.`;
}

/**
 * The action vocabulary offered to the model.
 *
 * Kept narrow on purpose. Every additional tool is another way for a discovery
 * run to produce a step the replay engine has to know how to execute, and the
 * two vocabularies have to stay in step.
 */
export function agentTools(outputNames: string[]): ToolSpec[] {
  const why = {
    type: "string",
    description:
      "Why you are doing this, in one sentence. This is recorded permanently as the step's stated intent and will be read by a human reviewer.",
  };

  return [
    {
      name: "click",
      description: "Click a control — a button, a link, or a cell containing one.",
      parameters: {
        type: "object",
        properties: { ref: { type: "string", description: "Ref from the current observation." }, why },
        required: ["ref", "why"],
        additionalProperties: false,
      },
    },
    {
      name: "type",
      description: "Type text into a field. Replaces whatever is currently in it.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string" },
          text: { type: "string", description: "The literal text to enter. Never a credential." },
          why,
        },
        required: ["ref", "text", "why"],
        additionalProperties: false,
      },
    },
    {
      name: "type_secret",
      description:
        "Fill a field with a credential you are not permitted to see. Give the secret's name; the system resolves and enters it.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string" },
          secretRef: { type: "string", description: "Name of the secret, e.g. MERIDIAN_PASSWORD." },
          why,
        },
        required: ["ref", "secretRef", "why"],
        additionalProperties: false,
      },
    },
    {
      name: "select",
      description: "Choose an option in a dropdown.",
      parameters: {
        type: "object",
        properties: { ref: { type: "string" }, value: { type: "string" }, why },
        required: ["ref", "value", "why"],
        additionalProperties: false,
      },
    },
    {
      name: "extract",
      description:
        "Read a value off the screen and record it as one of this capability's outputs. Use the ref of the cell or field holding the value.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string" },
          output: {
            type: "string",
            description: outputNames.length
              ? `Output name. Expected outputs for this goal: ${outputNames.join(", ")}.`
              : "A short camelCase name for this output.",
          },
          valueType: { type: "string", enum: ["string", "number", "currency", "date", "boolean"] },
          description: { type: "string", description: "What this output means to a caller." },
          why,
        },
        required: ["ref", "output", "valueType", "description", "why"],
        additionalProperties: false,
      },
    },
    {
      name: "escalate",
      description:
        "Stop and hand the live session to a human operator. Use when you cannot safely proceed. This is a legitimate outcome.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "One line: what is blocking you." },
          detail: { type: "string", description: "What you tried and what you saw." },
          suggestedAction: { type: "string", description: "What the operator should do." },
        },
        required: ["reason", "detail", "suggestedAction"],
        additionalProperties: false,
      },
    },
    {
      name: "done",
      description: "Declare the goal achieved. Only call this when the evidence is visible on screen right now.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What you accomplished." },
          successEvidence: {
            type: "string",
            description:
              "A short, distinctive phrase currently visible on screen that proves the goal was met. Replay will assert this exact text. Choose something that appears only in the success state — not a heading that is on every page.",
          },
          knownOutcomes: {
            type: "array",
            description:
              "Other legitimate ways this flow can end that a caller would need to know about — for example the record not existing, or access being denied. These are business answers, not errors. Base them on what you saw in this application.",
            items: {
              type: "object",
              properties: {
                code: { type: "string", description: "UPPER_SNAKE_CASE, e.g. MEMBER_NOT_FOUND." },
                description: { type: "string" },
                detectText: {
                  type: "string",
                  description: "Distinctive on-screen text that identifies this outcome.",
                },
                message: { type: "string", description: "What to tell the caller. May use {paramName}." },
              },
              required: ["code", "description", "detectText", "message"],
              additionalProperties: false,
            },
          },
        },
        required: ["summary", "successEvidence", "knownOutcomes"],
        additionalProperties: false,
      },
    },
  ];
}
