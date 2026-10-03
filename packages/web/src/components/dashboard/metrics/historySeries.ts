import type { DashboardMetric, MetricHistoryPoint } from "../../../lib/api";

export type ChartSeries = {
  key: string;
  name: string;
  color: string;
  /** Same-host sample points, chronological; value null marks a gap. */
  points: MetricHistoryPoint[];
  /** Optional dashed reference line (percent charts only, never network). */
  threshold?: number;
  /** Shared-axis unit used to format y-tick values. */
  unit?: string;
};

function zipPoints(
  timestamps: string[],
  values: ReadonlyArray<number | null | undefined>,
): MetricHistoryPoint[] {
  return timestamps.map((t, index) => {
    const raw = values[index];
    return {
      t,
      value:
        typeof raw === "number" && Number.isFinite(raw) && raw >= 0
          ? raw
          : null,
    };
  });
}

/** "2026-10-03T12:34:56.000Z" -> "12:34" (local time); "" when unparseable. */
export function formatChartTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Bytes-per-second rate with an explicit unit; 0 B/s is valid, never "n/a". */
export function formatThroughput(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "n/a";
  if (value === 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
  let next = value;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  return `${next >= 10 || index === 0 ? next.toFixed(0) : next.toFixed(1)} ${units[index]}`;
}

/** Compact y-tick label for a shared-axis unit. */
export function formatTickValue(value: number, unit?: string): string {
  if (!Number.isFinite(value)) return "";
  if (unit === "bytes/s") {
    if (value <= 0) return "0/s";
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M/s`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}K/s`;
    return `${Math.round(value)}/s`;
  }
  return value.toFixed(0);
}

/**
 * Latest network readout for one host. Trusts only the explicit
 * `networkUnit` stamp: absent unit (legacy cumulative rows) or
 * `networkAvailable === false` renders "n/a" — never a guessed unit.
 */
export function formatNetworkValue(
  metric: DashboardMetric | null | undefined,
  key: "networkRx" | "networkTx",
): string {
  if (
    !metric ||
    metric.networkUnit !== "bytes/s" ||
    metric.networkAvailable === false
  ) {
    return "n/a";
  }
  const value = metric[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "n/a";
  }
  return formatThroughput(value);
}

export function formatNetworkPair(
  metric: DashboardMetric | null | undefined,
): string {
  const rx = formatNetworkValue(metric, "networkRx");
  const tx = formatNetworkValue(metric, "networkTx");
  return rx === "n/a" && tx === "n/a" ? "n/a" : `${rx} / ${tx}`;
}

/** CPU + memory percent series from one host's own history window. */
export function cpuMemorySeries(
  metric: DashboardMetric | null | undefined,
): ChartSeries[] {
  const history = metric?.history;
  return [
    {
      key: "cpu",
      name: "CPU",
      color: "hsl(var(--telemetry-cpu))",
      points: history ? zipPoints(history.timestamps, history.cpu) : [],
      unit: "%",
    },
    {
      key: "memory",
      name: "RAM",
      color: "hsl(var(--telemetry-memory))",
      points: history ? zipPoints(history.timestamps, history.memory) : [],
      unit: "%",
    },
  ];
}

/** RX/TX bytes-per-second series from one host's own history window. */
export function networkSeries(
  metric: DashboardMetric | null | undefined,
): ChartSeries[] {
  const history = metric?.history;
  const stamped = history?.networkUnit === "bytes/s";
  return [
    {
      key: "rx",
      name: "RX",
      color: "hsl(var(--telemetry-rx))",
      points:
        history && stamped
          ? zipPoints(history.timestamps, history.networkRx)
          : [],
      unit: "bytes/s",
    },
    {
      key: "tx",
      name: "TX",
      color: "hsl(var(--telemetry-tx))",
      points:
        history && stamped
          ? zipPoints(history.timestamps, history.networkTx)
          : [],
      unit: "bytes/s",
    },
  ];
}

/**
 * Chart focus for a server filter: the selected host, or — for "all" — the
 * most recently updated single host. Never a cross-host merge.
 */
export function pickFocusMetric(
  metrics: DashboardMetric[],
  vpsId: string,
): DashboardMetric | null {
  if (vpsId !== "all") {
    return metrics.find((metric) => metric.vpsId === vpsId) ?? null;
  }
  let latest: DashboardMetric | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const metric of metrics) {
    const time = Date.parse(metric.collectedAt);
    if (!Number.isNaN(time) && time >= latestTime) {
      latest = metric;
      latestTime = time;
    }
  }
  return latest ?? metrics[0] ?? null;
}

/**
 * Fleet sum of bytes-per-second rates. Only stamped, available rows count;
 * `known` is false when no row qualifies (readouts render "n/a", never 0).
 */
export function sumNetworkRate(
  metrics: DashboardMetric[],
  key: "networkRx" | "networkTx",
): { total: number; known: boolean } {
  let total = 0;
  let known = false;
  for (const metric of metrics) {
    if (metric.networkUnit !== "bytes/s" || metric.networkAvailable === false) {
      continue;
    }
    const value = metric[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      continue;
    }
    total += value;
    known = true;
  }
  return { total, known };
}
