import { cn } from "../../../lib/utils";

export function ResourceGauge({ label, value, detail }: { label: string; value?: number; detail: string }) {
  const available = typeof value === "number" && Number.isFinite(value);
  const percent = available ? Math.max(0, Math.min(100, value)) : 0;
  const tone = !available ? "text-dim" : percent >= 85 ? "text-crit" : percent >= 70 ? "text-warn" : "text-signal";
  const bar = percent >= 85 ? "bg-crit" : percent >= 70 ? "bg-warn" : "bg-signal";
  return (
    <section className="min-w-0 bg-[hsl(var(--telemetry-background))] p-4" aria-label={`${label} utilization`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[11px] uppercase tracking-[0.14em] text-dim">{label}</h2>
        <span className="tnum max-w-full truncate text-[11px] text-dim" title={detail}>{detail}</span>
      </div>
      <p className={cn("tnum mt-3 text-4xl font-medium leading-none", tone)}>
        {available ? value.toFixed(1) : "n/a"}{available && <span className="text-lg text-dim">%</span>}
      </p>
      <div className="mt-4 flex h-1.5 gap-px" role={available ? "meter" : undefined} aria-label={`${label} usage`} aria-valuemin={available ? 0 : undefined} aria-valuemax={available ? 100 : undefined} aria-valuenow={available ? percent : undefined}>
        {Array.from({ length: 30 }, (_, index) => <span key={index} className={cn("min-w-0 flex-1", available && index < Math.round(percent * 0.3) ? bar : "bg-line")} />)}
      </div>
    </section>
  );
}
