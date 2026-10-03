import type { MetricHistory, MetricSample } from "./metrics.models.js";

/**
 * Shared history projector. Projects read-time `history` from a raw
 * per-host window. Never persists; callers attach the result to a
 * latest-row copy.
 *
 * Rules (locked with web + collectors):
 * - Input must already be isolated to one vpsId (`listWindow` per host).
 * - Sort oldest-first by `collectedAt` (acquisition time), stable, then
 *   cap to `limit` keeping the most recent (default 120, callers pass
 *   `config.metricWindowLimit`). `timestamps[]` carries `collectedAt`,
 *   not `receivedAt`; freshness separately stays `receivedAt ?? collectedAt`.
 * - `cpu`/`memory` are always numbers when the window is non-empty,
 *   even if every network point is null.
 * - Network points are B/s or null, never fabricated 0:
 *   `networkAvailable === false` -> null (first-sample / reset /
 *   elapsed<=0 / unreadable; collectors emit rx=tx=0 on the wire to
 *   satisfy the numeric schema).
 * - `networkUnit !== "bytes/s"` -> null (unknown, never a guessed unit),
 *   except legacy `source === "agent"` without a unit, which is
 *   rate-proven (Go `collectNetwork` always emits `rxDelta/elapsed`)
 *   and counts as B/s. Legacy `source === "local-agent"` without a
 *   unit stays unknown (cumulative, null).
 * - Empty window -> `undefined` (omit `history` entirely, web empty-state).
 * - No input mutation.
 */
export const HISTORY_NETWORK_UNIT = "bytes/s" as const;
export const DEFAULT_HISTORY_LIMIT = 120;

function networkRateOrNull(value: number, sample: MetricSample): number | null {
  if (sample.networkAvailable === false) return null;
  if (sample.networkUnit === "bytes/s") return value;
  // Legacy exception: old Go agents predate the unit field but always
  // emitted rates. Old local-agent rows predate it as cumulative totals.
  if (sample.networkUnit === undefined && sample.source === "agent") {
    return value;
  }
  return null;
}

/**
 * Stamp legacy agent rows to an explicit B/s unit at read time.
 * Web never infers from `source`; the backend stamps the projection so
 * history and latest stay consistent. Returns the same reference when
 * no stamping is needed (avoids allocation).
 */
export function stampLegacyNetworkUnit<T extends MetricSample>(sample: T): T {
  if (sample.source === "agent" && sample.networkUnit === undefined) {
    return { ...sample, networkUnit: HISTORY_NETWORK_UNIT };
  }
  return sample;
}

export function projectHistory(
  window: MetricSample[],
  limit: number = DEFAULT_HISTORY_LIMIT,
): MetricHistory | undefined {
  if (window.length === 0) return undefined;
  const cap = Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_HISTORY_LIMIT;
  if (cap === 0) return undefined;

  // Stable oldest-first sort by acquisition time; never mutates input.
  const indexed = window.map((sample, index) => ({ sample, index }));
  indexed.sort((a, b) => {
    const aTime = Date.parse(a.sample.collectedAt);
    const bTime = Date.parse(b.sample.collectedAt);
    const timeDiff =
      (Number.isFinite(aTime) ? aTime : 0) -
      (Number.isFinite(bTime) ? bTime : 0);
    if (timeDiff !== 0) return timeDiff;
    return a.index - b.index;
  });
  const sliced =
    indexed.length > cap ? indexed.slice(indexed.length - cap) : indexed;

  const timestamps: string[] = new Array(sliced.length);
  const cpu: number[] = new Array(sliced.length);
  const memory: number[] = new Array(sliced.length);
  const networkRx: Array<number | null> = new Array(sliced.length);
  const networkTx: Array<number | null> = new Array(sliced.length);

  for (let i = 0; i < sliced.length; i++) {
    const sample = sliced[i]!.sample;
    timestamps[i] = sample.collectedAt;
    cpu[i] = sample.cpu;
    memory[i] = sample.memory;
    networkRx[i] = networkRateOrNull(sample.networkRx, sample);
    networkTx[i] = networkRateOrNull(sample.networkTx, sample);
  }

  return {
    timestamps,
    cpu,
    memory,
    networkRx,
    networkTx,
    networkUnit: HISTORY_NETWORK_UNIT,
  };
}

/**
 * Attach read-time `history` plus legacy unit stamping to a latest-row
 * copy. Never mutates inputs; never persists. Returns a new object only
 * when stamping or history requires it, otherwise the same reference.
 */
export function withHistory(
  latest: MetricSample,
  window: MetricSample[],
  limit?: number,
): MetricSample {
  const stamped = stampLegacyNetworkUnit(latest);
  const history = projectHistory(window, limit);
  if (history === undefined) {
    return stamped === latest ? latest : stamped;
  }
  return { ...stamped, history };
}
