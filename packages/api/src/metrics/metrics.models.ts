export type MetricTrend = {
  range: string;
  points: number[];
  min: number;
  max: number;
  threshold: number;
  unit?: string;
};

export type MetricHistory = {
  timestamps: string[];
  cpu: number[];
  memory: number[];
  networkRx: Array<number | null>;
  networkTx: Array<number | null>;
  networkUnit: "bytes/s";
};

export type MetricSample = {
  vpsId: string;
  cpu: number;
  memory: number;
  disk: number;
  loadAverage: number;
  networkRx: number;
  networkTx: number;
  uptime: number;
  collectedAt: string;
  receivedAt?: string;
  source?: "demo" | "agent" | "repository" | "local-agent";
  agentVersion?: string;
  trend?: MetricTrend;
  /**
   * Bytes-per-second when `"bytes/s"`. Absent on old rows = unknown,
   * never a guessed unit. Legacy `source:"agent"` rows without a unit
   * are rate-proven (Go `collectNetwork` always emits `rxDelta/elapsed`)
   * and are stamped to `"bytes/s"` at read time; legacy
   * `source:"local-agent"` rows without a unit stay absent (cumulative
   * unknown, projected to null).
   */
  networkUnit?: "bytes/s";
  /**
   * False on first-sample / reset / elapsed<=0 / unreadable. Collectors
   * emit `rx=tx=0` on the wire to satisfy the numeric schema, but the
   * projector maps `false` to null, never 0.
   */
  networkAvailable?: boolean;
  /**
   * Read-time projection only, never persisted in `metric_samples`,
   * `metric_latest`, or the `trend` column. Omitted when the window
   * for this vpsId is empty.
   */
  history?: MetricHistory;
};
