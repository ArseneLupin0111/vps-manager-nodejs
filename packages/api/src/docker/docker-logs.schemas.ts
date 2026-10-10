import { z } from "zod";

// ── Docker realtime logs wire contract (step 1) ─────────────────────────
// Strict mirrored contract with `packages/agent/internal/logs/protocol.go`.
// Fail-closed in both directions: neither side may accept a shape the
// other would reject. Every object is `.strict()`; IDs use the opaque
// charset of `docker-management.schemas.ts` (`^[A-Za-z0-9._~-]+$`).
//
// Endpoints (implemented in later steps, locked here):
// - GET  /api/vps/:id/docker/management/logs/stream?agentInstanceId=&containerKey=
//   Both query params REQUIRED. No `tail`, cursor, or `follow` option.
//   `tailLines` is always 200. Each valid HTTP connection creates one
//   ephemeral subscription and is its only viewer.
// - SSE `docker.logs.state`:  `{ subscriptionId, status: "waiting" | "live" }`
//   `waiting` is sent immediately after registration; `live` once the agent
//   has opened the Docker source (HTTP 2xx).
// - SSE `docker.logs.lines`:  `{ subscriptionId, lines: LogLine[] }`
//   `text` is one line without a trailing LF; the splitter preserves empty
//   lines. `combined` is TTY-only. Each line is at most 4 KiB UTF-8 so one
//   line still fits 32 KiB after JSON escaping; each batch is at most 100
//   lines and 32 KiB serialized JSON (measured bytes, not text length).
//   `truncated` reports only that the line was cut, never Docker history.
// - SSE `docker.logs.closed`: `{ subscriptionId, reason, errorCode? }`
//   Terminal frame, then the response closes.
// - POST /api/agent/logs/claim `{ agentInstanceId }` answers
//   `{ data: { subscription: null | ClaimedSubscription } }`. Claim flips
//   waiting -> claimed atomically; claimed subscriptions are never re-claimed.
// - POST /api/agent/logs/:subscriptionId/chunks
//   `{ agentInstanceId, sequence, ready, lines }` answers
//   `{ data: { ok: true, subscriptionId, sequence } }`. Sequence starts at 1
//   and increments by one per batch/heartbeat. `ready:true` on the first
//   request after the Docker log HTTP returns 2xx, then stays true. Empty
//   `lines: []` is a heartbeat. Only the next sequence is accepted (mismatch
//   is 409); never blindly retry a batch (duplicates).
// - POST /api/agent/logs/:subscriptionId/result
//   `{ agentInstanceId, status, errorCode? }` answers
//   `{ data: { ok: true, subscriptionId, agentInstanceId } }`. `completed`
//   only on clean Docker EOF; `failed` carries a safe code, never a daemon
//   error body.
//
// Reconnect is a new viewer: the buffer is cleared and the latest 200 lines
// are fetched again; no replay across connections is promised.

/** Fixed tail: the viewer always shows the last 200 lines, then live. */
export const DOCKER_LOGS_TAIL_LINES = 200 as const;
/** Max lines per `docker.logs.lines` frame / chunks batch. */
export const DOCKER_LOGS_MAX_LINES_PER_BATCH = 100;
/** Max UTF-8 bytes per log line. */
export const DOCKER_LOGS_MAX_LINE_BYTES = 4 * 1024;
/** Max serialized SSE frame bytes (envelope included). */
export const DOCKER_LOGS_MAX_FRAME_BYTES = 32 * 1024;
/** Max serialized agent chunks/result body bytes. */
export const DOCKER_LOGS_MAX_BODY_BYTES = 32 * 1024;

export const DOCKER_LOGS_SSE_STATE = "docker.logs.state" as const;
export const DOCKER_LOGS_SSE_LINES = "docker.logs.lines" as const;
export const DOCKER_LOGS_SSE_CLOSED = "docker.logs.closed" as const;

export const DOCKER_LOG_STREAMS = ["stdout", "stderr", "combined"] as const;
export const DOCKER_LOG_STATE_STATUSES = ["waiting", "live"] as const;
export const DOCKER_LOG_CLOSED_REASONS = [
  "completed",
  "failed",
  "expired",
] as const;
export const DOCKER_LOG_RESULT_STATUSES = ["completed", "failed"] as const;

/** Safe codes only; daemon error bodies are never transported. */
export const DOCKER_LOG_ERROR_CODES = [
  "container_not_found",
  "target_mismatch",
  "daemon_unreachable",
  "logs_unavailable",
  "invalid_docker_stream",
  "agent_unavailable",
  "stream_lost",
  "slow_consumer",
  "session_expired",
] as const;

const opaqueId = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9._~-]+$/);

// Identity/key bounds mirror `protocol.go` (instance/container 32,
// subscription 64). `vpsId` mirrors `agentCommandSchema` (opaque 64).
const agentInstanceId = opaqueId(32);
const containerKey = opaqueId(32);
const subscriptionId = opaqueId(64);
const vpsId = opaqueId(64);

/** GET stream query: both params REQUIRED, no tail/cursor/follow. */
export const dockerLogsStreamQuerySchema = z
  .object({
    agentInstanceId,
    containerKey,
  })
  .strict();

const dockerLogLineSchema = z
  .object({
    stream: z.enum(DOCKER_LOG_STREAMS),
    text: z
      .string()
      .superRefine((value, ctx) => {
        // Reject unpaired (lone) UTF-16 surrogates out loud: a lone \ud800
        // escape in JSON decodes to an isolated surrogate code unit in JS,
        // while the Go agent replaces it with U+FFFD. Accepting lone
        // surrogates would cause divergence between TS and Go.
        // Valid surrogate pairs (e.g. non-BMP characters like emoji) MUST
        // be accepted.
        if (
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
            value,
          )
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "log line must not contain lone UTF-16 surrogates",
          });
        }
        if (Buffer.byteLength(value, "utf8") > DOCKER_LOGS_MAX_LINE_BYTES) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `log line exceeds ${DOCKER_LOGS_MAX_LINE_BYTES} bytes`,
          });
        }
        if (value.includes("\n")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "log line must not contain LF",
          });
        }
      }),
    truncated: z.boolean(),
  })
  // `.strict()` rejects unknown keys; the three fields are all REQUIRED
  // and non-nullable here, which is the behaviour `validateRawLogLine`
  // reconstructs in Go because struct decoding fills zero values.
  .strict();

const dockerLogLinesSchema = z.array(dockerLogLineSchema).max(
  DOCKER_LOGS_MAX_LINES_PER_BATCH,
);

export const dockerLogsStateEventSchema = z
  .object({
    subscriptionId,
    status: z.enum(DOCKER_LOG_STATE_STATUSES),
  })
  .strict();

export const dockerLogsLinesEventSchema = z
  .object({
    subscriptionId,
    lines: dockerLogLinesSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      Buffer.byteLength(JSON.stringify(value), "utf8") >
      DOCKER_LOGS_MAX_FRAME_BYTES
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `log lines frame exceeds ${DOCKER_LOGS_MAX_FRAME_BYTES} bytes`,
      });
    }
  });

export const dockerLogsClosedEventSchema = z
  .object({
    subscriptionId,
    reason: z.enum(DOCKER_LOG_CLOSED_REASONS),
    errorCode: z.enum(DOCKER_LOG_ERROR_CODES).optional(),
  })
  .strict();

/** POST /api/agent/logs/claim request body. */
export const dockerLogsClaimRequestSchema = z
  .object({
    agentInstanceId,
  })
  .strict();

const dockerLogsClaimedSubscriptionSchema = z
  .object({
    subscriptionId,
    vpsId,
    agentInstanceId,
    containerKey,
    tailLines: z.literal(DOCKER_LOGS_TAIL_LINES),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

/** POST /api/agent/logs/claim response body. */
export const dockerLogsClaimResponseSchema = z
  .object({
    data: z
      .object({
        subscription: dockerLogsClaimedSubscriptionSchema.nullable(),
      })
      .strict(),
  })
  .strict();

/**
 * POST /api/agent/logs/:subscriptionId/chunks request body.
 * `ready` stays true after the Docker source returns 2xx; the service
 * rejects `ready: false`. Empty `lines: []` is a heartbeat. Serialized
 * body must fit 32 KiB; only the next sequence is accepted (service 409).
 */
export const dockerLogsChunksRequestSchema = z
  .object({
    agentInstanceId,
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    ready: z.boolean(),
    lines: dockerLogLinesSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      Buffer.byteLength(JSON.stringify(value), "utf8") >
      DOCKER_LOGS_MAX_BODY_BYTES
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `log chunks body exceeds ${DOCKER_LOGS_MAX_BODY_BYTES} bytes`,
      });
    }
  });

/** POST /api/agent/logs/:subscriptionId/chunks response body. */
export const dockerLogsChunksResponseSchema = z
  .object({
    data: z
      .object({
        ok: z.literal(true),
        subscriptionId,
        sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict();

/** POST /api/agent/logs/:subscriptionId/result request body. */
export const dockerLogsResultRequestSchema = z
  .object({
    agentInstanceId,
    status: z.enum(DOCKER_LOG_RESULT_STATUSES),
    errorCode: z.enum(DOCKER_LOG_ERROR_CODES).optional(),
  })
  .strict();

/** POST /api/agent/logs/:subscriptionId/result response body. */
export const dockerLogsResultResponseSchema = z
  .object({
    data: z
      .object({
        ok: z.literal(true),
        subscriptionId,
        agentInstanceId,
      })
      .strict(),
  })
  .strict();

export type DockerLogsStreamQuery = z.infer<
  typeof dockerLogsStreamQuerySchema
>;
export type DockerLogLine = z.infer<typeof dockerLogLineSchema>;
export type DockerLogsStateEvent = z.infer<typeof dockerLogsStateEventSchema>;
export type DockerLogsLinesEvent = z.infer<typeof dockerLogsLinesEventSchema>;
export type DockerLogsClosedEvent = z.infer<typeof dockerLogsClosedEventSchema>;
export type DockerLogsClaimRequest = z.infer<
  typeof dockerLogsClaimRequestSchema
>;
export type DockerLogsClaimResponse = z.infer<
  typeof dockerLogsClaimResponseSchema
>;
export type DockerLogsChunksRequest = z.infer<
  typeof dockerLogsChunksRequestSchema
>;
export type DockerLogsChunksResponse = z.infer<
  typeof dockerLogsChunksResponseSchema
>;
export type DockerLogsResultRequest = z.infer<
  typeof dockerLogsResultRequestSchema
>;
export type DockerLogsResultResponse = z.infer<
  typeof dockerLogsResultResponseSchema
>;
export type DockerLogStream = (typeof DOCKER_LOG_STREAMS)[number];
export type DockerLogErrorCode = (typeof DOCKER_LOG_ERROR_CODES)[number];
