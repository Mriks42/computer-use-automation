/**
 * The surface abstraction.
 *
 * This is the load-bearing seam of the whole system. Everything above it —
 * the artifact schema, the replay engine, the policy layer, the escalation
 * broker — is written against these types and has no knowledge of Playwright,
 * of browsers, or of the DOM.
 *
 * A surface answers two questions and nothing else:
 *   - what is on the screen right now?  (observe)
 *   - do this thing to it.              (act)
 *
 * A desktop implementation backed by the platform accessibility API (AX on
 * macOS, UIA on Windows) fills in the same interface. It would produce
 * UiElements with the same roles and names, because those role vocabularies
 * are deliberately the ARIA ones. The recorded flow does not change.
 */

/** Where a surface lives. Used for allowlist checks and artifact matching. */
export interface SurfaceDescriptor {
  kind: "web" | "desktop" | "terminal";
  /** Logical application name, stable across tenants running the same product. */
  app: string;
  /** Where a session starts: a URL for web, an executable or bundle id for desktop. */
  entryPoint: string;
}

/**
 * A single interactive or informational control.
 *
 * `ref` is deliberately ephemeral — it is only valid within the observation
 * that produced it. The model acts on refs, which means the model never sees
 * or invents a selector. Converting a ref into something durable is the
 * recorder's job, not the model's. See src/surface/locator.ts.
 */
export interface UiElement {
  ref: string;
  role: string;
  /** Accessible name, computed where the markup provides one. */
  name: string;
  /**
   * Name derived from layout context when the markup provides no accessible
   * name — for example the text of the table cell immediately to the left of
   * an unlabelled input. Legacy surfaces need this constantly.
   */
  derivedName?: string;
  value?: string;
  disabled?: boolean;
  /** True when the element is in the viewport and hit-testable. */
  visible: boolean;
  /** Structural context used to build durable locators and to scope searches. */
  context: ElementContext;
  /** Viewport-relative box, used for coordinate fallback and for evidence. */
  box?: BoundingBox;
}

export interface ElementContext {
  /** Identifier of the document this element lives in. "main" or a frame name. */
  frame: string;
  /** Nearest enclosing landmark or titled panel, if any. */
  region?: string;
  /** For table cells and controls inside tables: text of the row's first cell. */
  rowAnchor?: string;
  /** For table cells and controls inside tables: zero-based column index. */
  columnIndex?: number;
  /** Text of the nearest preceding label-like element. */
  labelText?: string;
  /** Index among siblings sharing the same role within the frame. */
  roleIndex: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A normalized snapshot of surface state.
 *
 * Note what is absent: no HTML, no DOM tree, no framework detail. A replay
 * engine written against Observation cannot accidentally depend on the DOM.
 */
export interface Observation {
  surface: SurfaceDescriptor;
  /** Web: the current URL. Desktop: the focused window identity. */
  location: string;
  title: string;
  elements: UiElement[];
  /** Flattened readable text per frame, used for checkpoints and extraction. */
  text: string;
  /** Conditions the surface adapter recognized without help from the model. */
  signals: StateSignal[];
  capturedAt: string;
}

/**
 * Surface-level conditions detected structurally rather than semantically.
 *
 * These are hints, not verdicts. The replay engine decides what a signal means
 * using the artifact's declared outcomes; the surface only reports what it saw.
 */
export interface StateSignal {
  kind: "dialog_present" | "error_banner" | "warning_banner" | "http_error" | "load_incomplete";
  detail: string;
}

/** The complete action vocabulary. Deliberately small. */
export type Action =
  | { type: "navigate"; url: string }
  | { type: "click"; ref: string }
  | { type: "type"; ref: string; text: string; clearFirst?: boolean }
  | { type: "select"; ref: string; value: string }
  | { type: "press"; key: string }
  | { type: "wait_for"; predicate: WaitPredicate; timeoutMs?: number }
  | { type: "extract"; ref?: string; pattern?: string; as: string }
  | { type: "done"; summary: string };

export type WaitPredicate =
  | { kind: "text_present"; text: string }
  | { kind: "text_absent"; text: string }
  | { kind: "element_present"; role: string; name: string }
  | { kind: "load_settled" };

export interface ActResult {
  ok: boolean;
  /** Present when the action produced a value, e.g. extract. */
  value?: string;
  /** Surface-level complaint, e.g. the ref no longer resolves. */
  error?: string;
}

/** Raw evidence for debugging. Screenshot bytes plus a textual snapshot. */
export interface SurfaceCapture {
  screenshot: Buffer;
  /** Adapter-specific raw state. Web: serialized DOM. Desktop: AX tree dump. */
  raw: string;
}

/**
 * Something a person did while holding the session lease.
 *
 * Recording this is part of the handoff contract: a run that a human touched
 * has to show what they touched, or the evidence trail has a hole in it exactly
 * where a regulator would look. Values are never captured — see HumanAction in
 * src/escalation/intervention.ts.
 */
export interface RecordedHumanAction {
  at: string;
  type: "click" | "input" | "change" | "submit" | "navigate" | "key";
  target?: string;
  valueLength?: number;
  location?: string;
}

export interface Surface {
  descriptor: SurfaceDescriptor;
  observe(): Promise<Observation>;
  act(action: Action): Promise<ActResult>;
  capture(): Promise<SurfaceCapture>;
  /** Resolve a durable locator to an ephemeral ref. Used only by replay. */
  resolve(strategies: ResolvedStrategyRequest): Promise<string | undefined>;
  dispose(): Promise<void>;

  /**
   * Begin observing direct human input. Optional because not every surface can
   * do it — a desktop adapter driving another process may have no hook — and a
   * surface that cannot record a handoff should say so by not implementing it,
   * rather than by silently returning nothing.
   */
  beginHumanRecording?(): Promise<void>;
  /** Collect and clear everything recorded since recording began. */
  drainHumanActions?(): Promise<RecordedHumanAction[]>;
}

/** Passed from the replay engine down to the adapter, which does the matching. */
export interface ResolvedStrategyRequest {
  observation: Observation;
  strategy: import("./locator.js").LocatorStrategy;
}
