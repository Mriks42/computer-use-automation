/**
 * Redaction.
 *
 * Applied at the boundary where anything leaves the process — evidence writes,
 * artifact writes, log lines, and the context attached to an escalation. The
 * rule is that redaction is the *writer's* job, not the caller's, because a
 * policy that depends on every call site remembering to scrub is a policy that
 * fails the first time someone adds a log line in a hurry.
 *
 * Two mechanisms, because they fail differently:
 *
 *   - Registered values: exact-match scrubbing of things we know are secret
 *     (a password read from the environment, a parameter declared `secret` or
 *     `pii`). Precise, no false positives, but only catches what we were told
 *     about.
 *
 *   - Patterns: shape-matching for regulated data that arrives from the
 *     application rather than from us — a tax ID rendered into a member detail
 *     page was never passed in as a parameter, so nothing registered it. Catches
 *     the unknown, at the cost of occasional over-redaction.
 *
 * Over-redaction is the correct failure direction here. A log line with an
 * account number needlessly masked costs a debugging session; one with a real
 * tax ID in it is a reportable incident.
 */

export interface RedactionPattern {
  name: string;
  regex: RegExp;
  /** Optional extra test to suppress false positives, e.g. a checksum. */
  validate?: (match: string) => boolean;
}

/** Luhn check, used to avoid masking every long number as a card. */
function luhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export const DEFAULT_PATTERNS: RedactionPattern[] = [
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    name: "card",
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    validate: luhnValid,
  },
  { name: "email", regex: /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g },
  { name: "bearer", regex: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi },
  { name: "api_key", regex: /\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}\b/g },
  /** Credentials carried in a query string or form encoding. */
  { name: "credential_param", regex: /\b(password|passwd|pwd|token|secret|apikey|api_key)=[^&\s"']+/gi },
];

export interface RedactorOptions {
  patterns?: RedactionPattern[];
  /**
   * Minimum length for a registered value to be scrubbed. Registering a very
   * short secret would otherwise mask common substrings across every log line.
   */
  minRegisteredLength?: number;
}

export class Redactor {
  private readonly registered = new Map<string, string>();
  private readonly patterns: RedactionPattern[];
  private readonly minRegisteredLength: number;

  constructor(options: RedactorOptions = {}) {
    this.patterns = options.patterns ?? DEFAULT_PATTERNS;
    this.minRegisteredLength = options.minRegisteredLength ?? 4;
  }

  /**
   * Register a value that must never appear in output.
   *
   * `label` shows up in place of the value so a reader can tell *what* was
   * removed — "<redacted:MERIDIAN_PASSWORD>" is far more debuggable than an
   * anonymous block of asterisks, and reveals nothing.
   */
  register(value: string | undefined | null, label: string): void {
    if (!value) return;
    if (value.length < this.minRegisteredLength) return;
    this.registered.set(value, `<redacted:${label}>`);
  }

  registerAll(entries: Record<string, string | undefined>): void {
    for (const [label, value] of Object.entries(entries)) this.register(value, label);
  }

  redact(input: string): string {
    if (!input) return input;
    let out = input;

    // Registered values first: they are precise, and doing them before pattern
    // matching means a registered secret that also looks like a card number is
    // labelled usefully rather than masked generically.
    for (const [value, replacement] of this.registered) {
      if (!value) continue;
      out = out.split(value).join(replacement);
    }

    for (const pattern of this.patterns) {
      out = out.replace(pattern.regex, (match) => {
        if (pattern.validate && !pattern.validate(match)) return match;
        return `<redacted:${pattern.name}>`;
      });
    }

    return out;
  }

  /** Deep-redact any JSON-serializable structure, keys included. */
  redactValue<T>(input: T): T {
    if (input === null || input === undefined) return input;
    if (typeof input === "string") return this.redact(input) as unknown as T;
    if (typeof input === "number" || typeof input === "boolean") return input;
    if (Array.isArray(input)) return input.map((v) => this.redactValue(v)) as unknown as T;
    if (Buffer.isBuffer(input)) return input;
    if (typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        out[key] = this.redactValue(value);
      }
      return out as unknown as T;
    }
    return input;
  }

  /**
   * Redact a parameter map using declared sensitivity rather than shape.
   *
   * This is the path that matters most: a member ID is not detectable by any
   * pattern, but if the capability declares it `pii` it still must not be
   * written out. Classification beats detection whenever we have it.
   */
  redactParams(
    params: Record<string, unknown>,
    sensitivity: Record<string, "public" | "internal" | "pii" | "secret">,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      const level = sensitivity[key] ?? "internal";
      if (level === "secret" || level === "pii") {
        out[key] = `<redacted:${key}>`;
      } else {
        out[key] = this.redactValue(value);
      }
    }
    return out;
  }
}

/** Process-wide redactor. Evidence and artifact writers use this one. */
export const defaultRedactor = new Redactor();
