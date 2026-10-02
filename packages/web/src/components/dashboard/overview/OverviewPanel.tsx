import { Alert } from "../../ui/alert";
import type { DashboardOverview } from "../../../lib/api";
import { formatBytes } from "../shared/formatBytes";
import { AuditPanel } from "../audit/AuditPanel";
import { JobsPanel } from "../jobs/JobsPanel";

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
  const fmtPct = (value?: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? `${value.toFixed(1)}%`
      : "n/a";
  const pctTone = (value?: number): KpiTone =>
    typeof value !== "number" || !Number.isFinite(value)
      ? "idle"
      : value >= 85
        ? "crit"
        : value >= 70
          ? "warn"
          : "ok";

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
    <div className="grid min-w-0 gap-6">
      <DemoBanner overview={overview} />

      {/* Exactly 5 KPIs: status → CPU → RAM → disk → containers */}
      <section
        className="grid min-w-0 grid-cols-5 gap-3 max-[1000px]:grid-cols-2"
        aria-label="Server overview"
      >
        <Kpi
          label="Status"
          value={statusValue}
          sub={server ? (server.provider || "Provider not set") : "No server data"}
          tone={statusTone}
        />
        <Kpi
          label="CPU"
          value={fmtPct(cpuPct)}
          sub={sysInfo?.cpu?.model || "Awaiting snapshot"}
          tone={pctTone(cpuPct)}
        />
        <Kpi
          label="RAM"
          value={fmtPct(ramPct)}
          sub={sysInfo?.memory?.totalBytes ? `${formatBytes(sysInfo.memory.totalBytes)} total` : "Awaiting snapshot"}
          tone={pctTone(ramPct)}
        />
        <Kpi
          label="Disk"
          value={fmtPct(diskPct)}
          sub={sysInfo?.rootDisk?.totalBytes ? `${formatBytes(sysInfo.rootDisk.totalBytes)} total` : "Awaiting snapshot"}
          tone={pctTone(diskPct)}
        />
        <Kpi
          label="Containers"
          value={containersValue}
          sub={docker?.available ? "Running / total" : "Docker snapshot inactive"}
          tone={containersTone}
        />
      </section>

      {/* Audit / jobs split */}
      <div className="grid min-w-0 grid-cols-[1.5fr_1fr] gap-6 max-[1000px]:grid-cols-1">
        <AuditPanel events={overview.auditEvents.slice(0, 5)} compact />
        <JobsPanel jobs={overview.jobs.slice(0, 5)} compact />
      </div>

      {/* System panel, 4 cells */}
      <section
        className="min-w-0 border border-line bg-panel"
        aria-label="System details"
      >
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-[14px] font-semibold">System</h2>
          <p className="mt-0.5 text-[12px] text-dim">
            Reported facts for this server, no estimates.
          </p>
        </div>
        <dl className="grid min-w-0 grid-cols-4 gap-px bg-line max-[1000px]:grid-cols-2">
          {sysCells.map((cell) => (
            <div key={cell.label} className="min-w-0 bg-panel p-4">
              <dt className="truncate text-[11px] uppercase tracking-[0.14em] text-dim">
                {cell.label}
              </dt>
              <dd
                className="tnum mt-1.5 truncate text-[13px] text-text"
                title={cell.value}
              >
                {cell.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
