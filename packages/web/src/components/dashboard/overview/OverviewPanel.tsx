import { Alert } from "../../ui/alert";
import type { DashboardOverview } from "../../../lib/api";
import { formatBytes } from "../shared/formatBytes";
import { AuditPanel } from "../audit/AuditPanel";
import { JobsPanel } from "../jobs/JobsPanel";
import { ResourceGauge } from "../shared/ResourceGauge";
import { SystemFacts } from "../shared/SystemFacts";
import { ChartPanel } from "../metrics/MetricsPanel";

export function DemoBanner({ overview }: { overview: DashboardOverview }) {
  if (!overview.banner) return null;
  return (
    <Alert variant="success" className="mb-0 border-line bg-panel text-text">
      {overview.banner}
    </Alert>
  );
}

type KpiTone = "ok" | "warn" | "crit" | "idle";

function Kpi({
  label,
  value,
  sub,
  tone = "ok",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: KpiTone;
}) {
  const valueTone =
    tone === "crit"
      ? "text-crit"
      : tone === "warn"
        ? "text-warn"
        : tone === "idle"
          ? "text-dim"
          : "text-text";
  return (
    <div className="min-w-0 border border-line bg-panel p-4">
      <p className="truncate text-[11px] uppercase tracking-[0.14em] text-dim">
        {label}
      </p>
      <p
        className={`tnum mt-1.5 truncate text-2xl font-medium ${valueTone}`}
        title={value}
      >
        {value}
      </p>
      <p className="mt-0.5 truncate text-[12px] text-dim" title={sub}>
        {sub}
      </p>
    </div>
  );
}

export function OverviewPanel({ overview }: { overview: DashboardOverview }) {
  const server = overview.servers[0];
  const metric = overview.metrics[0];
  const sysInfo = overview.systemInfo[0];
  const docker = overview.dockerMetrics[0];

  const statusValue = server
    ? server.status === "healthy"
      ? "Healthy"
      : server.status === "warning"
        ? "Warning"
        : server.status === "unreachable"
          ? "Unreachable"
          : "Unknown"
    : "Unknown";
  const statusTone: KpiTone = server
    ? server.status === "healthy"
      ? "ok"
      : server.status === "warning"
        ? "warn"
        : server.status === "unreachable"
          ? "crit"
          : "idle"
    : "idle";

  const cpuPct = metric?.cpu;
  const ramPct = metric?.memory;
  const diskPct = metric?.disk;
  const cpuHistory = overview.metrics.find((sample) => sample.trend?.unit === "cpu") ?? null;
  const memoryHistory = overview.metrics.find((sample) => sample.trend?.unit === "memory") ?? null;

  const containersValue = docker?.available
    ? `${docker.containerRunning}/${docker.containerTotal}`
    : "n/a";
  const containersTone: KpiTone = docker?.available
    ? docker.containerTotal - docker.containerRunning > 0
      ? "warn"
      : "ok"
    : "idle";

  const sysCells = [
    {
      label: "OS",
      value:
        sysInfo?.os?.prettyName ||
        sysInfo?.os?.name ||
        sysInfo?.os?.family ||
        "n/a",
    },
    {
      label: "Kernel",
      value:
        [sysInfo?.kernel?.release, sysInfo?.kernel?.arch]
          .filter(Boolean)
          .join(" ") || "n/a",
    },
    {
      label: "CPU",
      value: sysInfo?.cpu?.model || "n/a",
    },
    {
      label: "Location",
      value:
        [server?.city, server?.country].filter(Boolean).join(", ") ||
        "Location not detected",
    },
  ];

  return (
    <div className="grid min-w-0 gap-4">
      <DemoBanner overview={overview} />
      <section className="grid grid-cols-2 gap-3" aria-label="Server status">
        <Kpi label="Status" value={statusValue} sub={server?.provider || "Provider not set"} tone={statusTone} />
        <Kpi label="Containers" value={containersValue} sub={docker?.available ? "Running / total" : "Docker snapshot inactive"} tone={containersTone} />
      </section>
      <section className="grid min-w-0 gap-px border border-line bg-line md:grid-cols-3" aria-label="Server overview">
        <ResourceGauge label="CPU" value={cpuPct} detail={sysInfo?.cpu?.model || "Awaiting snapshot"} />
        <ResourceGauge label="Memory" value={ramPct} detail={sysInfo?.memory?.totalBytes ? `${formatBytes(sysInfo.memory.totalBytes)} total` : "Awaiting snapshot"} />
        <ResourceGauge label="Disk /" value={diskPct} detail={sysInfo?.rootDisk?.totalBytes ? `${formatBytes(sysInfo.rootDisk.totalBytes)} total` : "Awaiting snapshot"} />
      </section>
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <ChartPanel title="CPU & Memory" hint="Agent-reported utilization history" series={[
          { key: "cpu", name: "CPU", color: "hsl(var(--telemetry-cpu))", metric: cpuHistory },
          { key: "memory", name: "RAM", color: "hsl(var(--telemetry-memory))", metric: memoryHistory },
        ]} />
        <ChartPanel title="Network I/O" hint="Cumulative bytes reported by the agent · not throughput" series={[
          { key: "rx", name: "RX", color: "hsl(var(--telemetry-rx))", metric: null },
          { key: "tx", name: "TX", color: "hsl(var(--telemetry-tx))", metric: null },
        ]} readouts={[
          { label: "RX", value: metric && Number.isFinite(metric.networkRx) ? formatBytes(metric.networkRx) : "n/a" },
          { label: "TX", value: metric && Number.isFinite(metric.networkTx) ? formatBytes(metric.networkTx) : "n/a" },
        ]} />
      </div>
      <SystemFacts facts={sysCells} />

      {/* Audit / jobs split */}
      <div className="grid min-w-0 gap-4 xl:grid-cols-[1.5fr_1fr]">
        <AuditPanel events={overview.auditEvents.slice(0, 5)} compact />
        <JobsPanel jobs={overview.jobs.slice(0, 5)} compact />
      </div>

    </div>
  );
}
