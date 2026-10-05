# Changelog

## Unreleased — Docker ingest replay recovery

- Use receive-time-independent ingest digests so retained agent batches can retry after a lost acknowledgment.
- Authenticate previously committed digest-v1 batches using their original ledger receipt time, identity, sequence, and committed watermark; changed bound payloads remain conflicts. No database migration or agent checkpoint reset is required.

## Unreleased — host metric charts

- Project bounded per-VPS CPU, memory, RX, and TX history into metrics, dashboard, and live monitoring responses.
- Standardize Go and local Linux network collectors on explicit bytes-per-second rates; mark first samples and counter resets unavailable rather than plotting false zero/spikes.
- Persist network units and availability in JSON and PostgreSQL (migration `022_metric_network_fields.sql`).
- Connect overview and metrics charts to timestamped same-host history, with separate RX/TX series, gap handling, and unit-aware readouts.
- Handle bounded SSE snapshots containing `refreshRequired` by reloading dashboard data over HTTP instead of dereferencing an absent overview and crashing after login.

## Unreleased — reference dashboard design

- Restyle FlexServer using the supplied VPS Management Dashboard reference: ink/lime palette, compact header, square panels, fleet cards/table, and workspace tabs.
- Align overview, metrics, Docker monitoring, jobs, audit, terminal, settings, forms, and overlays with shared design tokens while retaining API-backed controls and access restrictions.
- Keep missing telemetry explicit instead of presenting unrelated metric history as memory or network data.

## Unreleased — CI/CD optimization

- Scope PR checks through a lightweight change-detection job; keep the full verification matrix on main and honor manual force-build inputs.
- Run database integrations alongside verification, generate SBOMs only for publishable main runs, and avoid redundant standalone Node/Go builds.
- Transfer checksummed, verified Docker images to publish without rebuilding; verify loaded image identities and deploy the pushed digest references.
- Fix fail-fast migration asset smoke checks and grant change detection the pull-request read permission it requires.

## Unreleased — local agent upgrade

- Add signed, immutable agent/updater release manifests with pinned Ed25519 verification, a stable-channel catalog, build IDs, and compatibility checks.
- Add a separately installed, pull-only host updater with scoped credentials, a constrained privileged helper, durable journal, lease/fencing, signed-artifact verification, rollback, and backup retention when recovery is unverified.
- Add persistent local-upgrade jobs for JSON and PostgreSQL, admin confirmation and audit, idempotent outcomes, and fresh-heartbeat verification before success or verified rollback.
- Show installed build, release availability, updater health, manual instructions, confirmation, durable progress, and recovery guidance in local VPS card, table, and workspace views. Remote SSH upgrades remain separate.
- Harden installer signature gates, updater credential rotation, post-swap failure handling, filesystem boundaries, and confirmation-dialog focus restoration.

Production rollout is **not yet verified**. Complete the disposable Linux staging and fault-injection gate in `docs/local-agent-upgrade-operations.md`, publish a signed release matching the final commit, then perform an authorized production canary. API/web deployment alone does not replace the host agent.
