/**
 * Surface profiles.
 *
 * Some conditions are properties of the *application*, not of any particular
 * flow: this product shows an unscheduled maintenance interstitial, that one
 * renders permission denials a certain way, all of them expire sessions. Every
 * capability recorded against the product needs the same handling, and
 * rediscovering it per flow would be both wasteful and inconsistent.
 *
 * So generic handling lives in a profile keyed by vendor product, and the
 * recorder merges it into each artifact it writes. Flow-specific outcomes —
 * the ones only meaningful for one capability — come from the discovery run.
 *
 * This is also the seam for multi-tenant reuse. A profile describes a vendor
 * product; tenants running that product inherit it; a tenant whose build words
 * things differently overrides the strings in one place rather than in every
 * artifact recorded against it.
 */

import type { BusinessOutcomeSpec, RecoveryRule } from "./schema.js";

export interface SurfaceProfile {
  /** Vendor product this profile describes. */
  product: string;
  /** Applied at every step of every capability recorded against the product. */
  globalRecovery: RecoveryRule[];
  /** Merged into every capability's declared outcomes. */
  knownOutcomes: BusinessOutcomeSpec[];
}

export const MERIDIAN_PROFILE: SurfaceProfile = {
  product: "meridian-core",

  globalRecovery: [
    {
      name: "dismiss_system_notice",
      description:
        "Meridian injects an unscheduled maintenance notice between screens. It is modal, carries no business meaning, and must be acknowledged before the underlying page is reachable.",
      when: { kind: "text_present", text: "System Notice" },
      do: [
        {
          kind: "click",
          target: {
            description: "Acknowledge button on the system notice interstitial",
            frame: "main",
            strategies: [{ kind: "role_name", role: "button", name: "Acknowledge", exact: true }],
            confidence: "high",
            rationale: "The interstitial has exactly one control and it is labelled.",
          },
        },
      ],
      maxAttempts: 2,
    },
  ],

  knownOutcomes: [
    {
      code: "PERMISSION_DENIED",
      description:
        "The signed-on operator is not authorized to view this record. A legitimate answer to the caller's question, not a malfunction — the record exists and access was refused.",
      detect: { kind: "text_present", text: "You do not have permission to view" },
      message: "Access to this record is restricted for the current operator role.",
      partialOutputs: [],
      verified: true,
    },
    {
      code: "RECORD_NOT_FOUND",
      description:
        "No record matched the identifier supplied. The caller asked about something that does not exist; this is information, not an error.",
      detect: { kind: "text_present", text: "No member found matching" },
      message: "No record matched the supplied identifier.",
      partialOutputs: [],
      verified: true,
    },
  ],
};

export const PROFILES: Record<string, SurfaceProfile> = {
  [MERIDIAN_PROFILE.product]: MERIDIAN_PROFILE,
};

export function profileFor(product: string): SurfaceProfile | undefined {
  return PROFILES[product];
}
