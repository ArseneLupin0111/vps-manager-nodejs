import { z } from "zod";
import { LOCAL_UPGRADE_PROGRESS_PHASES } from "./local-upgrade.models.js";

/** Full git SHA — releaseId/buildId identity for releases and heartbeats. */
export const fullGitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a full 40-char git SHA");

/**
 * POST /api/vps/:id/local-agent-upgrades.
 * Non-strict on purpose: unknown client keys are stripped, never rejected —
 * confirmation is a UX dialog plus session/Origin guards, not a token field.
 */
export const localAgentUpgradeCreateSchema = z.object({
  releaseId: fullGitShaSchema,
});

export type LocalAgentUpgradeCreateInput = z.infer<
  typeof localAgentUpgradeCreateSchema
>;

/** POST /api/local-updater/jobs/:jobId/progress */
export const localUpdaterProgressSchema = z
  .object({
    fencingToken: z.number().int().min(0),
    phase: z.enum(LOCAL_UPGRADE_PROGRESS_PHASES),
    progress: z.number().int().min(0).max(100).nullable().optional(),
    message: z.string().trim().max(160).optional(),
  })
  .strict();

export type LocalUpdaterProgressInput = z.infer<
  typeof localUpdaterProgressSchema
>;

/** POST /api/local-updater/jobs/:jobId/result */
export const localUpdaterResultSchema = z
  .object({
    fencingToken: z.number().int().min(0),
    outcome: z.enum([
      "succeeded",
      "rolled_back",
      "rollback_unverified",
      "failed",
    ]),
    reportedBuildId: fullGitShaSchema.optional(),
    reason: z.string().trim().max(160).optional(),
  })
  .strict();

export type LocalUpdaterResultInput = z.infer<
  typeof localUpdaterResultSchema
>;

/** GET /api/vps/:id/local-agent-upgrades?limit=&offset= */
export const localUpgradeListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Optional Idempotency-Key header on job create. */
export const idempotencyKeySchema = z.string().trim().min(1).max(200);
