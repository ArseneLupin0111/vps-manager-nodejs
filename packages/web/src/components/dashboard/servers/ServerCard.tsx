import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  Clock3,
  DownloadCloud,
  Edit3,
  Eye,
  EyeOff,
  KeyRound,
  MapPin,
  MoreHorizontal,
  RotateCw,
  Server,
  ServerCog,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "../../ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import {
  formatDate,
  freshnessLabel,
  serverStatusLabel,
  vpsDisplayName,
  vpsHostId,
} from "../../../lib/dashboard-formatters";
import type { DashboardOverview, VpsRecord } from "../../../lib/api";
import { formatUptime } from "../shared/formatUptime";
import { formatBytes } from "./helpers";
import { DockerMetricsPanel } from "./DockerMetricsPanel";
import { AgentLifecycleStatus, agentJobFor } from "./AgentLifecycleStatus";
import { LocalAgentUpdate } from "./LocalAgentUpdate";

// ── ServerCard ───────────────────────────────────────────────────────

export function ServerCard({
  vps,
  metric,
  systemInfo,
  dockerMetrics,
  jobs,
  busy,
  password,
  onPasswordChange,
  onProvision,
  onVerify,
  onInstallAgent,
  onUninstallAgent,
  onUpgradeAgent,
  onRestartAgent,
  onRotateAgent,
  onToggleDockerMetrics,
  onDelete,
  mode,
  onEdit,
}: {
  vps: VpsRecord;
  metric?: DashboardOverview["metrics"][number];
  systemInfo?: DashboardOverview["systemInfo"][number];
  dockerMetrics?: DashboardOverview["dockerMetrics"][number];
  jobs: DashboardOverview["jobs"];
  busy: boolean;
  password: string;
  onPasswordChange: (id: string, value: string) => void;
  onProvision: (vps: VpsRecord) => void;
  onVerify: (vps: VpsRecord) => void;
  onInstallAgent: (vps: VpsRecord) => void;
  onUninstallAgent: (vps: VpsRecord) => void;
  onUpgradeAgent: (vps: VpsRecord) => void;
  onRestartAgent: (vps: VpsRecord) => void;
  onRotateAgent: (vps: VpsRecord) => void;
  onToggleDockerMetrics: (vps: VpsRecord) => void;
  onDelete: (vps: VpsRecord) => void;
  mode: "demo" | "local";
  onEdit: (vps: VpsRecord) => void;
}) {
  const isLocalHost = vps.kind === "local" || vps.managedBy === "system";
  const isReady = isLocalHost || Boolean(vps.keyProvisionedAt);
  const isDown = vps.status === "unreachable";
  const [showPassword, setShowPassword] = useState(false);
  const [addressHidden, setAddressHidden] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<VpsRecord | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<VpsRecord | null>(null);
  const [upgradeTarget, setUpgradeTarget] = useState<VpsRecord | null>(null);
  const [restartTarget, setRestartTarget] = useState<VpsRecord | null>(null);
  const [rotateAgentTarget, setRotateAgentTarget] = useState<VpsRecord | null>(null);
  const displayName = vpsDisplayName(vps);
  const hostId = vpsHostId(vps);
  const osLabel =
    systemInfo?.os?.prettyName ||
    systemInfo?.os?.name ||
    systemInfo?.os?.family ||
    "OS not reported";
  const agentJob = agentJobFor(vps, jobs);
  const agentActionRunning = Boolean(
    agentJob && (agentJob.status === "queued" || agentJob.status === "running"),
  );
  const showInstall =
    !agentActionRunning &&
    vps.agentStatus !== "online" &&
    vps.agentStatus !== "offline";
  const canUpgrade = mode !== "demo" && !isLocalHost && !agentActionRunning &&
    (vps.agentStatus === "online" || vps.agentStatus === "offline" || vps.agentStatus === "failed");
  const canRestart = mode !== "demo" && !isLocalHost && isReady && !agentActionRunning &&
    (vps.agentStatus === "offline" || vps.agentStatus === "failed");
  const canRotateAgent = mode !== "demo" && isLocalHost && !agentActionRunning;

  const handlePasswordKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = password.trim();
      if (!trimmed) {
        setPasswordError("Password cannot be empty");
        return;
      }
      setPasswordError("");
      setConfirmOpen(true);
    }
  };

  return (
    <article
      aria-label={`Server ${displayName}`}
      className={`min-w-0 overflow-hidden rounded-none border bg-white/[0.03] shadow-none transition duration-300 ${isDown ? "border-white/20 ring-1 ring-white/10" : "border-white/10 hover:border-white/20"}`}
    >
      <header className="min-w-0 border-b border-white/10 bg-gradient-to-r from-white/[0.035] to-transparent px-3 py-4 sm:px-4 sm:py-5">
        <div className="flex min-w-0 items-start justify-between gap-3 sm:gap-5">
          <h3 className="min-w-0 break-words text-xl font-semibold leading-tight tracking-[-0.02em] text-white sm:text-2xl">
            {displayName}
          </h3>
          <ServerHealthStatus status={vps.status} />
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-white/60 sm:text-sm">
          <span
            className="inline-block min-w-[12rem] font-mono text-white/75"
            aria-label={addressHidden ? "Server address hidden" : `Server address ${vps.host}:${vps.port}`}
          >
            {addressHidden ? "••••••••••••:••••" : `${vps.host}:${vps.port}`}
          </span>
          <button
            type="button"
            className="inline-grid h-8 w-8 shrink-0 place-items-center border border-white/10 bg-white/[0.025] text-white/55 transition hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            aria-label={addressHidden ? "Show server address" : "Hide server address"}
            aria-pressed={addressHidden}
            title={addressHidden ? "Show server address" : "Hide server address"}
            onClick={() => setAddressHidden((hidden) => !hidden)}
          >
            {addressHidden ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
          </button>
          <span className="text-white/25" aria-hidden="true">
            ·
          </span>
          <span className="min-w-0 truncate">{osLabel}</span>
        </div>
        {hostId ? <p className="mt-1 break-all font-mono text-[10px] text-white/35">Host ID: {hostId}</p> : null}
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-white/40 sm:text-xs">
          <Clock3 size={13} aria-hidden="true" />
          <span>Seen {formatDate(vps.lastSeenAt)}</span>
        </div>
      </header>

      <div className="grid min-w-0 divide-y divide-white/10 md:grid-cols-3 md:divide-x md:divide-y-0">
        <ServerSystemInfoStrip vps={vps} systemInfo={systemInfo} />
        <ServerMetricStrip metric={metric} />
        <div className="min-w-0 p-3 sm:p-4">
          <DockerMetricsPanel
            vps={vps}
            dockerMetrics={dockerMetrics}
            busy={busy}
            onToggle={onToggleDockerMetrics}
          />
        </div>
      </div>

      <footer className="border-t border-white/10 px-3 py-3 sm:px-4">
        <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <ServerRuntimeMeta
            vps={vps}
            metric={metric}
            systemInfo={systemInfo}
            jobs={jobs}
          />
          <div className="flex min-w-0 flex-wrap items-center gap-2 xl:justify-end">
          <Button asChild type="button" size="sm" variant="default">
            <Link
              to={`/vps/${encodeURIComponent(vps.id)}`}
              aria-label={`Manage ${displayName}`}
            >
              <Server size={16} />
              <span>Manage</span>
            </Link>
          </Button>
          {isLocalHost ? (
            <span className="inline-flex h-9 items-center gap-2 px-2 text-sm text-white/50">
              <Activity size={16} aria-hidden="true" />
              Managed locally
            </span>
          ) : isReady ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onVerify(vps)}
              >
                <ShieldCheck size={16} />
                Verify access
              </Button>
              {showInstall ? <Button
                type="button"
                size="sm"
                variant="default"
                disabled={busy}
                onClick={() => onInstallAgent(vps)}
              >
                <DownloadCloud size={16} />
                {vps.agentStatus === "failed" ? "Retry install" : "Install agent"}
              </Button> : null}
            </>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setShowPassword((value) => !value)}
              >
                <KeyRound size={16} />
                Install key
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onVerify(vps)}
              >
                <ShieldCheck size={16} />
                Verify access
              </Button>
            </>
          )}
          <ServerOverflow
            vps={vps}
            busy={busy}
            isLocalHost={isLocalHost}
            onRotate={() => setShowPassword(true)}
            canUpgrade={canUpgrade}
            canRestart={canRestart}
            canRotateAgent={canRotateAgent}
            onRequestUpgrade={() => {
              window.setTimeout(() => setUpgradeTarget(vps), 0);
            }}
            onRequestRestart={() => window.setTimeout(() => setRestartTarget(vps), 0)}
            onRequestRotateAgent={() => window.setTimeout(() => setRotateAgentTarget(vps), 0)}
            onRequestUninstall={() => {
              window.setTimeout(() => setUninstallTarget(vps), 0);
            }}
            onRequestDelete={() => {
              window.setTimeout(() => setDeleteTarget(vps), 0);
            }}
            mode={mode}
            onEdit={() => window.setTimeout(() => onEdit(vps), 0)}
          />
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-1 text-xs xl:order-first xl:grid-cols-1">
            <div className="flex items-center gap-2"><span className="text-white/40">Agent</span><AgentLifecycleStatus vps={vps} jobs={jobs} compact /></div>
            <div className="flex items-center gap-2"><span className="text-white/40">Access</span><span className={isReady ? "text-emerald-300" : "text-amber-300"}>{isLocalHost ? "Local" : isReady ? "Key ready" : "Needs password"}</span></div>
            {isLocalHost ? <LocalAgentUpdate vps={vps} variant="card" /> : null}
          </div>
        </div>
      </footer>
      {/* Delete confirmation – rendered outside DropdownMenu to avoid focus-trap nesting */}
      <AlertDialog
        open={deleteTarget?.id === vps.id}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the server record for {vps.username}@
              {vps.host}:{vps.port}. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                onDelete(vps);
              }}
            >
              Delete server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={restartTarget?.id === vps.id} onOpenChange={(open) => { if (!open) setRestartTarget(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Restart agent on {displayName}?</AlertDialogTitle><AlertDialogDescription>This restarts the monitoring agent only. It does not reboot the VPS.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => { if (!busy) onRestartAgent(vps); setRestartTarget(null); }}>Restart agent</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={rotateAgentTarget?.id === vps.id} onOpenChange={(open) => { if (!open) setRotateAgentTarget(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Rotate agent credential on {displayName}?</AlertDialogTitle><AlertDialogDescription>The agent credential is replaced without exposing the token. The agent reconnects automatically.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => { if (!busy) onRotateAgent(vps); setRotateAgentTarget(null); }}>Rotate credential</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      {/* Uninstall confirmation – outside DropdownMenu so focus is restored cleanly */}
      <AlertDialog open={upgradeTarget?.id === vps.id} onOpenChange={(open) => { if (!open) setUpgradeTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Upgrade agent on {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>Monitoring will pause briefly while the agent is upgraded. If the upgrade cannot complete, the previous version is restored automatically. Existing credentials are preserved and are not changed or stored again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { onUpgradeAgent(vps); setUpgradeTarget(null); }}>Upgrade agent</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={uninstallTarget?.id === vps.id}
        onOpenChange={(open) => {
          if (!open) setUninstallTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall agent from {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Monitoring from this agent will stop. The server record and SSH access stay in place.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                onUninstallAgent(vps);
                setUninstallTarget(null);
              }}
            >
              Uninstall agent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {showPassword && !isLocalHost ? (
        <form
          onSubmit={(event) => event.preventDefault()}
          autoComplete="off"
          className="grid gap-2 border-t border-white/10 bg-white/[0.02] px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-4"
        >
          <Label>
            {isReady ? "One-time password for rotation" : "One-time password"}
            <Input
              type="password"
              maxLength={4096}
              autoComplete="new-password"
              placeholder="Used once to install or rotate the key"
              value={password}
              onChange={(event) => {
                onPasswordChange(vps.id, event.target.value);
                if (passwordError) setPasswordError("");
              }}
              onKeyDown={handlePasswordKeyDown}
            />
            {passwordError ? (
              <p className="mt-1 text-xs font-normal text-white/50">
                {passwordError}
              </p>
            ) : null}
          </Label>
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                disabled={busy || !password.trim()}
                className="self-end rounded-none"
              >
                <KeyRound size={16} />
                {isReady ? "Rotate key" : "Install key"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {isReady ? "Rotate SSH key?" : "Install SSH key?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This will connect to {displayName} and update authorized SSH
                  access using the one-time password. The password will not be
                  stored.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    onProvision(vps);
                  }}
                >
                  {isReady ? "Rotate key" : "Install key"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </form>
      ) : null}
    </article>
  );
}

function ServerHealthStatus({ status }: { status?: VpsRecord["status"] }) {
  const isDown = status === "unreachable";
  const label = serverStatusLabel(status);
  const dotColor =
    status === "healthy"
      ? "bg-emerald-400"
      : status === "warning"
        ? "bg-amber-400"
        : status === "unreachable"
          ? "bg-red-400"
          : "bg-white/40";
  const textColor = isDown ? "text-red-200" : "text-white/70";

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 border border-white/10 bg-white/[0.035] px-2 py-1 text-xs font-medium sm:text-sm ${textColor}`}
      aria-label={`Host status: ${label}`}
      title={`Host status: ${label}`}
    >
      <span className={`h-2 w-2 rounded-full ${dotColor}`} aria-hidden="true" />
      <span aria-hidden="true">{label}</span>
    </span>
  );
}

// ── ServerRuntimeMeta ────────────────────────────────────────────────

function ServerRuntimeMeta({
  vps,
  metric,
  systemInfo,
  jobs,
}: {
  vps: VpsRecord;
  metric?: DashboardOverview["metrics"][number];
  systemInfo?: DashboardOverview["systemInfo"][number];
  jobs: DashboardOverview["jobs"];
}) {
  const runningJobs = jobs.filter((job) => job.status === "running").length;
  const parts = [
    systemInfo?.agentVersion ? `Agent ${systemInfo.agentVersion}` : null,
    metric ? `Uptime ${formatUptime(metric.uptime)}` : null,
    metric ? `Last check ${freshnessLabel(metric.collectedAt)}` : null,
    `${runningJobs} running job${runningJobs === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return (
    <div className="min-w-0 text-xs font-normal leading-5 text-white/50">
      <p className="whitespace-normal" title={parts.join(" / ")}>
        {parts.join(" · ")}
      </p>
      <p
        className="mt-0.5 break-all font-mono text-[10px] leading-4 text-white/30"
        title={`Server ID: ${vps.id} · SSH user: ${vps.username}`}
      >
        ID {vps.id} · SSH {vps.username}
      </p>
    </div>
  );
}

// ── ServerSystemInfoStrip ────────────────────────────────────────────

function ServerSystemInfoStrip({
  vps,
  systemInfo,
}: {
  vps: VpsRecord;
  systemInfo?: DashboardOverview["systemInfo"][number];
}) {
  if (!systemInfo) {
    return (
      <section className="min-w-0 p-3 sm:p-4" aria-label="System information">
        <SectionLabel>System</SectionLabel>
        <p className="mt-2 text-xs font-normal text-white/40">
          System info not reported yet.
        </p>
        <ServerLocationMeta vps={vps} />
        <ServerAnnotations vps={vps} />
      </section>
    );
  }

  const osLabel =
    systemInfo.os?.prettyName ||
    systemInfo.os?.name ||
    systemInfo.os?.family ||
    "OS n/a";
  const kernelParts = [
    systemInfo.kernel?.release,
    systemInfo.kernel?.arch,
  ].filter(Boolean);
  const cpuLabel =
    [
      systemInfo.cpu?.cores ? `${systemInfo.cpu.cores} cores` : null,
      systemInfo.cpu?.model,
    ]
      .filter(Boolean)
      .join(" · ") || "CPU n/a";
  const memoryLabel = systemInfo.memory?.totalBytes
    ? `${formatBytes(systemInfo.memory.totalBytes)} RAM`
    : "RAM n/a";
  const diskLabel = systemInfo.rootDisk?.totalBytes
    ? `${formatBytes(systemInfo.rootDisk.totalBytes)} disk${systemInfo.rootDisk.fsType ? ` · ${systemInfo.rootDisk.fsType}` : ""}`
    : "Disk n/a";

  return (
    <section className="min-w-0 p-3 sm:p-4" aria-label="System information">
      <SectionLabel>System</SectionLabel>
      <p className="mt-2 truncate text-sm font-normal text-white/80" title={osLabel}>
        {osLabel}
      </p>
      <div className="mt-1 grid gap-0.5 text-xs leading-5 text-white/50">
        <p className="truncate" title={kernelParts.join(" · ") || undefined}>
          {kernelParts.length ? kernelParts.join(" · ") : "Kernel n/a"}
        </p>
        <p className="truncate" title={cpuLabel}>{cpuLabel}</p>
        <p className="truncate" title={`${memoryLabel} · ${diskLabel}`}>
          {memoryLabel} · {diskLabel}
        </p>
      </div>
      <ServerLocationMeta vps={vps} />
      <ServerAnnotations vps={vps} />
    </section>
  );
}

function ServerLocationMeta({ vps }: { vps: VpsRecord }) {
  const location = [vps.city, vps.country].filter(Boolean).join(", ") || "Location not detected";
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-white/40">
      <span className="inline-flex min-w-0 items-center gap-1">
        <ServerCog size={12} aria-hidden="true" />
        <span className="truncate">{vps.provider || "Provider not set"}</span>
      </span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex min-w-0 items-center gap-1">
        <MapPin size={12} aria-hidden="true" />
        <span className="truncate text-white/65" title={location}>{location}</span>
      </span>
    </div>
  );
}

function ServerAnnotations({ vps }: { vps: VpsRecord }) {
  return (
    <>
      {vps.tags?.length ? (
        <p
          className="mt-2 truncate text-[11px] text-white/40"
          title={`Tags: ${vps.tags.join(", ")}`}
        >
          Tags · {vps.tags.join(", ")}
        </p>
      ) : null}
      {vps.notes ? (
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-white/50">
          {vps.notes}
        </p>
      ) : null}
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-normal uppercase tracking-[0.14em] text-white/50">
      {children}
    </p>
  );
}

// ── ServerMetricStrip ────────────────────────────────────────────────

function ServerMetricStrip({
  metric,
}: {
  metric?: DashboardOverview["metrics"][number];
}) {
  const base = "flex items-baseline justify-between gap-3 text-xs text-white/70";
  return (
    <section className="min-w-0 p-3 sm:p-4" aria-label="Resource usage">
      <SectionLabel>Resources</SectionLabel>
      <div className="mt-2 grid gap-2.5">
        <TelemetryMeter label="CPU" value={metric?.cpu} />
        <TelemetryMeter label="RAM" value={metric?.memory} />
        <TelemetryMeter label="Disk" value={metric?.disk} />
        <p className={base}>
          <span className="text-white/50">Load</span>
          <span>{metric ? metric.loadAverage : "n/a"}</span>
        </p>
      </div>
    </section>
  );
}

function TelemetryMeter({ label, value }: { label: string; value?: number }) {
  const hasValue = typeof value === "number" && Number.isFinite(value);
  const normalizedValue = hasValue ? Math.min(100, Math.max(0, value)) : 0;
  const meterColor = !hasValue
    ? "bg-white/20"
    : value >= 90
      ? "bg-red-500"
      : value >= 70
        ? "bg-amber-400"
        : "bg-emerald-500";

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-white/50">{label}</span>
        <span className="text-white/70">{hasValue ? `${value}%` : "n/a"}</span>
      </div>
      {hasValue ? (
        <div
          role="progressbar"
          aria-label={`${label} utilization`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={normalizedValue}
          className="mt-1.5 h-1 w-full overflow-hidden bg-white/10"
        >
          <div
            className={`h-full ${meterColor} transition-[width] duration-300`}
            style={{ width: `${normalizedValue}%` }}
          />
        </div>
      ) : (
        <div className="mt-1.5 h-1 w-full bg-white/10" aria-hidden="true" />
      )}
    </div>
  );
}

// ── ServerOverflow ───────────────────────────────────────────────────

function ServerOverflow({
  vps,
  busy,
  isLocalHost,
  onRotate,
  canUpgrade,
  canRestart,
  canRotateAgent,
  onRequestUpgrade,
  onRequestRestart,
  onRequestRotateAgent,
  onRequestUninstall,
  onRequestDelete,
  mode,
  onEdit,
}: {
  vps: VpsRecord;
  busy: boolean;
  isLocalHost: boolean;
  onRotate: () => void;
  canUpgrade: boolean;
  canRestart: boolean;
  canRotateAgent: boolean;
  onRequestUpgrade: () => void;
  onRequestRestart: () => void;
  onRequestRotateAgent: () => void;
  onRequestUninstall: () => void;
  onRequestDelete: () => void;
  mode: "demo" | "local";
  onEdit: () => void;
}) {
  const displayName = vpsDisplayName(vps);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`More actions for ${displayName}`}
        >
          <MoreHorizontal size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48 rounded-none">
        {isLocalHost ? null : (
          <DropdownMenuItem disabled={busy || !canUpgrade} onClick={onRequestUpgrade}>
            <RotateCw size={15} />
            Upgrade agent
          </DropdownMenuItem>
        )}
        {canRestart ? <DropdownMenuItem disabled={busy} onClick={onRequestRestart}><RotateCw size={15} />Restart agent</DropdownMenuItem> : null}
        {isLocalHost ? <DropdownMenuItem disabled={busy || !canRotateAgent} onClick={onRequestRotateAgent}><KeyRound size={15} />Rotate agent credential</DropdownMenuItem> : null}
        <DropdownMenuItem onClick={onRotate} disabled={busy || isLocalHost}>
          <KeyRound size={15} />
          Reinstall SSH key
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={busy || isLocalHost || mode === "demo"}
          onClick={onEdit}
          title={mode === "demo" ? "Editing is unavailable in demo mode." : isLocalHost ? "Local servers are managed by the system." : undefined}
          aria-label={`Edit server${mode === "demo" ? ": unavailable in demo mode" : isLocalHost ? ": local servers are system managed" : ""}`}
        >
          <Edit3 size={15} />
          Edit server
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          disabled={busy || isLocalHost}
          onClick={onRequestDelete}
        >
          <Trash2 size={15} />
          Remove server
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
