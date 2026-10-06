# VPS Operations Dashboard

A self-hosted dashboard for monitoring and managing VPS instances. The project includes a NestJS API, a React/Vite web interface, and an optional Go agent for host metrics. Demo mode uses simulated data, so you can explore the dashboard without a VPS or real SSH credentials.

> **License status:** This repository does not currently contain a `LICENSE` file. No license to use, modify, or distribute the source code has been granted. Contact the maintainer before using it beyond the permissions provided by GitHub's terms.

## Features

- Server health overview and CPU, memory, disk, system load, network, and uptime metrics.
- VPS management, SSH key provisioning and verification, command jobs, and audit logs.
- Demo mode with simulated servers, metrics, job progress, and terminal output; no real SSH connections.
- Local mode with dashboard authentication, SSH host restrictions, and an optional web terminal.
- Optional host agent for metrics collection and Docker monitoring. Docker socket access is not granted by default.
- JSON or PostgreSQL storage, with Docker Compose and a Linux amd64 installer available for deployment.

## Requirements

- From source: a Node.js version compatible with the workspaces (Node.js 22 recommended), npm, and Git.
- With Docker Compose: Docker and Docker Compose; Node.js is not required on the host.
- With the installer: Linux amd64, systemd if installing the host agent, and `sudo` access. Review the script before running it with administrator privileges.

## Try it locally (no VPS required)

```bash
git clone https://github.com/sondoan17/vps-manager-nodejs.git
cd vps-manager-nodejs
npm ci
npm run build
npm start
```

The default is `APP_MODE=demo`. Open <http://localhost:3000>; the API health endpoint is <http://localhost:3000/api/health>. Demo mode uses simulated data and does not establish real SSH connections.

For development, run `npm run dev` (API) and `npm run dev:web` (Vite) in separate terminals. Copy `.env.example` to `.env` and adjust settings as needed; never commit secrets. See [.env.example](.env.example) for environment variables and defaults.

## Deploy with Docker Compose

Create a `.env` file in the repository root with a strong PostgreSQL password:

```dotenv
POSTGRES_PASSWORD=replace_with_a_strong_password
```

Then run:

```bash
docker compose up --build -d
```

Open <http://localhost:3000>. Compose starts PostgreSQL, runs migrations before starting the API, and serves the web interface through nginx. The API is bound to `127.0.0.1:3001` on the host. Demo mode remains the default. Data and private keys are stored in Docker volumes: `docker compose down` preserves them, while `docker compose down -v` **deletes the data**. Optional TimescaleDB migrations are described in the [storage guide](docs/postgres-timescale-storage.md).

## Install on a Linux amd64 VPS

Use [scripts/install/install.sh](scripts/install/install.sh) to deploy the application and host agent. **Review the script and its options before running it with sudo**:

```bash
sudo ./scripts/install/install.sh --help
sudo ./scripts/install/install.sh --dry-run
sudo ./scripts/install/install.sh
```

The installer creates configuration under `/opt/vps-manager`, starts the containers, sets the dashboard password, and installs a systemd agent to collect host metrics. The dashboard is available at `http://<server-ip>:38280` by default. Use `--skip-agent` to install only the application, or `--install-docker` to let the installer install Docker. Run `--help` for other options.

**Deployment security:** Do not expose the local-mode dashboard to the public Internet over plain HTTP. Use HTTPS and configure the origin and cookies accordingly. Enable `ENABLE_WEB_TERMINAL=true` only in `APP_MODE=local`, with the required settings documented in [.env.example](.env.example). The agent has no Docker access by default; `--enable-docker-metrics-access` grants membership in the `docker` group, which is effectively root-equivalent on the host. Read the [security model](docs/security.md) before enabling SSH, the terminal, or Docker access.

## Run in local mode

For a local-only instance using JSON storage, first complete the source installation above. Set these values in `.env` in the repository root (generate your own random secret; do not use the example literally):

```dotenv
APP_MODE=local
DASHBOARD_SESSION_SECRET=replace_with_a_random_secret_of_at_least_32_characters
```

Keep `ENABLE_WEB_TERMINAL=false` initially. Then set the dashboard password via stdin (the CLI has no interactive prompt) and start the built application. In a Bash shell:

```bash
read -rs -p 'Dashboard password: ' DASHBOARD_PASSWORD; echo
printf '%s\n' "$DASHBOARD_PASSWORD" | npm run set-dashboard-password -- --stdin
unset DASHBOARD_PASSWORD
npm start
```

Open <http://localhost:3000> and sign in with the password you set. Add a VPS from the dashboard before provisioning or verifying its SSH key. Real SSH requires an allowed target and a trusted host key; private-network targets are blocked unless explicitly allowed in local mode. See [SSH safety](docs/security.md) and the options in [.env.example](.env.example). Never expose this HTTP example to the public Internet. For Docker Compose local mode, set `APP_MODE=local` and `DASHBOARD_SESSION_SECRET` in the Compose `.env`, start the stack, then pipe a password to `docker compose exec -T api node dist/scripts/set-dashboard-password.js --stdin`.

| Capability | Demo (`APP_MODE=demo`) | Local (`APP_MODE=local`) |
| --- | --- | --- |
| Dashboard data | Simulated | Real, from the configured storage and agents |
| Dashboard login | Not required | Admin password and session cookie required |
| SSH connections | Disabled | Subject to host policy and key trust |
| Web terminal | Canned output only | Optional; disabled by default and requires extra origin/session configuration |
| Host metrics | Simulated | In-process local agent or separately installed host agent |

### Host metric history

CPU & Memory charts use each VPS's retained CPU/RAM samples, with collection timestamps. Network I/O shows separate RX/TX throughput in **B/s**, not cumulative byte totals. The same per-host `history` is returned by `/api/metrics`, `/api/dashboard`, and the monitoring SSE stream; `METRIC_WINDOW_LIMIT` bounds the history (default 120 samples).

The Go agent and in-process Linux collector emit `networkUnit: "bytes/s"` and `networkAvailable`. Initial samples, counter resets, or unavailable network readings become chart gaps instead of false zero/spikes. Legacy local-agent totals remain unavailable as throughput; legacy Go-agent rates are identified at read time. Unsupported local network collection displays `n/a`.

For PostgreSQL, apply `022_metric_network_fields.sql` through `npm run migrate:db` before starting the updated API. Rebuild/deploy the API and web assets, and rebuild/redeploy the host agent to emit explicit unit/availability metadata. Charts populate as fresh samples arrive; fewer than two usable points show an insufficient-history state.


## Configuration and project layout

| Component | Location | Purpose |
| --- | --- | --- |
| API | `packages/api/` | NestJS/Express, authentication, VPS, metrics, jobs, audit |
| Web | `packages/web/` | React/Vite dashboard |
| Agent | `packages/agent/` | Host metrics collection and authorized Docker operations |
| Local data | `data/`, `private/` | JSON data and SSH keys; not served over HTTP |
| Deployment | `docker-compose.yml`, `scripts/` | Compose, migrations, and host agent installation |

Scripts are grouped by purpose under `scripts/`: `agent/` (build and provisioning CLIs), `vps/` (environment imports), `admin/` (dashboard password CLI), `install/` (Linux installers), `ci/` (security gates), `release/` (manifest tools and fixtures), and `tests/` (shell checks). Run npm commands from the repository root; their names are unchanged. API source CLIs remain in `packages/api/src/scripts/` and compile to `dist/scripts/`.

`APP_MODE=demo` is for public exploration without real SSH. `APP_MODE=local` is for managing real infrastructure and requires a dashboard administrator password; set it with `npm run set-dashboard-password` (or the corresponding production script). `STORAGE_DRIVER=json` is the default when running directly; Compose uses PostgreSQL and automatically runs migrations. See the [architecture](docs/architecture.md), [security model](docs/security.md), and [demo guide](docs/demo.md) for details.

## Development and checks

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`npm run build:agent` builds the Go agent; `npm run test:agent` runs its tests (Go required). See [package.json](package.json) for other scripts.

## Troubleshooting

- **Compose fails before the API starts:** Confirm `POSTGRES_PASSWORD` is set, then inspect `docker compose logs postgres migrate api`. Core migrations must succeed before the API starts; see the [storage guide](docs/postgres-timescale-storage.md).
- **Port 3000 is unavailable:** Stop the conflicting process or change the host-side port mapping for `web` in `docker-compose.yml`. For a source install, set `PORT` in `.env` and open that port instead.
- **Local login fails:** Check `APP_MODE`, `DASHBOARD_SESSION_SECRET` (at least 32 characters), and whether the admin password was set against the same storage backend used by the running API. Changing the password revokes existing sessions.
- **Host metrics are missing:** Demo metrics are simulated. For local mode, check that the local agent is enabled or that the separately installed host agent is running (`systemctl status vps-manager-agent`); inspect its logs with `journalctl -u vps-manager-agent`.

## Reporting security issues

Do **not** post vulnerability details, credentials, or exploit steps in a public issue. Use GitHub's private vulnerability reporting feature for this repository if available; otherwise contact the maintainer privately through their GitHub profile before disclosing details. No dedicated security contact or response-time commitment is currently published. See the [security model](docs/security.md) for deployment safeguards.

## Contributing and support

Report bugs or suggest features through [GitHub Issues](https://github.com/sondoan17/vps-manager-nodejs/issues). For pull requests, describe the change, how you verified it, and any security implications. Run `npm run typecheck`, `npm test`, and `npm run build` before submitting. Never include SSH keys, passwords, tokens, or `.env` files in issues or commits. Check the license status above before reusing or distributing the source code.
