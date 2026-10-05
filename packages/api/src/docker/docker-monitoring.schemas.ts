import { z } from "zod";
import { createHash } from "node:crypto";
import type { DockerCursorPayload, DockerListScope, DockerEventWatermark, DockerInitialWatermark } from "./docker-monitoring.models.js";

export const DOCKER_INGEST_DIGEST_VERSION = 2;
export const DOCKER_INGEST_LEGACY_DIGEST_VERSION = 1;
export function canonicalDockerJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDockerJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalDockerJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function dockerIngestRequestDigest(value: unknown, version = DOCKER_INGEST_DIGEST_VERSION): string { return createHash("sha256").update(`docker-ingest-v${version}:`).update(canonicalDockerJson(value)).digest("hex"); }
export const DOCKER_INITIAL_WATERMARK: DockerInitialWatermark = { timeNano: "0", boundaryDigests: [] };
export function compareDockerWatermarks(a: Pick<DockerEventWatermark, "timeNano" | "boundaryDigests">, b: Pick<DockerEventWatermark, "timeNano" | "boundaryDigests">): number { const n = BigInt(a.timeNano) - BigInt(b.timeNano); if (n !== 0n) return n < 0n ? -1 : 1; const aJ = canonicalDockerJson(a.boundaryDigests); const bJ = canonicalDockerJson(b.boundaryDigests); return aJ < bJ ? -1 : aJ > bJ ? 1 : 0; }
export function compareDockerSourceSequence(a: string, b: string): number { const n = BigInt(a) - BigInt(b); return n === 0n ? 0 : n < 0n ? -1 : 1; }

export const MAX_HISTORY_LIMIT = 500;
export const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_EVENT_LIMIT = 200;
export const DEFAULT_EVENT_LIMIT = 50;
export const MAX_ALERT_LIMIT = 200;
export const DEFAULT_ALERT_LIMIT = 50;
export const MAX_QUERY_RANGE_DAYS = 30;
export const MAX_QUERY_RANGE_MS = MAX_QUERY_RANGE_DAYS * 24 * 60 * 60 * 1000;

const vpsIdSchema = z.string().min(1).max(128);
const opaqueId = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9._~-]+$/);
const isoDate = z.string().datetime({ offset: true });

// Effective-range policy (deterministic, documented):
// - Two-sided [from,to] must satisfy from <= to and (to-from) <= 30 days.
// - from-only is evaluated against `now` (Date.now()) as the implicit bound:
//   effective window [from, now] must not exceed 30 days (else 400).
// - to-only is deterministically normalized before repository execution to
//   `from = to - 30 days`, yielding the bounded window [to-30d, to]. The query
//   schemas accept any well-formed `to` alone; the service applies the
//   normalization so repositories never execute an unbounded backward scan.
//   Repositories stay bounded via keyset pagination + per-VPS caps; they do
//   not silently clamp dates.
export function normalizeDockerDateRange<T extends { from?: string; to?: string }>(query: T): T {
  if (query.from === undefined && query.to !== undefined) {
    const toMs = Date.parse(query.to);
    if (Number.isNaN(toMs)) return query;
    return { ...query, from: new Date(toMs - MAX_QUERY_RANGE_MS).toISOString() };
  }
  return query;
}

function rangeRefine<T extends { from?: string; to?: string }>(schema: z.ZodType<T>) {
  return schema.superRefine((v, ctx) => {
    const f = (v as { from?: string }).from;
    const t = (v as { to?: string }).to;
    if (f !== undefined && t !== undefined) {
      const fMs = Date.parse(f);
      const tMs = Date.parse(t);
      if (Number.isNaN(fMs) || Number.isNaN(tMs) || fMs > tMs) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`from` must not be after `to`" });
        return;
      }
      if (tMs - fMs > MAX_QUERY_RANGE_MS) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `query range must not exceed ${MAX_QUERY_RANGE_DAYS} days` });
      }
      return;
    }
    const nowMs = Date.now();
    if (f !== undefined && t === undefined) {
      const fMs = Date.parse(f);
      if (Number.isNaN(fMs)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`from` must be a valid datetime" });
        return;
      }
      // Future `from` yields an empty (not over-range) window; only enforce
      // when the implicit [from, now] window looks backward.
      if (fMs <= nowMs && nowMs - fMs > MAX_QUERY_RANGE_MS) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `query range must not exceed ${MAX_QUERY_RANGE_DAYS} days` });
      }
      return;
    }
    if (t !== undefined && f === undefined && Number.isNaN(Date.parse(t))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`to` must be a valid datetime" });
    }
  });
}

const baseList = { cursor: z.string().min(1).max(4096).optional() };

export const dockerHostHistoryQuerySchema = rangeRefine(
  z.object({
    vpsId: vpsIdSchema,
    limit: z.coerce.number().int().positive().max(MAX_HISTORY_LIMIT).default(DEFAULT_HISTORY_LIMIT),
    from: isoDate.optional(),
    to: isoDate.optional(),
    ...baseList,
  }).strict(),
);

export const dockerContainerHistoryQuerySchema = rangeRefine(
  z.object({
    vpsId: vpsIdSchema,
    agentInstanceId: opaqueId(32),
    containerKey: opaqueId(32),
    limit: z.coerce.number().int().positive().max(MAX_HISTORY_LIMIT).default(DEFAULT_HISTORY_LIMIT),
    from: isoDate.optional(),
    to: isoDate.optional(),
    ...baseList,
  }).strict(),
);

export const dockerEventActionSchema = z.enum(["create", "start", "restart", "die", "stop", "kill", "destroy", "remove", "health_status", "stream_gap", "daemon_restarted"]);

export const dockerEventsQuerySchema = rangeRefine(
  z.object({
    vpsId: vpsIdSchema,
    limit: z.coerce.number().int().positive().max(MAX_EVENT_LIMIT).default(DEFAULT_EVENT_LIMIT),
    from: isoDate.optional(),
    to: isoDate.optional(),
    action: dockerEventActionSchema.optional(),
    agentInstanceId: opaqueId(32).optional(),
    containerKey: opaqueId(32).optional(),
    ...baseList,
  }).strict().superRefine((v, ctx) => {
    const hasInstance = v.agentInstanceId !== undefined;
    const hasContainer = v.containerKey !== undefined;
    if (hasContainer !== hasInstance) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "agentInstanceId and containerKey must be provided together" });
    }
  }),
);

export const dockerRollupsQuerySchema = rangeRefine(
  z.object({
    vpsId: vpsIdSchema,
    limit: z.coerce.number().int().positive().max(MAX_HISTORY_LIMIT).default(DEFAULT_HISTORY_LIMIT),
    from: isoDate.optional(),
    to: isoDate.optional(),
    agentInstanceId: opaqueId(32).optional(),
    scope: z.enum(["host", "container", "aggregate"]).optional(),
    containerKey: opaqueId(32).optional(),
    ...baseList,
  }).strict().superRefine((v, ctx) => {
    const hasInstance = v.agentInstanceId !== undefined;
    const hasContainer = v.containerKey !== undefined;
    if (hasContainer !== hasInstance) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "agentInstanceId and containerKey must be provided together" });
    }
  }),
);

export const dockerAlertsQuerySchema = rangeRefine(
  z.object({
    vpsId: vpsIdSchema,
    limit: z.coerce.number().int().positive().max(MAX_ALERT_LIMIT).default(DEFAULT_ALERT_LIMIT),
    from: isoDate.optional(),
    to: isoDate.optional(),
    state: z.enum(["open", "acknowledged", "resolved"]).optional(),
    ruleKind: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
    agentInstanceId: opaqueId(32).optional(),
    containerKey: opaqueId(32).optional(),
    ...baseList,
  }).strict().superRefine((v, ctx) => {
    const hasInstance = v.agentInstanceId !== undefined;
    const hasContainer = v.containerKey !== undefined;
    if (hasContainer !== hasInstance) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "agentInstanceId and containerKey must be provided together" });
    }
  }),
);

export const dockerAlertAcknowledgeSchema = z.object({
  vpsId: vpsIdSchema,
  alertId: z.string().min(1).max(128),
}).strict();

export type DockerHostHistoryQuery = z.infer<typeof dockerHostHistoryQuerySchema>;
export type DockerContainerHistoryQuery = z.infer<typeof dockerContainerHistoryQuerySchema>;
export type DockerEventsQuery = z.infer<typeof dockerEventsQuerySchema>;
export type DockerAlertsQuery = z.infer<typeof dockerAlertsQuerySchema>;
export type DockerRollupsQuery = z.infer<typeof dockerRollupsQuerySchema>;

const opaqueCursorId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._~-]+$/);
const cursorPayloadSchema = z.object({
  v: z.literal(1),
  vpsId: vpsIdSchema,
  scope: z.enum(["host", "container", "events", "alerts", "rollups"]),
  agentInstanceId: opaqueId(32).optional(),
  containerKey: opaqueId(32).optional(),
  filters: z.record(z.string().max(64), z.string().max(512).optional()),
  order: z.enum(["effectiveAt,id", "eventOccurredAt,id", "lastObservedAt,id", "bucketStart,id"]),
  last: z.object({ at: isoDate, id: opaqueCursorId }).strict(),
}).strict();

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function fromBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

export function encodeDockerCursor(payload: DockerCursorPayload): string {
  if (payload.v !== 1) throw new Error("unsupported cursor version");
  cursorPayloadSchema.parse(payload);
  return toBase64Url(JSON.stringify(payload));
}

export function decodeDockerCursor(cursor: string): DockerCursorPayload {
  let json: string;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("bad charset");
    json = fromBase64Url(cursor);
  } catch {
    throw new Error("malformed cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("malformed cursor");
  }
  try {
    return cursorPayloadSchema.parse(parsed) as DockerCursorPayload;
  } catch {
    throw new Error("malformed cursor");
  }
}

export type CursorBinding = { vpsId: string; scope: DockerListScope; agentInstanceId?: string; containerKey?: string; filters?: Record<string, string | undefined>; order?: DockerCursorPayload["order"] };

export function assertDockerCursorBinding(cursor: DockerCursorPayload, binding: CursorBinding): void {
  if (cursor.vpsId !== binding.vpsId) throw new Error("cursor vpsId mismatch");
  if (cursor.scope !== binding.scope) throw new Error("cursor scope mismatch");
  if ((cursor.agentInstanceId ?? undefined) !== (binding.agentInstanceId ?? undefined)) throw new Error("cursor agentInstanceId mismatch");
  if ((cursor.containerKey ?? undefined) !== (binding.containerKey ?? undefined)) throw new Error("cursor containerKey mismatch");
  if (binding.order !== undefined && cursor.order !== binding.order) throw new Error("cursor order mismatch");
  if (binding.filters !== undefined) {
    const a = cursor.filters ?? {};
    const b: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(binding.filters)) if (v !== undefined) b[k] = v;
    const aKeys = Object.keys(a).filter((k) => a[k] !== undefined).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length || !aKeys.every((k, i) => k === bKeys[i] && a[k] === b[k])) {
      throw new Error("cursor filters mismatch");
    }
  }
}
