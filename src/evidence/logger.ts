/**
 * Run evidence.
 *
 * Every write goes through the redactor. That is the whole design: redaction is
 * not something callers remember to do, it is something this class does to
 * everything it is handed. The cost is that a caller cannot opt out; that is
 * also the benefit.
 *
 * The log is JSONL rather than prose because the primary reader is a person
 * debugging a failed replay at 2am who needs to find the step that broke, and
 * the secondary reader is a script computing stability across runs. Neither is
 * well served by formatted text.
 */

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Redactor, defaultRedactor } from "../policy/redact.js";
import type { Surface } from "../surface/types.js";

export type RunKind = "discovery" | "replay";

export interface RunEvent {
  seq: number;
  at: string;
  type: string;
  [key: string]: unknown;
}

export interface RunLoggerOptions {
  kind: RunKind;
  /** Root directory for run output. Defaults to ./runs. */
  root?: string;
  runId?: string;
  redactor?: Redactor;
  /** Mirror events to stdout as they happen. */
  echo?: boolean;
}

export class RunLogger {
  readonly runId: string;
  readonly dir: string;
  readonly kind: RunKind;

  private seq = 0;
  private captureSeq = 0;
  private readonly redactor: Redactor;
  private readonly logPath: string;
  private readonly echo: boolean;

  constructor(options: RunLoggerOptions) {
    this.kind = options.kind;
    this.runId = options.runId ?? `${options.kind}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    this.redactor = options.redactor ?? defaultRedactor;
    this.echo = options.echo ?? true;

    const root = options.root ?? join(process.cwd(), "runs");
    this.dir = join(root, this.runId);
    mkdirSync(join(this.dir, "captures"), { recursive: true });
    this.logPath = join(this.dir, "log.jsonl");

    this.write({ type: "run_started", kind: this.kind, runId: this.runId });
  }

  /** Register a value that must never reach the log. */
  registerSecret(value: string | undefined, label: string): void {
    this.redactor.register(value, label);
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    this.write({ type, ...data });
  }

  private write(payload: Record<string, unknown>): void {
    const event: RunEvent = {
      seq: this.seq++,
      at: new Date().toISOString(),
      type: String(payload.type ?? "event"),
      ...this.redactor.redactValue(payload),
    };
    appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, "utf8");
    if (this.echo) {
      const { seq, at, type, ...rest } = event;
      const detail = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
      process.stdout.write(`  [${String(seq).padStart(3, "0")}] ${type}${detail}\n`);
    }
  }

  /**
   * Richer signal on failure: a screenshot plus the raw surface snapshot.
   *
   * The snapshot is redacted; the screenshot is not, because pixels cannot be
   * scrubbed by a regex. That gap is real and is documented in REPORT.md — the
   * mitigation in production is to mask sensitive regions at capture time using
   * the element boxes the observation already carries, which this
   * implementation does not do.
   */
  async capture(surface: Surface, label: string): Promise<{ screenshot: string; raw: string }> {
    const n = String(this.captureSeq++).padStart(2, "0");
    const safeLabel = label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
    const base = `${n}-${safeLabel}`;

    const captured = await surface.capture();
    const screenshotPath = join(this.dir, "captures", `${base}.png`);
    const rawPath = join(this.dir, "captures", `${base}.html`);

    writeFileSync(screenshotPath, captured.screenshot);
    writeFileSync(rawPath, this.redactor.redact(captured.raw), "utf8");

    this.event("capture_written", { label, screenshot: `captures/${base}.png`, raw: `captures/${base}.html` });
    return { screenshot: screenshotPath, raw: rawPath };
  }

  /** Write a JSON document into the run directory, redacted. */
  writeDocument(name: string, value: unknown): string {
    const path = join(this.dir, name);
    writeFileSync(path, `${JSON.stringify(this.redactor.redactValue(value), null, 2)}\n`, "utf8");
    this.event("document_written", { name });
    return path;
  }

  finalize(summary: Record<string, unknown>): void {
    this.write({ type: "run_finished", ...summary });
  }
}
