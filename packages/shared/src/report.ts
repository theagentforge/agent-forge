import { z } from "zod";

// The field report: MASTER_PLAN §6.5. Objects are strict, so unknown keys (code, prompts, paths) are rejected.

import {
  FRAMEWORKS,
  ISSUES,
  LOOP_MIN_FAILURES,
  NOTE_MAX_LENGTH,
  OUTCOMES,
  OUTCOMES_AFTER_RESET,
  STRAIN_CAPS,
  STRAIN_SOURCES,
  TOOL_KINDS,
} from "./constants";

export * from "./constants";

export const strainSchema = z
  .strictObject({
    source: z.enum(STRAIN_SOURCES),
    attempts: z.int().min(1).max(STRAIN_CAPS.attempts),
    tool_errors: z.int().min(0).max(STRAIN_CAPS.tool_errors),
    retries: z.int().min(0).max(STRAIN_CAPS.retries),
    loop_detected: z.boolean(),
    context_reset: z.boolean(),
    outcome_after_reset: z.enum(OUTCOMES_AFTER_RESET),
    escalated_to_human: z.boolean(),
  })
  .refine((s) => s.retries <= s.tool_errors, { message: "retries can't exceed tool_errors (a retry follows a failure)" })
  .refine((s) => !s.loop_detected || s.tool_errors >= LOOP_MIN_FAILURES || s.retries >= LOOP_MIN_FAILURES - 1, {
    message: "loop_detected needs at least 3 failures or 2 retries",
  })
  .refine((s) => s.context_reset || s.outcome_after_reset === "none", {
    message: "outcome_after_reset must be none without a context reset",
  });

/**
 * Tool ids and versions are echoed back to every agent that checks the tool, so they must be identifiers, not prose:
 * free text here would be a prompt-injection channel (SECURITY_REVIEW.md, finding 1).
 */
export const TOOL_ID_PATTERN =
  /^(?:npm:(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*|github\.com\/[a-z0-9][a-z0-9_.-]*\/[a-z0-9_.-]+(?:\/[a-z0-9_.@-]+)*|mcp-registry:[a-z0-9][a-z0-9._/-]*|https?:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._~%@+-]*)*)$/i;
export const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;

export const toolRefSchema = z.strictObject({
  kind: z.enum(TOOL_KINDS),
  id: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(TOOL_ID_PATTERN, "id must be npm:<package>, github.com/<owner>/<repo>[/path], mcp-registry:<name> or an http(s) URL"),
  version: z.string().trim().min(1).max(128).regex(VERSION_PATTERN, "version must be a version string such as 1.4.2"),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/, "fingerprint must be sha256:<64 lowercase hex>"),
});

export const reportSchema = z.strictObject({
  tool: toolRefSchema,
  task: z.strictObject({
    category: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "category must be a short lowercase slug"),
    framework: z.enum(FRAMEWORKS),
  }),
  outcome: z.enum(OUTCOMES),
  issues: z
    .array(z.enum(ISSUES))
    .max(ISSUES.length)
    .refine((xs) => new Set(xs).size === xs.length, "issues must not repeat")
    .default([]),
  note: z.string().trim().max(NOTE_MAX_LENGTH).optional(),
  strain: strainSchema.optional(),
});

/** Input to a check: any one of id, url or fingerprint. */
export const checkQuerySchema = z
  .strictObject({
    id: z.string().trim().min(1).max(512).optional(),
    url: z.url({ protocol: /^https?$/ }).max(512).optional(),
    fingerprint: toolRefSchema.shape.fingerprint.optional(),
  })
  .refine((q) => [q.id, q.url, q.fingerprint].filter((v) => v !== undefined).length === 1, {
    message: "give exactly one of id, url or fingerprint",
  });

export type Report = z.infer<typeof reportSchema>;
export type Strain = z.infer<typeof strainSchema>;
export type CheckQuery = z.infer<typeof checkQuerySchema>;
