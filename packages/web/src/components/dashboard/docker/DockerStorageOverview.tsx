import type { DockerStorageLatest } from "../../../lib/api";
import { formatBytes } from "../servers/helpers";
import { EmptyState } from "../shared/EmptyState";

/** Docker-managed storage overview (never host free space). Read-only. */
export function DockerStorageOverview({
  storage,
  loading,
  error,
}: {
  storage: DockerStorageLatest | null;
  loading: boolean;
  error?: string | null;
}) {
  if (loading) {
    return (
      <section aria-label="Docker storage" aria-busy="true" className="border border-line bg-panel p-4">
        <p className="text-[12px] text-dim">Loading Docker-managed storage…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section aria-label="Docker storage" className="border border-line bg-panel p-4">
        <p className="text-[12px] text-text">Docker-managed storage is unavailable right now.</p>
        <p className="mt-1 text-[11px] text-dim">{error}</p>
      </section>
    );
  }
  if (!storage) {
    return (
      <section aria-label="Docker storage" className="border border-line bg-panel">
        <header className="border-b border-line px-4 py-3">
          <h3 className="text-[14px] font-semibold">Docker-managed storage</h3>
        </header>
        <div className="p-4">
          <EmptyState>
            No Docker-managed storage reported yet. This section covers Docker-managed images, containers, volumes, and build cache — never host free space.
          </EmptyState>
        </div>
      </section>
    );
  }

  const rows = [
    { label: "Images", value: storage.images },
    { label: "Containers", value: storage.containers },
    { label: "Local volumes", value: storage.localVolumes },
    { label: "Build cache", value: storage.buildCache },
  ];

  return (
    <section aria-label="Docker storage" className="border border-line bg-panel">
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-[14px] font-semibold">Docker-managed storage</h3>
        <p className="mt-0.5 text-[12px] text-dim">
          Docker-managed usage only — never host free space. Reported {new Date(storage.collectedAt).toLocaleString()}.
        </p>
      </header>
      <dl className="grid gap-2 p-4 sm:grid-cols-2">
        {rows.map(({ label, value }) => (
          <div key={label} className="border border-line bg-raised px-3 py-2 text-[12px]">
            <dt className="text-[11px] uppercase tracking-[0.14em] text-dim">{label}</dt>
            <dd className="tnum mt-0.5 text-text">
              {value.supported ? `${value.count} · ${formatBytes(value.totalBytes)}` : "Not reported by this agent"}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
