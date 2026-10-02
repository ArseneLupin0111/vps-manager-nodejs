import { useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { chipVariant, freshnessLabel } from "../../../lib/dashboard-formatters";
import type { DashboardOverview } from "../../../lib/api";
import { formatBytes } from "../shared/formatBytes";
import { formatUptime } from "../shared/formatUptime";
import { EmptyState } from "../shared/EmptyState";
import {
  formatBytes as formatDockerBytes,
  formatDockerError,
} from "../servers/helpers";

type Tone = "ok" | "warn" | "crit";

const toneText: Record<Tone, string> = {
  ok: "text-text",
  warn: "text-warn",
  crit: "text-crit",
};

const loadTone = (value: number): Tone =>
  value >= 85 ? "crit" : value >= 70 ? "warn" : "ok";

export function MetricsPanel({
  metrics,
  dockerMetrics,
}: {
  metrics: DashboardOverview["metrics"];
  dockerMetrics: DashboardOverview["dockerMetrics"];
}) {
  const [serverFilter, setServerFilter] = useState("all");
  const [metricFilter, setMetricFilter] = useState("all");
  const serverIds = Array.from(
    new Set([
      ...metrics.map((metric) => metric.vpsId),
      ...dockerMetrics.map((metric) => metric.vpsId),
    ]),
  ).sort();
  const visibleMetrics = metrics.filter(
    (metric) => serverFilter === "all" || metric.vpsId === serverFilter,
  );
  const visibleDockerMetrics = dockerMetrics.filter(
    (metric) => serverFilter === "all" || metric.vpsId === serverFilter,
  );
  const fresh = metrics.filter((metric) => metric.freshness === "fresh").length;
  const highestCpu = maxMetric(metrics, "cpu");
  const highestDisk = maxMetric(metrics, "disk");
  const highestMemory = maxMetric(metrics, "memory");
  const highestLoad = metrics.length
    ? [...metrics].sort((a, b) => b.loadAverage - a.loadAverage)[0]
    : null;
  // Trend history is reported per metric with an explicit unit. Production
  // agents only report `unit: "cpu"`; demo fixtures may report `memory` or
  // `disk`. There is no per-series RAM or RX/TX history, so each chart series
  // MUST match its requested unit instead of relabeling another unit's points.
  const cpuTrendMetric =
    metrics.find((metric) => metric.trend?.unit === "cpu") ?? null;
  const memoryTrendMetric =
    metrics.find((metric) => metric.trend?.unit === "memory") ?? null;
  const networkTrendMetric =
    metrics.find((metric) => metric.trend?.unit === "network") ?? null;
  const totalRx = metrics.reduce((sum, metric) => sum + metric.networkRx, 0);
  const totalTx = metrics.reduce((sum, metric) => sum + metric.networkTx, 0);
  const alerts = buildMetricAlerts(metrics);
  const focusServer =
    serverFilter === "all"
      ? null
      : metrics.find((metric) => metric.vpsId === serverFilter) || null;
  return (
    <div className="grid min-w-0 gap-4">
      <section
        className="grid gap-3 border border-line bg-panel p-3 md:grid-cols-[minmax(0,1fr)_190px]"
        aria-label="Metrics filters"
      >
        <select
          aria-label="Filter metrics server"
          className="h-9 w-full border border-line bg-ink px-3 text-[13px] text-text focus:border-signal focus:outline-none"
          value={serverFilter}
          onChange={(event) => setServerFilter(event.target.value)}
        >
          <option value="all">All servers</option>
          {serverIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter metric type"
          className="h-9 w-full border border-line bg-ink px-3 text-[13px] text-text focus:border-signal focus:outline-none"
          value={metricFilter}
          onChange={(event) => setMetricFilter(event.target.value)}
        >
          <option value="all">All metrics</option>
          <option value="cpu">CPU</option>
          <option value="memory">Memory</option>
          <option value="disk">Disk</option>
          <option value="load">Load</option>
          <option value="network">Network</option>
        </select>
      </section>

      <section
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Metrics summary"
      >
        <MetricStat
          label="CPU"
          value={highestCpu ? `${highestCpu.cpu.toFixed(1)}%` : "n/a"}
          sub={highestCpu ? `peak · ${highestCpu.vpsId}` : "no telemetry"}
          tone={highestCpu ? loadTone(highestCpu.cpu) : undefined}
        />
        <MetricStat
          label="RAM"
          value={highestMemory ? `${highestMemory.memory.toFixed(1)}%` : "n/a"}
          sub={highestMemory ? `peak · ${highestMemory.vpsId}` : "no telemetry"}
          tone={highestMemory ? loadTone(highestMemory.memory) : undefined}
        />
        <MetricStat
          label="Disk"
          value={highestDisk ? `${highestDisk.disk.toFixed(1)}%` : "n/a"}
          sub={highestDisk ? `peak · ${highestDisk.vpsId}` : "no telemetry"}
          tone={highestDisk ? loadTone(highestDisk.disk) : undefined}
        />
        <MetricStat
          label="Load"
          value={highestLoad ? highestLoad.loadAverage.toFixed(2) : "n/a"}
          sub={
            highestLoad
              ? `peak · ${highestLoad.vpsId} · ${fresh}/${metrics.length} fresh`
              : "no telemetry"
          }
        />
      </section>

      <section
        className="grid grid-cols-2 gap-4 max-[1000px]:grid-cols-1"
        aria-label="Metric trends"
      >
        <ChartPanel
          title="CPU & memory"
          hint="Agent-reported utilization history"
          series={[
            {
              key: "cpu",
              name: "CPU",
              color: "hsl(var(--signal))",
              metric: cpuTrendMetric,
            },
            {
              key: "memory",
              name: "RAM",
              color: "hsl(var(--info))",
              metric: memoryTrendMetric,
            },
          ]}
        />
        <ChartPanel
          title="Network in / out"
          hint="Agent-reported throughput"
          series={[
            {
              key: "network",
              name: "Network",
              color: "hsl(var(--warn))",
              metric: networkTrendMetric,
            },
          ]}
          readouts={[
            { label: "RX", value: formatBytes(totalRx) },
            { label: "TX", value: formatBytes(totalTx) },
          ]}
        />
      </section>

      {visibleMetrics.length ? (
        <section className="grid gap-3" aria-label="Server metrics">
          {visibleMetrics.map((metric) => (
            <MetricServerCard
              key={metric.vpsId}
              metric={metric}
              focus={metricFilter}
            />
          ))}
        </section>
      ) : (
        <EmptyState>No metrics match these filters.</EmptyState>
      )}

      <DockerMetricsSection
        dockerMetrics={visibleDockerMetrics}
        totalDockerMetrics={dockerMetrics}
      />

      <section
        className="grid grid-cols-[1.6fr_1fr] gap-4 max-[1000px]:grid-cols-1"
        aria-label="Workload and alerts"
      >
        <div className="border border-line bg-panel">
          <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <h2 className="text-[14px] font-semibold">Docker workloads</h2>
              <p className="mt-0.5 text-[12px] text-dim">
                Top containers by CPU across reporting agents.
              </p>
            </div>
            <Pill tone={focusServer ? "ok" : "neutral"}>
              {focusServer ? focusServer.vpsId : `${dockerMetrics.length} hosts`}
            </Pill>
          </header>
          <WorkloadList
            dockerMetrics={
              focusServer
                ? visibleDockerMetrics
                : dockerMetrics
            }
          />
        </div>
        <div className="border border-line bg-panel">
          <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <h2 className="text-[14px] font-semibold">Recent metric alerts</h2>
            </div>
            <Pill tone={alerts.length ? "warn" : "neutral"}>
              {alerts.length} alerts
            </Pill>
          </header>
          {alerts.length ? (
            <ul className="space-y-2 p-4">
              {alerts.map((alert) => (
                <li
                  key={`${alert.vpsId}-${alert.message}`}
                  className="flex gap-2 text-[13px]"
                >
                  <AlertTriangle
                    size={14}
                    className="mt-0.5 shrink-0 text-warn"
                    aria-hidden="true"
                  />
                  <span>
                    <span className="tnum text-dim">{alert.vpsId}</span>
                    {" · "}
                    {alert.message}
                    <span className="tnum text-dim"> · {alert.time}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 py-8 text-center">
              <div className="text-[13px] font-medium">No alerts</div>
              <p className="mx-auto mt-1 max-w-sm text-[12px] text-dim">
                No resource warnings from current metrics.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "crit" | "info";
}) {
  const t = {
    neutral: "border-line text-dim",
    ok: "border-signal/40 text-signal bg-signal/10",
    warn: "border-warn/40 text-warn bg-warn/10",
    crit: "border-crit/40 text-crit bg-crit/10",
    info: "border-info/40 text-info bg-info/10",
  }[tone];
  return (
    <span
      className={`inline-flex items-center border px-1.5 py-0.5 text-[11px] font-medium ${t}`}
    >
      {children}
    </span>
  );
}

function MetricStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: Tone;
}) {
  return (
    <div className="border border-line bg-panel p-4">
      <div className="text-[11px] uppercase tracking-[0.14em] text-dim">
        {label}
      </div>
      <div className={`tnum mt-1.5 text-2xl font-medium ${tone ? toneText[tone] : ""}`}>
        {value}
      </div>
      <div className="mt-0.5 truncate text-[12px] text-dim" title={sub}>
        {sub}
      </div>
    </div>
  );
}

function ChartPanel({
  title,
  hint,
  series,
  readouts,
}: {
  title: string;
  hint: string;
  series: Array<{
    key: string;
    name: string;
    color: string;
    metric: DashboardOverview["metrics"][number] | null;
  }>;
  readouts?: Array<{ label: string; value: string }>;
}) {
  const withTrend = series.filter((entry) => entry.metric?.trend?.points.length);
  const gid = title.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <section className="border border-line bg-panel">
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <p className="mt-0.5 text-[12px] text-dim">{hint}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {readouts?.map((readout) => (
            <span key={readout.label} className="text-[12px] text-dim">
              {readout.label}{" "}
              <span className="tnum text-text">{readout.value}</span>
            </span>
          ))}
          {series.map((entry) => (
            <span
              key={entry.key}
              className="flex items-center gap-1.5 text-[12px] text-dim"
            >
              <i
                className="inline-block h-0.5 w-3"
                style={{
                  background: entry.color,
                  opacity: entry.metric?.trend?.points.length ? 1 : 0.35,
                }}
              />
              {entry.name}
              {!entry.metric?.trend?.points.length && (
                <span className="text-warn">no history</span>
              )}
            </span>
          ))}
        </div>
      </header>
      <div className="px-4 py-4">
        {withTrend.length ? (
          <TrendChart gid={gid} series={withTrend} />
        ) : (
          <div className="px-4 py-8 text-center">
            <div className="text-[13px] font-medium">History unavailable</div>
            <p className="mx-auto mt-1 max-w-sm text-[12px] text-dim">
              {readouts?.length
                ? `Agents report current ${series
                    .map((entry) => entry.name)
                    .join(" / ")} values only; no trend history is collected yet.`
                : "Trend history is not reported for these metrics yet."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function TrendChart({
  gid,
  series,
}: {
  gid: string;
  series: Array<{
    key: string;
    name: string;
    color: string;
    metric: DashboardOverview["metrics"][number] | null;
  }>;
}) {
  const plotted = series.filter((entry) => entry.metric?.trend?.points.length);
  const range = plotted[0]?.metric?.trend?.range ?? "trend";
  const maxPoint = Math.max(
    ...plotted.flatMap((entry) => entry.metric?.trend?.points ?? [1]),
    1,
  );
  const width = 100;
  const height = 56;
  const top = 6;
  const bottom = 50;
  const toPolyline = (values: number[]) =>
    values
      .map(
        (point, index) =>
          `${(index / Math.max(values.length - 1, 1)) * width},${bottom - (point / maxPoint) * (bottom - top)}`,
      )
      .join(" ");
  const ticks = [0, 1, 2, 3].map((index) => {
    const value = (maxPoint / 3) * (3 - index);
    const y = top + ((bottom - top) / 3) * index;
    return { value, y };
  });
  return (
    <div>
      <svg
        className="h-48 w-full"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${plotted.map((entry) => entry.name).join(" and ")} trend`}
      >
        <defs>
          {plotted.map((entry) => (
            <linearGradient
              key={entry.key}
              id={`${gid}-${entry.key}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="0%"
                style={{ stopColor: entry.color, stopOpacity: 0.26 }}
              />
              <stop
                offset="100%"
                style={{ stopColor: entry.color, stopOpacity: 0 }}
              />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((tick) => (
          <g key={tick.y}>
            <line
              x1="0"
              x2={width}
              y1={tick.y}
              y2={tick.y}
              strokeWidth="0.3"
              style={{ stroke: "hsl(var(--line))" }}
            />
            <text
              x={width}
              y={tick.y - 1}
              textAnchor="end"
              fontSize="3.4"
              fontFamily="Geist Mono, monospace"
              style={{ fill: "hsl(var(--dim))" }}
            >
              {tick.value.toFixed(0)}
            </text>
          </g>
        ))}
        {plotted.map((entry) => {
          const trend = entry.metric?.trend;
          if (!trend?.points.length) return null;
          const thresholdY =
            bottom -
            (trend.threshold / Math.max(maxPoint, trend.threshold)) *
              (bottom - top);
          const line = toPolyline(trend.points);
          return (
            <g key={entry.key}>
              <polygon
                points={`0,${bottom} ${line} ${width},${bottom}`}
                fill={`url(#${gid}-${entry.key})`}
              />
              <polyline
                points={line}
                fill="none"
                strokeWidth="0.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                style={{ stroke: entry.color }}
              />
              <line
                x1="0"
                x2={width}
                y1={thresholdY}
                y2={thresholdY}
                strokeDasharray="2 1.5"
                strokeWidth="0.4"
                style={{ stroke: entry.color, opacity: 0.45 }}
              />
            </g>
          );
        })}
        <line
          x1="0"
          x2={width}
          y1={bottom}
          y2={bottom}
          strokeWidth="0.4"
          style={{ stroke: "hsl(var(--line))" }}
        />
      </svg>
      <div className="tnum mt-1 flex justify-between text-[10px] uppercase tracking-[0.08em] text-dim">
        <span>{range}</span>
        <span>now</span>
      </div>
    </div>
  );
}

function WorkloadList({
  dockerMetrics,
}: {
  dockerMetrics: DashboardOverview["dockerMetrics"];
}) {
  const containers = dockerMetrics
    .filter((metric) => metric.available)
    .flatMap((metric) =>
      metric.containers.map((container) => ({
        ...container,
        vpsId: metric.vpsId,
      })),
    )
    .sort((a, b) => b.cpuPercent - a.cpuPercent)
    .slice(0, 5);
  if (!containers.length) {
    return (
      <div className="px-4 py-8 text-center">
        <div className="text-[13px] font-medium">No running containers</div>
        <p className="mx-auto mt-1 max-w-sm text-[12px] text-dim">
          Enable Docker monitoring to see per-container resources.
        </p>
      </div>
    );
  }
  return (
    <ul>
      {containers.map((container) => (
        <li
          key={`${container.vpsId}-${container.containerKey}`}
          className="flex items-center gap-4 border-b border-line px-4 py-2.5 last:border-0"
        >
          <span className="min-w-0 flex-1 truncate" title={container.image}>
            {container.name}
          </span>
          <div className="h-1 w-24 shrink-0 bg-line">
            <div
              className="h-full bg-signal"
              style={{ width: `${Math.min(100, container.cpuPercent)}%` }}
            />
          </div>
          <span className="tnum w-12 shrink-0 text-right text-dim">
            {container.cpuPercent.toFixed(1)}%
          </span>
        </li>
      ))}
    </ul>
  );
}

function DockerMetricsSection({
  dockerMetrics,
  totalDockerMetrics,
}: {
  dockerMetrics: DashboardOverview["dockerMetrics"];
  totalDockerMetrics: DashboardOverview["dockerMetrics"];
}) {
  const available = totalDockerMetrics.filter((metric) => metric.available);
  const totals = available.reduce(
    (summary, metric) => ({
      containers: summary.containers + metric.containerTotal,
      running: summary.running + metric.containerRunning,
      cpu: summary.cpu + metric.cpuPercent,
      memory: summary.memory + metric.memoryUsageBytes,
      network:
        summary.network + metric.networkRxBytes + metric.networkTxBytes,
    }),
    { containers: 0, running: 0, cpu: 0, memory: 0, network: 0 },
  );

  return (
    <section className="grid gap-3" aria-label="Docker metrics">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-semibold">Docker workloads</h3>
          <p className="mt-0.5 text-[12px] text-dim">
            Agent-reported container usage by server.
          </p>
        </div>
        <Pill tone={available.length ? "ok" : "neutral"}>
          {available.length}/{totalDockerMetrics.length} available
        </Pill>
      </div>

      {totalDockerMetrics.length ? (
        <section
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5"
          aria-label="Docker metrics summary"
        >
          <MetricStat
            label="Containers"
            value={`${totals.running}/${totals.containers}`}
            sub={`${totals.running} running`}
          />
          <MetricStat
            label="Docker hosts"
            value={`${available.length}/${totalDockerMetrics.length}`}
            sub="Reporting agents"
          />
          <MetricStat
            label="Container CPU"
            value={`${totals.cpu.toFixed(1)}%`}
            sub="Across hosts"
          />
          <MetricStat
            label="Container RAM"
            value={formatDockerBytes(totals.memory)}
            sub="Current usage"
          />
          <MetricStat
            label="Container network"
            value={formatDockerBytes(totals.network)}
            sub="RX + TX"
          />
        </section>
      ) : null}

      {dockerMetrics.length ? (
        <div className="grid gap-3">
          {dockerMetrics.map((metric) => (
            <DockerServerMetrics key={metric.vpsId} metric={metric} />
          ))}
        </div>
      ) : (
        <EmptyState>
          {totalDockerMetrics.length
            ? "No Docker metrics match this server filter."
            : "No Docker metrics have been reported yet."}
        </EmptyState>
      )}
    </section>
  );
}

function DockerServerMetrics({
  metric,
}: {
  metric: DashboardOverview["dockerMetrics"][number];
}) {
  return (
    <article className="min-w-0 border border-line bg-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="truncate text-lg font-medium text-text">
              {metric.vpsId}
            </strong>
            <Badge variant={metric.available ? "ready" : "pending"}>
              {metric.available ? "Docker available" : "Unavailable"}
            </Badge>
          </div>
          <p className="mt-1 text-[12px] text-dim">
            Collected {freshnessLabel(metric.collectedAt)}
            {metric.agentVersion ? ` · Agent ${metric.agentVersion}` : ""}
          </p>
        </div>
        {metric.available ? (
          <div className="flex flex-wrap gap-1.5 text-[11px] text-dim">
            <DockerStat
              label="Running"
              value={`${metric.containerRunning}/${metric.containerTotal}`}
            />
            <DockerStat label="CPU" value={`${metric.cpuPercent.toFixed(1)}%`} />
            <DockerStat
              label="RAM"
              value={formatDockerBytes(metric.memoryUsageBytes)}
            />
            <DockerStat
              label="Net"
              value={formatDockerBytes(
                metric.networkRxBytes + metric.networkTxBytes,
              )}
            />
            <DockerStat
              label="IO"
              value={formatDockerBytes(
                metric.blockReadBytes + metric.blockWriteBytes,
              )}
            />
            <DockerStat label="PIDs" value={String(metric.pids)} />
          </div>
        ) : null}
      </div>

      {!metric.available ? (
        <div className="mt-3 border-l-2 border-line pl-3">
          <p className="text-[13px] text-dim">
            {formatDockerError(metric.errorCode)}
          </p>
          <p className="mt-1 text-[12px] text-dim">
            Check Docker socket access for the agent.
          </p>
        </div>
      ) : metric.containers.length ? (
        <div className="mt-4 overflow-hidden border border-line">
          <div className="hidden grid-cols-[minmax(140px,1fr)_minmax(160px,1.25fr)_0.7fr_0.7fr_0.8fr_0.6fr] gap-3 bg-raised px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-dim md:grid">
            <span>Container</span>
            <span>Image</span>
            <span>State</span>
            <span>CPU</span>
            <span>Memory</span>
            <span>PIDs</span>
          </div>
          <div className="divide-y divide-line">
            {metric.containers.map((container) => (
              <div
                key={container.containerKey}
                className="grid gap-2 border-t border-line px-3 py-2.5 text-[13px] text-dim hover:bg-raised md:grid-cols-[minmax(140px,1fr)_minmax(160px,1.25fr)_0.7fr_0.7fr_0.8fr_0.6fr] md:items-center"
                title={container.status}
              >
                <span className="min-w-0 truncate text-text">
                  {container.name}
                </span>
                <span className="min-w-0 truncate" title={container.image}>
                  {container.image}
                </span>
                <span className="capitalize">{container.state}</span>
                <span className="tnum">{container.cpuPercent.toFixed(1)}%</span>
                <span className="tnum">
                  {formatDockerBytes(container.memoryUsageBytes)}
                </span>
                <span className="tnum">{container.pids}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-[13px] text-dim">
          No containers reported by this agent.
        </p>
      )}
    </article>
  );
}

function DockerStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="border border-line bg-raised px-2 py-1">
      <span className="text-dim">{label}</span>{" "}
      <span className="tnum">{value}</span>
    </span>
  );
}

function maxMetric(
  metrics: DashboardOverview["metrics"],
  key: "cpu" | "memory" | "disk",
) {
  return metrics.length
    ? [...metrics].sort((a, b) => b[key] - a[key])[0]
    : null;
}

function MetricServerCard({
  metric,
  focus,
}: {
  metric: DashboardOverview["metrics"][number];
  focus: string;
}) {
  const stale = metric.freshness === "stale";
  const warnings = [
    metric.cpu >= 85 ? "High CPU" : null,
    metric.memory >= 80 ? "Memory pressure" : null,
    metric.disk >= 85 ? "Disk near limit" : null,
    stale ? "Stale telemetry" : null,
  ].filter(Boolean);
  return (
    <article className="grid min-w-0 gap-3 border border-line bg-panel p-4 xl:grid-cols-[minmax(220px,1fr)_minmax(360px,1.4fr)_auto] xl:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="truncate text-lg font-medium text-text">
            {metric.vpsId}
          </strong>
          <Badge className="uppercase" variant={chipVariant(metric.freshness)}>
            {metric.freshness}
          </Badge>
        </div>
        <p className="mt-1 text-[12px] text-dim">
          Collected {freshnessLabel(metric.collectedAt)} · Uptime{" "}
          {formatUptime(metric.uptime)}
        </p>
        {warnings.length ? (
          <p className="tnum mt-2 text-[11px] uppercase tracking-[0.08em] text-warn">
            {warnings.join(" · ")}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <MetricMeter
          label="CPU"
          value={metric.cpu}
          display={`${metric.cpu}%`}
          hot={metric.cpu >= 85 || focus === "cpu"}
        />
        <MetricMeter
          label="RAM"
          value={metric.memory}
          display={`${metric.memory}%`}
          hot={metric.memory >= 80 || focus === "memory"}
        />
        <MetricMeter
          label="Disk"
          value={metric.disk}
          display={`${metric.disk}%`}
          hot={metric.disk >= 85 || focus === "disk"}
        />
        <MetricMeter
          label="Load"
          value={Math.min(100, metric.loadAverage * 25)}
          display={String(metric.loadAverage)}
          hot={focus === "load"}
        />
        <MetricMeter
          label="Net"
          value={null}
          display={`${formatBytes(metric.networkRx)}/${formatBytes(metric.networkTx)}`}
          hot={focus === "network"}
        />
      </div>
      <div className="flex flex-wrap gap-2 xl:justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 border-line px-3 text-[12px] font-medium"
          disabled
          title="Coming soon"
        >
          View details
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 border-line px-3 text-[12px] font-medium"
          disabled
          title="Coming soon"
        >
          Open server
        </Button>
      </div>
    </article>
  );
}

function MetricMeter({
  label,
  value,
  display,
  hot = false,
}: {
  label: string;
  value: number | null;
  display: string;
  hot?: boolean;
}) {
  const tone = value === null ? "ok" : loadTone(value);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between text-[12px]">
        <span className={hot ? "text-text" : "text-dim"}>{label}</span>
        <span className={`tnum ${toneText[tone]}`} title={display}>
          {display}
        </span>
      </div>
      <div
        className="mt-1.5 h-1 bg-line"
        role="progressbar"
        aria-label={label}
        aria-valuenow={value === null ? undefined : Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full ${value === null ? "bg-info" : tone === "ok" ? "bg-signal" : tone === "warn" ? "bg-warn" : "bg-crit"}`}
          style={{
            width: `${value === null ? 100 : Math.min(100, Math.max(0, value))}%`,
            opacity: value === null ? 0.55 : 1,
          }}
        />
      </div>
    </div>
  );
}

function buildMetricAlerts(metrics: DashboardOverview["metrics"]) {
  return metrics.flatMap(
    (metric) =>
      [
        metric.freshness === "stale"
          ? {
              vpsId: metric.vpsId,
              severity: "stale",
              message: "Telemetry is stale",
              time: freshnessLabel(metric.collectedAt),
            }
          : null,
        metric.memory >= 80
          ? {
              vpsId: metric.vpsId,
              severity: "critical",
              message: `Memory pressure at ${metric.memory}%`,
              time: freshnessLabel(metric.collectedAt),
            }
          : metric.memory >= 75
            ? {
                vpsId: metric.vpsId,
                severity: "warning",
                message: `Memory nearing threshold at ${metric.memory}%`,
                time: freshnessLabel(metric.collectedAt),
              }
            : null,
        metric.disk >= 85
          ? {
              vpsId: metric.vpsId,
              severity: "critical",
              message: `Disk near limit at ${metric.disk}%`,
              time: freshnessLabel(metric.collectedAt),
            }
          : metric.disk >= 75
            ? {
                vpsId: metric.vpsId,
                severity: "warning",
                message: `Disk usage warning at ${metric.disk}%`,
                time: freshnessLabel(metric.collectedAt),
              }
            : null,
        metric.cpu >= 85
          ? {
              vpsId: metric.vpsId,
              severity: "critical",
              message: `High CPU at ${metric.cpu}%`,
              time: freshnessLabel(metric.collectedAt),
            }
          : null,
      ].filter(Boolean) as Array<{
        vpsId: string;
        severity: "warning" | "stale" | "critical";
        message: string;
        time: string;
      }>,
  );
}
