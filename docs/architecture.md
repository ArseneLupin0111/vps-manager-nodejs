# Architecture

This repository is an npm workspaces monorepo with a NestJS API and Vite React dashboard.

## Runtime Shape

The backend starts from `packages/api/src/server.ts`, creates an Express server, mounts request ID middleware, Helmet, mutation rate limiting, static serving from root `public/`, and then attaches NestJS through an Express adapter.

`packages/api/src/app.module.ts` wires controllers and services with dependency injection. The current portfolio MVP keeps JSON persistence behind repository interfaces so SQLite can replace it later without changing controllers.

## Backend Modules

- Config: parses `APP_MODE`, `DASHBOARD_SESSION_SECRET`, terminal flags, private-network flags, and storage directories.
- VPS: stores local VPS metadata in `data/vps.json` and preserves the existing CRUD/provision/verify API.
- SSH: wraps real `ssh2` helpers with demo-mode and host-policy gates.
- Dashboard: exposes `GET /api/dashboard` with demo overview data, jobs, metrics, audit, terminal, and settings.
- Audit, Jobs, Metrics: JSON-backed primitives for portfolio MVP operational depth.

## Frontend

`packages/web` is a Vite React app using local shadcn-style primitives and Tailwind tokens. The dashboard renders a single page with section anchors for Overview, Servers, Jobs, Metrics, Terminal, Audit Log, and Settings.

## Persistence

The MVP uses JSON files under `data/` and key material under `private/`. JSON writes use atomic temp-file replacement and private file modes. `data/` and `private/` are not statically served.

## Deployment

`Dockerfile` builds web assets into `public/`, compiles the API into `dist/`, runs as a non-root user, exposes port 3000, and checks `/api/health`. `docker-compose.yml` starts demo mode with writable volumes for `/app/data` and `/app/private`.

## Docker Management

Docker monitoring remains read-only and can be enabled independently from `dockerManagementEnabled`, which defaults to `false`. Dashboard mutations are limited to confirmed `start`, `stop`, and `restart` actions scoped to a VPS, agent instance, and opaque container key. The API stores bounded operation state in the configured JSON or PostgreSQL repository and never opens the Docker socket.

The agent owns Docker socket access. Its independent command worker claims authenticated operations, records bounded receipts, enforces deadlines and target identity, and reports uncertain outcomes without replaying a mutation. Container logs are manually requested, bounded, text-only, and held only in memory; they are not written to jobs, audit, SSE, or persistent storage.

Deploy an agent containing the command worker before enabling Docker management for a VPS. Management capability and target discovery remain available when Docker monitoring is disabled; monitoring data itself is still controlled by `dockerMetricsEnabled`.

Docker monitoring accepts only schema v2 snapshots with durable agent identity and source sequence. Deploy the API migration and provisioned v2 agent before relying on Docker history or dashboard snapshots; old v1 rows are not projected or backfilled. Verify a fresh `docker_metric_samples` row with a non-legacy `agent_instance_id`, advancing `docker_ingest_latest.source_sequence`, and a committed `docker_event_watermarks` row. Host metrics and API health alone do not prove Docker v2 ingestion.

Docker ingest digest v2 excludes server receipt timestamps from mapped container samples and events, and binds the event protocol and availability/version metadata. Identical retransmissions return the original committed acknowledgment without advancing history twice. Legacy digest-v1 commits are authenticated by recomputing the original projection at the stored receipt time and checking ledger identity, sequence, and proposed watermark. Legacy v1 did not bind every metadata field; compatibility does not retroactively strengthen that historical contract. Older JSON ledgers without a stored acknowledgment watermark require matching current watermark evidence; missing or advanced evidence fails closed. Do not clear pending agent state to work around replay conflicts.
