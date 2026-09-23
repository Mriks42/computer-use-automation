import { join } from "node:path";
import type { AllowlistConfig } from "./policy/allowlist.js";

export const PATHS = {
  capabilities: join(process.cwd(), "capabilities"),
  runs: join(process.cwd(), "runs"),
  evidence: join(process.cwd(), "evidence"),
  goals: join(process.cwd(), "goals"),
};

export const PORTS = {
  meridian: Number(process.env.MERIDIAN_PORT ?? 4600),
  operator: Number(process.env.OPERATOR_PORT ?? 4610),
};

/**
 * Allowlist for the local target.
 *
 * Worth reading the deny list: /control/ is the app's fault-injection plane and
 * /logout would end the session the automation depends on. Both are served from
 * an allowed origin, and both are refused. An allowlist that only checks
 * origins would permit either.
 */
export function meridianAllowlist(origin: string): Partial<AllowlistConfig> {
  return {
    allowedOrigins: [origin],
    allowedPaths: [
      "^/$",
      "^/login$",
      "^/desk$",
      "^/nav$",
      "^/main$",
      "^/search",
      "^/member/",
      "^/reports$",
    ],
    deniedPaths: ["^/control/", "^/admin/", "^/logout"],
    allowedActions: ["navigate", "click", "type", "select", "press", "wait_for", "extract", "done"],
    maxUnattendedRisk: "reversible_write",
    maxSteps: 30,
  };
}
