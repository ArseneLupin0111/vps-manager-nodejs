import type { DockerHostSample, DockerMetricRollup } from "../../../lib/api";
import { EmptyState } from "../shared/EmptyState";

function metricAt(sample: DockerHostSample, key: string): number | undefined {
  const value = sample.metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pointsFor(samples: DockerHostSample[], key: string) {
  return [...samples]
    .sort((a, b) => +new Date(a.effectiveAt) - +new Date(b.effectiveAt))
    .map((s) => ({ at: s.effectiveAt, value: metricAt(s, key) }))
    .filter((p): p is { at: string; value: number } => p.value !== undefined);
}

/** Bounded host history sparkline (read-only SVG, no controls). */
export function DockerHistoryChart({
  samples,
  rollups,
  retained,
  loading,
  error,
}: {
  samples: DockerHostSample[];
  rollups?: DockerMetricRollup[];
  retained: number;
  loading: boolean;
  error?: string | null;
}) {
  if (loading) {
    return (
      <section aria-label="Docker history" aria-busy="true" className="border border-line bg-panel p-4">
        <p className="text-[12px] text-dim">Loading bounded Docker history…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section aria-label="Docker history" className="border border-line bg-panel p-4">
        <p className="text-[12px] text-text">Docker history is unavailable right now.</p>
        <p className="mt-1 text-[11px] text-dim">{error}</p>
      </section>
    );
  }
  const cpu = pointsFor(samples, "cpuPercent");
  const mem = pointsFor(samples, "memoryUsageBytes");
  const ordered = [...samples].sort((a, b) => +new Date(a.effectiveAt) - +new Date(b.effectiveAt));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const partial = samples.filter((sample) => sample.coverage && !sample.coverage.complete).length;
  const gaps = samples.filter((sample) => sample.coverage && sample.coverage.detailsSampled < sample.coverage.detailsTotalEligible).length;
  if (cpu.length === 0 && mem.length === 0) {
    return (
      <section aria-label="Docker history" className="border border-line bg-panel">
        <header className="border-b border-line px-4 py-3">
          <h3 className="text-[14px] font-semibold">History</h3>
        </header>
        <div className="p-4">
          <EmptyState>
            No Docker history retained yet. Snapshots appear here once the agent reports host samples.
          </EmptyState>
        </div>
      </section>
    );
  }

  const spark = (points: { at: string; value: number }[], label: string) => {
    if (points.length === 0) return <p className="text-[11px] text-dim">No {label} points retained.</p>;
    const max = Math.max(...points.map((p) => p.value), 1);
    const w = 220;
    const h = 44;
    const step = points.length > 1 ? w / (points.length - 1) : 0;
    const d = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - 4 - (p.value / max) * (h - 10)).toFixed(1)}`)
      .join(" ");
    return (
      <figure>
        <figcaption className="text-[11px] text-dim">{label}</figcaption>
        <svg viewBox={`0 0 ${w} ${h}`} className="mt-1 h-11 w-full" role="img" aria-label={`${label} history sparkline`}>
          <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-info" />
        </svg>
      </figure>
    );
  };

  return (
    <section aria-label="Docker history" className="border border-line bg-panel">
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-[14px] font-semibold">History</h3>
        <p className="mt-0.5 text-[12px] text-dim">Raw host samples; {rollups?.length ?? 0} hourly rollups available for longer-range context.</p>
      </header>
      <div className="space-y-2 p-4">
      <p className="text-[12px] text-dim">
        showing {samples.length} loaded raw host samples
      </p>
      <p className="tnum text-[11px] text-dim">
        {first && last ? `${new Date(first.effectiveAt).toLocaleString()} – ${new Date(last.effectiveAt).toLocaleString()}` : "No source range"}
        {partial ? ` · ${partial} partial coverage` : ""}
        {gaps ? ` · ${gaps} samples with reduced detail coverage` : ""}
      </p>
      <div className="grid gap-4 text-text sm:grid-cols-2">
        {spark(cpu, "CPU %")}
        {spark(mem, "Memory bytes")}
      </div>
      </div>
    </section>
  );
}
