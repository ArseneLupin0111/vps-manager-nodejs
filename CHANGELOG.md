# Changelog

## Unreleased — proxy address security patch

- Override and lock `proxy-addr` to 2.0.8 for Express consumers, fixing CVE-2026-90711 / GHSA-jqcg-44mw-7w3h (client-IP spoofing through short IPv4-mapped IPv6 trust prefixes).
- Keep the fixable-CRITICAL image security gate unchanged; the dependency patch replaces the vulnerable 2.0.7 package reported in the API image.

## Unreleased — Overview operational clarity

- Separate host health, recent job outcomes and container counts; show recent failed-job notices with a Jobs link, while treating non-running containers neutrally with a Docker link.
- Make Overview audit events readable without truncated identifiers or redundant server columns; retain full metadata in the details drawer.
- Increase secondary-text contrast and use explicit binary capacity units across host and Docker views; remove the duplicate Overview byte formatter.
- Show failed-job completion percentage, failure reason and finish time instead of an active progress bar; omit missing worker/duration metadata and replace the developer-facing network hint.
- Compact status cards, let recent jobs size to content, move static system facts below activity, and display the CPU model only once.

## Unreleased — scripts directory layout

- Group operational scripts into `agent/`, `vps/`, `admin/`, and `install/`; retain `ci/`, `release/`, and `tests/`.
- Update npm commands, CI filters, installer download URLs, relative imports, shell checks, and operator instructions to the new paths. npm command names and production `dist/scripts/` paths are unchanged.
- Restore the tracked executable bit on `scripts/install/install-updater.sh` after relocation so Linux bootstrap smoke checks and documented direct invocation do not fail with `Permission denied`.

## Unreleased — Recharts telemetry charts

- Replace custom SVG history charts for CPU/RAM, network RX/TX, and Docker CPU/memory with responsive Recharts components; resource meters remain unchanged.
- Add unit-aware hover and keyboard tooltips, numeric timestamp axes, and readable percentage/throughput/memory labels using the existing dark telemetry palette.
- Preserve missing samples as gaps and real zero values; retain empty/loading/error states, Docker coverage metadata, and single-sample indicators.

## Unreleased — compact agent status

- Reduce fleet cards to agent/access status, a short version, and one update badge; omit repeated labels, heartbeat text, commit hashes, and completed upgrade confirmations from compact card/table summaries.
- Keep active upgrade progress and recovery warnings visible; retain full build identity, heartbeat details, and upgrade history in workspace settings and confirmation dialogs.

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
