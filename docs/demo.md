# Demo Guide

Demo is a deployment mode, not a separate public route. The published FlexServer instance may run in local mode and require a dashboard password; the landing page does not bypass that gate.

## Start from source

Use Node.js 22 and npm. Install and build from the repository root:

```bash
npm ci
npm run build
```

Set `APP_MODE=demo` in your environment or `.env`, keep `ENABLE_WEB_TERMINAL=false`, then run:

```bash
npm start
```

Open `http://localhost:3000/vps`. Demo does not require a dashboard password or real SSH credentials. For development, run the API and Vite commands in separate terminals as described in the [README](../README.md#try-it-locally-no-vps-required).

## What to explore

- Simulated servers, resource readings and metric histories.
- Simulated command jobs, progress and activity history.
- Canned terminal output; no real SSH connections.
- Docker monitoring requires agent snapshots and permissions for real infrastructure; the landing preview is static illustration, not live telemetry.

## Docker Compose

Set a strong `POSTGRES_PASSWORD` in `.env` and `APP_MODE=demo`, then run `docker compose up --build -d`. Compose uses PostgreSQL, runs migrations and stores data/private keys in volumes. `docker compose down` preserves volumes; `docker compose down -v` deletes them. See the [deployment instructions](../README.md#deploy-with-docker-compose).

## Move to real infrastructure

Use `APP_MODE=local`, configure the session secret and set the dashboard password before signing in. Add real VPS records, establish SSH key trust and configure agents as needed. Switching modes is not a data migration and does not turn simulated records into real servers; use separate data directories or storage for isolated exploration. PostgreSQL and an optional real web terminal are supported in the product, but real terminal access requires local-mode configuration. Read the [local-mode instructions](../README.md#run-in-local-mode) and [security model](security.md) first.
