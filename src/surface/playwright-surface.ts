/**
 * Web implementation of Surface, backed by Playwright.
 *
 * Runs headed by default. That is not a debugging convenience — the escalation
 * model requires a human to take over the *same* session the automation was
 * driving, and you cannot hand a person a headless browser. The window this
 * adapter opens is the window the operator ends up driving.
 *
 * Frames are first-class here because the target environment is full of
 * framesets. Every observation walks all frames and tags each element with the
 * frame it came from, so a locator recorded in the content frame resolves in
 * the content frame at replay time rather than matching something coincidental
 * in the nav frame.
 */

import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import { extractElements } from "./extractor.js";
import { matchStrategy } from "./matcher.js";
import type { LocatorStrategy } from "./locator.js";
import type {
  ActResult,
  Action,
  Observation,
  RecordedHumanAction,
  ResolvedStrategyRequest,
  StateSignal,
  Surface,
  SurfaceCapture,
  SurfaceDescriptor,
  UiElement,
  WaitPredicate,
} from "./types.js";

export interface PlaywrightSurfaceOptions {
  entryPoint: string;
  app: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  defaultTimeoutMs?: number;
  slowMoMs?: number;
}

const MAIN_FRAME = "main";

export class PlaywrightSurface implements Surface {
  readonly descriptor: SurfaceDescriptor;

  private browser!: Browser;
  private context!: BrowserContext;
  private page!: Page;
  private readonly options: Required<Omit<PlaywrightSurfaceOptions, "app" | "entryPoint">> &
    Pick<PlaywrightSurfaceOptions, "app" | "entryPoint">;
  private lastHttpStatus: number | undefined;
  private humanRecordingEnabled = false;
  private readonly humanActions: RecordedHumanAction[] = [];

  constructor(options: PlaywrightSurfaceOptions) {
    this.options = {
      headless: options.headless ?? false,
      viewport: options.viewport ?? { width: 1280, height: 900 },
      defaultTimeoutMs: options.defaultTimeoutMs ?? 10_000,
      slowMoMs: options.slowMoMs ?? 0,
      app: options.app,
      entryPoint: options.entryPoint,
    };
    this.descriptor = { kind: "web", app: options.app, entryPoint: options.entryPoint };
  }

  static async launch(options: PlaywrightSurfaceOptions): Promise<PlaywrightSurface> {
    const surface = new PlaywrightSurface(options);
    await surface.start();
    return surface;
  }

  private async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.options.headless,
      slowMo: this.options.slowMoMs,
    });
    this.context = await this.browser.newContext({ viewport: this.options.viewport });
    this.context.setDefaultTimeout(this.options.defaultTimeoutMs);

    // Functions passed to evaluate() are serialized as source. The TypeScript
    // loader compiles named inner functions with a `__name` helper that exists
    // in the Node module scope but not in the page, so the serialized source
    // references an undefined identifier. Shimming it is more robust than
    // depending on transpiler flags. Registered as a raw string so it is not
    // itself subject to the same rewriting.
    await this.context.addInitScript({
      content: "globalThis.__name = globalThis.__name || function (fn) { return fn; };",
    });

    this.page = await this.context.newPage();

    this.page.on("response", (response) => {
      if (response.frame() === this.page.mainFrame() && response.request().resourceType() === "document") {
        this.lastHttpStatus = response.status();
      }
    });
  }

  /** Stable identifier for a frame within the current page. */
  private frameId(frame: Frame, index: number): string {
    if (frame === this.page.mainFrame()) return MAIN_FRAME;
    const name = frame.name();
    return name ? name : `frame${index}`;
  }

  private frameById(id: string): Frame | undefined {
    const frames = this.page.frames();
    for (let i = 0; i < frames.length; i++) {
      if (this.frameId(frames[i]!, i) === id) return frames[i];
    }
    return undefined;
  }

  async observe(): Promise<Observation> {
    await this.settle();

    const frames = this.page.frames();
    const elements: UiElement[] = [];
    const texts: string[] = [];
    const signals: StateSignal[] = [];
    let title = "";

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      const id = this.frameId(frame, i);
      try {
        const result = await frame.evaluate(extractElements, id);
        elements.push(...(result.elements as UiElement[]));
        if (result.text) texts.push(result.text);
        if (id === MAIN_FRAME && result.title) title = result.title;
        if (!title && result.title) title = result.title;
        for (const s of result.signals) {
          signals.push({ kind: s.kind as StateSignal["kind"], detail: s.detail });
        }
      } catch {
        // A frame that navigated mid-observation cannot be read. Skipping is
        // correct: the next observe() will pick it up once it settles.
      }
    }

    if (this.lastHttpStatus && this.lastHttpStatus >= 400) {
      signals.push({ kind: "http_error", detail: `HTTP ${this.lastHttpStatus}` });
    }

    return {
      surface: this.descriptor,
      location: this.page.url(),
      title,
      elements,
      text: texts.join("\n\n"),
      signals,
      capturedAt: new Date().toISOString(),
    };
  }

  /**
   * Wait for the page to stop moving.
   *
   * Waiting on the main frame's load state is not enough here. In a frameset,
   * clicking a link in the nav frame navigates the content frame, and the main
   * document never changes state at all — so a naive wait returns immediately
   * and the next observation reads the *previous* screen. That produces
   * intermittent, near-undebuggable replay failures.
   *
   * Instead, poll the set of frame URLs until it holds still across two
   * consecutive samples. Cheap, surface-agnostic in spirit, and it handles both
   * top-level navigation and frame-local navigation with the same rule.
   */
  private async settle(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSamples = 0;

    while (Date.now() < deadline) {
      try {
        await this.page.waitForLoadState("domcontentloaded", { timeout: 1_000 });
      } catch {
        // Still loading; the signature check below decides whether to keep waiting.
      }

      const signature = this.page
        .frames()
        .map((f) => `${f.name()}|${f.url()}`)
        .sort()
        .join(";");

      if (signature === previous && signature !== "") {
        if (++stableSamples >= 2) return;
      } else {
        stableSamples = 0;
        previous = signature;
      }

      await new Promise((r) => setTimeout(r, 120));
    }
  }

  private async locatorForRef(ref: string) {
    const [frameId] = ref.split("#");
    const frame = this.frameById(frameId ?? MAIN_FRAME);
    if (!frame) return undefined;
    const locator = frame.locator(`[data-cua-ref="${ref}"]`);
    return (await locator.count()) > 0 ? locator.first() : undefined;
  }

  async act(action: Action): Promise<ActResult> {
    switch (action.type) {
      case "navigate": {
        const response = await this.page.goto(action.url, { waitUntil: "domcontentloaded" });
        this.lastHttpStatus = response?.status();
        return { ok: true };
      }

      case "click": {
        const locator = await this.locatorForRef(action.ref);
        if (!locator) return { ok: false, error: `ref ${action.ref} no longer resolves` };
        await locator.click({ timeout: this.options.defaultTimeoutMs });
        await this.settle();
        return { ok: true };
      }

      case "type": {
        const locator = await this.locatorForRef(action.ref);
        if (!locator) return { ok: false, error: `ref ${action.ref} no longer resolves` };
        if (action.clearFirst === false) {
          await locator.type(action.text, { timeout: this.options.defaultTimeoutMs });
        } else {
          await locator.fill(action.text, { timeout: this.options.defaultTimeoutMs });
        }
        return { ok: true };
      }

      case "select": {
        const locator = await this.locatorForRef(action.ref);
        if (!locator) return { ok: false, error: `ref ${action.ref} no longer resolves` };
        await locator.selectOption(action.value, { timeout: this.options.defaultTimeoutMs });
        await this.settle();
        return { ok: true };
      }

      case "press": {
        await this.page.keyboard.press(action.key);
        await this.settle();
        return { ok: true };
      }

      case "wait_for": {
        const ok = await this.waitFor(action.predicate, action.timeoutMs ?? this.options.defaultTimeoutMs);
        return ok ? { ok: true } : { ok: false, error: `wait_for ${action.predicate.kind} timed out` };
      }

      case "extract": {
        if (action.ref) {
          const locator = await this.locatorForRef(action.ref);
          if (!locator) return { ok: false, error: `ref ${action.ref} no longer resolves` };
          const value = (await locator.textContent())?.replace(/\s+/g, " ").trim() ?? "";
          return { ok: true, value };
        }
        if (action.pattern) {
          const observation = await this.observe();
          const match = new RegExp(action.pattern).exec(observation.text);
          return match ? { ok: true, value: match[1] ?? match[0] } : { ok: false, error: "pattern did not match" };
        }
        return { ok: false, error: "extract requires ref or pattern" };
      }

      case "done":
        return { ok: true };
    }
  }

  private async waitFor(predicate: WaitPredicate, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const observation = await this.observe();
      switch (predicate.kind) {
        case "text_present":
          if (observation.text.toLowerCase().includes(predicate.text.toLowerCase())) return true;
          break;
        case "text_absent":
          if (!observation.text.toLowerCase().includes(predicate.text.toLowerCase())) return true;
          break;
        case "element_present":
          if (
            matchStrategy(observation, {
              kind: "role_name",
              role: predicate.role,
              name: predicate.name,
              exact: false,
            }).length > 0
          ) {
            return true;
          }
          break;
        case "load_settled":
          if (!observation.signals.some((s) => s.kind === "load_incomplete")) return true;
          break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  async resolve(request: ResolvedStrategyRequest): Promise<string | undefined> {
    const { observation, strategy } = request;

    if (strategy.kind === "css") {
      const frame = this.frameById(strategy.frame ?? MAIN_FRAME) ?? this.page.mainFrame();
      const locator = frame.locator(strategy.selector);
      if ((await locator.count()) !== 1) return undefined;
      const ref = await locator.first().getAttribute("data-cua-ref");
      return ref ?? undefined;
    }

    if (strategy.kind === "coordinates") {
      const viewport = this.page.viewportSize();
      if (!viewport) return undefined;
      const x = strategy.xRatio * viewport.width;
      const y = strategy.yRatio * viewport.height;
      const ref = await this.page.evaluate(
        ([px, py]) => {
          const el = document.elementFromPoint(px as number, py as number);
          return el?.getAttribute("data-cua-ref") ?? undefined;
        },
        [x, y],
      );
      return ref ?? undefined;
    }

    const matches = matchStrategy(observation, strategy);
    // Ambiguity is a failure of this rung, not a coin flip. Fall through to the
    // next strategy rather than acting on an arbitrary one of several matches.
    if (matches.length !== 1) return undefined;
    return matches[0]!.ref;
  }

  /**
   * Screenshot plus a textual snapshot of every frame.
   *
   * `page.content()` alone is close to useless here: on a frameset it returns
   * the `<frameset>` shell and none of the documents the operator was actually
   * looking at. The screenshot renders correctly, so the gap is easy to miss —
   * the evidence looks fine until someone opens the DOM snapshot during an
   * incident and finds six lines of frame tags.
   */
  async capture(): Promise<SurfaceCapture> {
    const screenshot = await this.page.screenshot({ fullPage: false });

    const parts: string[] = [];
    const frames = this.page.frames();
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      const id = this.frameId(frame, i);
      try {
        const content = await frame.content();
        parts.push(`<!-- ===== frame: ${id} (${frame.url()}) ===== -->\n${content}`);
      } catch {
        parts.push(`<!-- ===== frame: ${id} — unavailable (navigated during capture) ===== -->`);
      }
    }

    return { screenshot, raw: parts.join("\n\n") || "<unavailable>" };
  }

  /** Escape hatch for the escalation layer, which needs the live page object. */
  livePage(): Page {
    return this.page;
  }

  /**
   * Install listeners that record operator input during a handoff.
   *
   * Each event is pushed out of the page immediately through an exposed
   * binding, rather than buffered in a `window` array and collected at the end.
   *
   * That detail is the whole mechanism. Buffering in the page loses exactly the
   * actions worth keeping: a click on a link is recorded, then the navigation
   * that click caused destroys the document and the buffer with it. The only
   * operator actions that would survive are the ones that changed nothing.
   * Observed directly — the first version of this recorded zero actions for an
   * operator whose entire contribution was clicking through to a record.
   *
   * Listeners are passive and capture-phase, so they observe without
   * interfering with the application's own handlers, and are registered as an
   * init script so they apply to every document the operator reaches and to
   * every frame of a frameset.
   */
  async beginHumanRecording(): Promise<void> {
    if (this.humanRecordingEnabled) return;
    this.humanRecordingEnabled = true;

    await this.context.exposeBinding(
      "__cuaRecordHumanAction",
      (_source, action: RecordedHumanAction) => {
        this.humanActions.push(action);
      },
    );

    const installer = () => {
      const w = window as unknown as {
        __cuaRecorderInstalled?: boolean;
        __cuaRecordHumanAction?: (a: Record<string, unknown>) => void;
      };
      if (w.__cuaRecorderInstalled) return;
      w.__cuaRecorderInstalled = true;

      const describe = (el: Element | null): string => {
        if (!el) return "";
        const tag = el.tagName.toLowerCase();
        const role =
          el.getAttribute("role") ??
          (tag === "a" ? "link" : tag === "select" ? "combobox" : tag === "button" ? "button" : tag);
        const label =
          el.getAttribute("aria-label") ||
          (tag === "input" ? (el.getAttribute("value") ?? "") : "") ||
          (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
        return `${role}:${label}`.slice(0, 120);
      };

      const send = (entry: Record<string, unknown>) => {
        try {
          w.__cuaRecordHumanAction?.({
            at: new Date().toISOString(),
            location: location.href,
            ...entry,
          });
        } catch {
          // The binding is gone mid-teardown. Losing one trailing event is
          // preferable to throwing inside the application's event handler.
        }
      };

      document.addEventListener(
        "click",
        (e) => send({ type: "click", target: describe(e.target as Element) }),
        true,
      );
      document.addEventListener(
        "change",
        (e) => {
          const el = e.target as HTMLInputElement;
          // Length only. The value itself is regulated data we must not keep.
          send({ type: "change", target: describe(el), valueLength: (el.value ?? "").length });
        },
        true,
      );
      document.addEventListener(
        "submit",
        (e) => send({ type: "submit", target: describe(e.target as Element) }),
        true,
      );
    };

    await this.context.addInitScript(installer);
    // Init scripts only affect documents created after registration, so also
    // install into whatever the operator is looking at right now.
    for (const frame of this.page.frames()) {
      await frame.evaluate(installer).catch(() => {});
    }
  }

  async drainHumanActions(): Promise<RecordedHumanAction[]> {
    const collected = [...this.humanActions];
    this.humanActions.length = 0;
    return collected.sort((a, b) => a.at.localeCompare(b.at));
  }

  async dispose(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}
