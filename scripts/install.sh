#!/usr/bin/env bash
#
# install.sh — One-command VPS Manager installer.
#
# Installs the Docker app (web + API) and optionally the host systemd agent
# on a Linux amd64 server.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sondoan17/vps-manager-nodejs/main/scripts/install.sh | sudo bash
#   sudo ./scripts/install.sh [options]
#
# Options:
#   --help                   Show this help.
#   --dry-run                Print what would be done without making changes.
#   --app-dir <path>         Application data directory (default: /opt/vps-manager).
#   --app-port <port>        Web UI port (default: 38280).
#   --api-port <port>        Internal API port (default: 38281).
#   --api-image <image>      API Docker image (default: ghcr.io/sondoan17/vps-manager-nodejs-api:latest).
#   --web-image <image>      Web Docker image (default: ghcr.io/sondoan17/vps-manager-nodejs-web:latest).
#   --backend-url <url>      Backend URL for the host agent (default: http://127.0.0.1:<app-port>).
#   --allow-insecure-backend-url Allow http backend URL to non-loopback addresses.
#   --dashboard-password-file <path> Read dashboard password from file (one line).
#   --install-docker         Auto-install Docker via get.docker.com (default: fail with instructions).
#   --skip-pull              Do not pull images before starting (use local images).
#   --skip-agent             Skip installing the host systemd agent.
#   --rotate-agent           Rotate local agent token/config even if one already exists.
#
# The script:
#   1. Checks root, Linux amd64, Docker availability.
#   2. Generates /opt/vps-manager/.env (preserving existing secrets).
#   3. Generates a docker-compose.yml for web + API services.
#   4. Pulls images and starts containers.
#   5. Waits for API health endpoint.
#   6. Sets dashboard password.
#   7. Extracts agent binary from API container.
#   8. Bootstraps agent credential via API container.
#   9. Installs host systemd agent (unless --skip-agent).

set -euo pipefail
umask 077

# ── Defaults ──────────────────────────────────────────────────────────────

APP_DIR="/opt/vps-manager"
APP_PORT=38280
API_PORT=38281
API_IMAGE="ghcr.io/sondoan17/vps-manager-nodejs-api:latest"
WEB_IMAGE="ghcr.io/sondoan17/vps-manager-nodejs-web:latest"
BACKEND_URL=""
ALLOW_INSECURE_BACKEND_URL=false
DASHBOARD_PASSWORD_FILE=""
INSTALL_DOCKER=false
SKIP_PULL=false
SKIP_AGENT=false
ROTATE_AGENT=false
DRY_RUN=false
GENERATED_PASSWORD=""
AGENT_SERVICE_NAME="vps-manager-agent"
AGENT_CONFIG_FILE="/etc/vps-manager-agent/config.json"
ENABLE_DOCKER_METRICS_ACCESS=false
TMP_FILES=()

cleanup_tmp_files() {
  for tmp_file in "${TMP_FILES[@]}"; do
    if [[ -n "$tmp_file" && -f "$tmp_file" ]]; then
      rm -f "$tmp_file"
    fi
  done
}
trap cleanup_tmp_files EXIT

random_hex() {
  local bytes="$1"
  if command -v openssl &>/dev/null; then
    openssl rand -hex "$bytes"
  else
    od -An -tx1 -N "$bytes" /dev/urandom | tr -d ' \n'
  fi
}

# ── Arg parsing ───────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)
      echo "Usage: sudo $0 [options]"
      echo ""
      echo "Options:"
      echo "  --help                    Show this help."
      echo "  --dry-run                 Print what would be done without making changes."
      echo "  --app-dir <path>          Application data directory (default: ${APP_DIR})."
      echo "  --app-port <port>         Web UI port (default: ${APP_PORT})."
      echo "  --api-port <port>         Internal API port (default: ${API_PORT})."
      echo "  --api-image <image>       API Docker image (default: ${API_IMAGE})."
      echo "  --web-image <image>       Web Docker image (default: ${WEB_IMAGE})."
      echo "  --backend-url <url>       Backend URL for host agent."
      echo "  --allow-insecure-backend-url Allow http backend URL to non-loopback addresses."
      echo "  --dashboard-password-file <path> Read password from file."
      echo "  --install-docker          Auto-install Docker via get.docker.com."
      echo "  --skip-pull               Do not pull images before starting (use local images)."
      echo "  --skip-agent              Skip host systemd agent installation."
      echo "  --rotate-agent            Rotate local agent token/config."
      echo "  --enable-docker-metrics-access"
      echo "                            Add docker group to the systemd agent service unit"
      echo "                            (SupplementaryGroups). Docker group access is"
      echo "                            root-equivalent; only needed if Docker metrics are"
      echo "                            enabled via the dashboard."
      exit 0 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --app-port) APP_PORT="$2"; shift 2 ;;
    --api-port) API_PORT="$2"; shift 2 ;;
    --api-image) API_IMAGE="$2"; shift 2 ;;
    --web-image) WEB_IMAGE="$2"; shift 2 ;;
    --backend-url) BACKEND_URL="$2"; shift 2 ;;
    --allow-insecure-backend-url) ALLOW_INSECURE_BACKEND_URL=true; shift ;;
    --dashboard-password-file) DASHBOARD_PASSWORD_FILE="$2"; shift 2 ;;
    --install-docker) INSTALL_DOCKER=true; shift ;;
    --skip-pull) SKIP_PULL=true; shift ;;
    --skip-agent) SKIP_AGENT=true; shift ;;
    --rotate-agent) ROTATE_AGENT=true; shift ;;
    --enable-docker-metrics-access) ENABLE_DOCKER_METRICS_ACCESS=true; shift ;;
    *)
      echo "Error: Unknown argument: $1"
      echo "Usage: sudo $0 [options]"
      exit 1 ;;
  esac
done

# ── Prerequisites ─────────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (sudo)." >&2
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$(uname -s)" != "Linux" ]] || [[ "$ARCH" != "x86_64" ]]; then
  echo "Error: Only Linux amd64 is supported (detected: $(uname -s) ${ARCH})." >&2
  exit 1
fi

# Docker check
if ! command -v docker &>/dev/null; then
  if [[ "$INSTALL_DOCKER" == "true" ]]; then
    echo "[Setup] Installing Docker via get.docker.com..."
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would run: curl -fsSL https://get.docker.com | sh"
    else
      curl -fsSL https://get.docker.com | sh
      systemctl enable --now docker
      echo "  Docker installed."
    fi
  else
    echo "Error: Docker is not installed." >&2
    echo "  Install Docker first: curl -fsSL https://get.docker.com | sh" >&2
    echo "  Or run with --install-docker to auto-install." >&2
    exit 1
  fi
fi

if ! docker compose version &>/dev/null; then
  echo "Error: docker compose plugin is required." >&2
  echo "  Install it: sudo apt install docker-compose-plugin  (or equivalent)" >&2
  exit 1
fi

# ── Setup directories ─────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would create directory: ${APP_DIR} (0700)"
else
  mkdir -p "${APP_DIR}"
  chmod 0700 "${APP_DIR}"
fi

DATA_DIR="${APP_DIR}/data"
PRIVATE_DIR="${APP_DIR}/private"
ENV_FILE="${APP_DIR}/.env"
COMPOSE_FILE="${APP_DIR}/docker-compose.yml"
ADMIN_CREDENTIAL_FILE="${DATA_DIR}/admin-credential.json"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would create directories: ${DATA_DIR} ${PRIVATE_DIR}"
else
  mkdir -p "$DATA_DIR" "$PRIVATE_DIR"
fi

# ── Env file ──────────────────────────────────────────────────────────────

# Preserve existing dashboard session secret if env file exists.
CURRENT_DASHBOARD_SECRET=""
if [[ -f "$ENV_FILE" ]]; then
  CURRENT_DASHBOARD_SECRET=$(grep -E '^DASHBOARD_SESSION_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)
fi

if [[ -z "$CURRENT_DASHBOARD_SECRET" ]]; then
  CURRENT_DASHBOARD_SECRET="$(random_hex 32)"
  CURRENT_DASHBOARD_SECRET="${CURRENT_DASHBOARD_SECRET:0:64}"
fi

if [[ -z "$BACKEND_URL" ]]; then
  BACKEND_URL="http://127.0.0.1:${APP_PORT}"
fi

if [[ "$BACKEND_URL" == http://* ]]; then
  case "$BACKEND_URL" in
    http://127.0.0.1:*|http://127.0.0.1/*|http://localhost:*|http://localhost/*|http://\[::1\]*|http://\[::1\]/*) ;;
    *)
      if [[ "$ALLOW_INSECURE_BACKEND_URL" != "true" ]]; then
        echo "Error: Refusing non-loopback HTTP backend URL: ${BACKEND_URL}" >&2
        echo "  Use HTTPS, a loopback URL, or pass --allow-insecure-backend-url explicitly." >&2
        exit 1
      fi
      ;;
  esac
fi

ENV_CONTENT=$(
  cat <<ENV
# VPS Manager — generated by install.sh
# Managed values may be rewritten on re-run; data/private directories are preserved.

APP_MODE=local
LOCAL_AGENT_ENABLED=false
STORAGE_DRIVER=json
DATA_DIR=/app/data
PRIVATE_DIR=/app/private

PORT=3000
DASHBOARD_SESSION_SECRET=${CURRENT_DASHBOARD_SECRET}
DASHBOARD_SESSION_TTL_SECONDS=86400
DASHBOARD_COOKIE_SECURE=false
DASHBOARD_COOKIE_SAME_SITE=lax

ENABLE_WEB_TERMINAL=false
ALLOW_PRIVATE_NETWORK_TARGETS=false
ALLOW_INSECURE_AGENT_HTTP=false

TRUST_PROXY_HOPS=0
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120

METRIC_WINDOW_LIMIT=120
JOB_HISTORY_LIMIT=1000
AUDIT_HISTORY_LIMIT=5000

SSH_HOST_KEY_POLICY=strict
ENV
)

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would write env file: ${ENV_FILE} (0600)"
  echo "---"
  echo "$ENV_CONTENT" | head -5
  echo "..."
  echo "---"
else
  echo "$ENV_CONTENT" > "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  echo "[Setup] Env file: ${ENV_FILE}"
fi

# ── Compose file ──────────────────────────────────────────────────────────

COMPOSE_CONTENT=$(
  cat <<COMPOSE
services:
  api:
    image: ${API_IMAGE}
    ports:
      - "127.0.0.1:${API_PORT}:3000"
    volumes:
      - ./data:/app/data
      - ./private:/app/private
    env_file: .env
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
    restart: unless-stopped

  web:
    image: ${WEB_IMAGE}
    ports:
      - "${APP_PORT}:80"
    depends_on:
      api:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1/"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 5s
    restart: unless-stopped
COMPOSE
)

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would write compose file: ${COMPOSE_FILE}"
  echo "---"
  echo "$COMPOSE_CONTENT"
  echo "---"
else
  echo "$COMPOSE_CONTENT" > "$COMPOSE_FILE"
  echo "[Setup] Compose file: ${COMPOSE_FILE}"
fi

# ── Pull ──────────────────────────────────────────────────────────────────

if [[ "$SKIP_PULL" == "true" ]]; then
  echo "[Docker] Skipping image pull (--skip-pull)."
elif [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would run: docker compose -f ${COMPOSE_FILE} pull"
else
  echo "[Docker] Pulling images..."
  docker compose -f "$COMPOSE_FILE" pull
  echo "[Docker] Images pulled."
fi

# ── Bind mount ownership ──────────────────────────────────────────────────

# The API image runs as a non-root user. Bind-mounted data/private directories
# must be owned by that container UID/GID or JSON storage and credentials cannot
# be written on first boot.
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would set ${DATA_DIR} and ${PRIVATE_DIR} ownership to the API container user"
else
  API_UID_GID="$(docker run --rm --entrypoint sh "$API_IMAGE" -lc 'printf "%s:%s" "$(id -u)" "$(id -g)"')"
  if [[ ! "$API_UID_GID" =~ ^[0-9]+:[0-9]+$ ]]; then
    echo "Error: Could not determine API image runtime UID/GID for ${API_IMAGE}." >&2
    exit 1
  fi
  chown -R "$API_UID_GID" "$DATA_DIR" "$PRIVATE_DIR"
  chmod 0700 "$DATA_DIR" "$PRIVATE_DIR"
  echo "[Setup] Data directories owned by API container user (${API_UID_GID})."
fi

# ── Start ─────────────────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would run: docker compose -f ${COMPOSE_FILE} up -d"
else
  echo "[Docker] Starting containers..."
  docker compose -f "$COMPOSE_FILE" up -d
  echo "[Docker] Containers started."
fi

# ── Wait for health ───────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would wait for API health at http://127.0.0.1:${API_PORT}/api/health"
else
  echo "[Setup] Waiting for API to become healthy..."
  API_HEALTH_URL="http://127.0.0.1:${API_PORT}/api/health"
  RETRIES=30
  DELAY=3
  for i in $(seq 1 "$RETRIES"); do
    if curl -sf "$API_HEALTH_URL" &>/dev/null; then
      echo "  API is healthy after ~$((i * DELAY))s."
      break
    fi
    if [[ "$i" == "$RETRIES" ]]; then
      echo "Error: API did not become healthy after ${RETRIES} attempts." >&2
      echo "  Check logs: docker compose -f ${COMPOSE_FILE} logs api" >&2
      exit 1
    fi
    sleep "$DELAY"
  done
fi

# ── Dashboard password ────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would set dashboard password"
else
  echo "[Setup] Setting dashboard password..."

  PASSWORD=""
  SKIP_PASSWORD_SET=false
  PASSWORD_ALREADY_CONFIGURED=false
  if [[ -f "$ADMIN_CREDENTIAL_FILE" ]]; then
    PASSWORD_ALREADY_CONFIGURED=true
  fi

  if [[ -n "$DASHBOARD_PASSWORD_FILE" ]]; then
    if [[ -f "$DASHBOARD_PASSWORD_FILE" ]]; then
      PASSWORD="$(head -1 "$DASHBOARD_PASSWORD_FILE" | tr -d '\n\r')"
    else
      echo "Warning: Password file not found: ${DASHBOARD_PASSWORD_FILE}" >&2
    fi
  fi

  if [[ -z "$PASSWORD" ]]; then
    if [[ -t 0 ]]; then
      # TTY available — prompt user
      if [[ "$PASSWORD_ALREADY_CONFIGURED" == "true" ]]; then
        echo -n "Enter dashboard password (empty keeps existing): " >&2
      else
        echo -n "Enter dashboard password (empty auto-generates): " >&2
      fi
      read -rs PASSWORD_INPUT
      echo >&2
      PASSWORD="${PASSWORD_INPUT}"
    fi
    if [[ -z "$PASSWORD" ]]; then
      if [[ "$PASSWORD_ALREADY_CONFIGURED" == "true" ]]; then
        SKIP_PASSWORD_SET=true
      else
        # Auto-generate on first install when no password was provided.
        PASSWORD="$(random_hex 18)"
        GENERATED_PASSWORD="$PASSWORD"
      fi
    fi
  fi

  if [[ "$SKIP_PASSWORD_SET" == "true" ]]; then
    echo "  Existing dashboard password detected; keeping it."
  elif [[ -n "$PASSWORD" ]]; then
    printf '%s\n' "$PASSWORD" | docker compose -f "$COMPOSE_FILE" exec -T api node dist/scripts/set-dashboard-password.js --stdin --skip-if-same
    echo "  Dashboard password set."
  else
    echo "Warning: No dashboard password provided. Set via:" >&2
    echo "  echo '<password>' | docker compose -f ${COMPOSE_FILE} exec -T api node dist/scripts/set-dashboard-password.js --stdin" >&2
  fi
fi

# ── Agent installation ────────────────────────────────────────────────────

if [[ "$SKIP_AGENT" == "true" ]]; then
  echo "[Agent] Skipping (--skip-agent)."
else
  echo "[Agent] Setting up host systemd agent..."

  # Determine the container running the API service
  API_CONTAINER=""
  if [[ "$DRY_RUN" == "false" ]]; then
    API_CONTAINER="$(docker compose -f "$COMPOSE_FILE" ps -q api 2>/dev/null | head -1)"
    if [[ -z "$API_CONTAINER" ]]; then
      echo "Error: Could not find running API container." >&2
      echo "  Falling back to 'api' service name..." >&2
      API_CONTAINER="$(docker ps --filter name=vps-manager-api --format '{{.ID}}' | head -1)"
    fi
  fi

  # Extract agent binary from API container
  AGENT_BIN_TMP=""
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would extract agent binary from API container..."
  else
    AGENT_BIN_TMP="$(mktemp)"
    TMP_FILES+=("$AGENT_BIN_TMP")
    if ! docker cp "${API_CONTAINER}:/app/agent/vps-agent-linux-amd64" "$AGENT_BIN_TMP" &>/dev/null; then
      echo "Error: Failed to extract agent binary from API container." >&2
      echo "  Ensure API image has the agent at /app/agent/vps-agent-linux-amd64" >&2
      echo "  Skipping agent installation." >&2
      AGENT_BIN_TMP=""
    else
      chmod 0755 "$AGENT_BIN_TMP"
      echo "  Extracted agent binary."
    fi
  fi

  # Bootstrap agent credential and generate config using --config-only
  AGENT_CONFIG_TMP=""
  AGENT_CONFIG_CREATED=false
  if [[ -n "$AGENT_BIN_TMP" ]] || [[ "$DRY_RUN" == "true" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would run bootstrap inside API container..."
      echo "  [DRY-RUN] Would capture config to temp file."
    elif [[ -f "$AGENT_CONFIG_FILE" && "$ROTATE_AGENT" != "true" ]]; then
      AGENT_CONFIG_TMP="$AGENT_CONFIG_FILE"
      echo "  Reusing existing agent config: ${AGENT_CONFIG_FILE}"
    else
      AGENT_CONFIG_TMP="$(mktemp)"
      TMP_FILES+=("$AGENT_CONFIG_TMP")
      AGENT_CONFIG_CREATED=true
      BOOTSTRAP_ARGS=(node dist/scripts/bootstrap-local-agent.js \
        --backend-url "$BACKEND_URL" \
        --config-only \
        --rotate)
      if [[ "$ALLOW_INSECURE_BACKEND_URL" == "true" ]]; then
        BOOTSTRAP_ARGS+=(--allow-insecure-backend-url)
      fi
      if ! docker compose -f "$COMPOSE_FILE" exec -T api "${BOOTSTRAP_ARGS[@]}" > "$AGENT_CONFIG_TMP" 2>/dev/null; then
        echo "Error: Bootstrap failed." >&2
        echo "  Check logs: docker compose -f ${COMPOSE_FILE} logs api" >&2
        rm -f "$AGENT_BIN_TMP"
        AGENT_BIN_TMP=""
        AGENT_CONFIG_TMP=""
      else
        echo "  Agent credential bootstrapped."
      fi
    fi
  fi

  # Run install-local-agent.sh
  if { [[ -n "$AGENT_BIN_TMP" ]] && [[ -n "$AGENT_CONFIG_TMP" ]]; } || [[ "$DRY_RUN" == "true" ]]; then
    INSTALL_SCRIPT="$(cd "$(dirname "$0")" && pwd)/install-local-agent.sh"
    if [[ ! -f "$INSTALL_SCRIPT" ]]; then
      # Script may not be locally available; try to curl from GitHub
      INSTALL_SCRIPT=""
      if command -v curl &>/dev/null; then
        if [[ "$DRY_RUN" == "true" ]]; then
          echo "  [DRY-RUN] Would download install-local-agent.sh from GitHub"
        else
          INSTALL_SCRIPT="$(mktemp)"
          TMP_FILES+=("$INSTALL_SCRIPT")
          curl -fsSL -o "$INSTALL_SCRIPT" "https://raw.githubusercontent.com/sondoan17/vps-manager-nodejs/main/scripts/install-local-agent.sh"
          chmod 0755 "$INSTALL_SCRIPT"
        fi
      fi
    fi

    if [[ -n "$INSTALL_SCRIPT" ]] || [[ "$DRY_RUN" == "true" ]]; then
      AGENT_INSTALL_ARGS=(--binary "$AGENT_BIN_TMP" --config "$AGENT_CONFIG_TMP" --service-name "$AGENT_SERVICE_NAME")
      if [[ "$ENABLE_DOCKER_METRICS_ACCESS" == "true" ]]; then
        AGENT_INSTALL_ARGS+=(--enable-docker-metrics-access)
      fi

      if [[ "$DRY_RUN" == "true" ]]; then
        echo "  [DRY-RUN] Would run: ${INSTALL_SCRIPT} ${AGENT_INSTALL_ARGS[*]}"
        echo "  [DRY-RUN] Would clean up temp files."
      else
        bash "$INSTALL_SCRIPT" "${AGENT_INSTALL_ARGS[@]}"
        if [[ "$AGENT_CONFIG_CREATED" == "true" ]]; then
          TOKEN_LINE="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$AGENT_CONFIG_TMP" | head -1)"
          KEEP_CREDENTIAL_ID="${TOKEN_LINE#vma_}"
          KEEP_CREDENTIAL_ID="${KEEP_CREDENTIAL_ID%_*}"
          if [[ -n "$KEEP_CREDENTIAL_ID" && "$KEEP_CREDENTIAL_ID" != "$TOKEN_LINE" ]]; then
            if docker compose -f "$COMPOSE_FILE" exec -T api node dist/scripts/revoke-agent-credentials.js \
              --vps-id vps_local_host \
              --keep-credential-id "$KEEP_CREDENTIAL_ID" >/dev/null 2>&1; then
              echo "  Old local-agent credentials revoked."
            else
              echo "Warning: Could not revoke old local-agent credentials automatically." >&2
            fi
          else
            echo "Warning: Could not parse credential id from generated agent config; old credentials were not revoked." >&2
          fi
        fi
        echo "  Host agent installed."
      fi
    else
      echo "Warning: install-local-agent.sh not found. Skipping agent installation." >&2
      echo "  To install manually:" >&2
      echo "    curl -fsSL https://raw.githubusercontent.com/sondoan17/vps-manager-nodejs/main/scripts/install-local-agent.sh | sudo bash -s -- --binary <binary> --config <config>" >&2
    fi
  else
    echo "Warning: Agent binary or config could not be obtained. Skipping agent installation." >&2
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────

DASHBOARD_URL="http://<your-server-ip>:${APP_PORT}"
if [[ -n "$GENERATED_PASSWORD" ]]; then
  echo ""
  echo "============================================"
  echo "  VPS Manager installed successfully!"
  echo "  Dashboard: ${DASHBOARD_URL}"
  echo "  Username:  admin"
  echo "  Password:  ${GENERATED_PASSWORD}"
  echo "============================================"
  echo ""
  echo "Save this password now. It will not be shown again."
else
  echo ""
  echo "============================================"
  echo "  VPS Manager installed successfully!"
  echo "  Dashboard: ${DASHBOARD_URL}"
  echo "============================================"
  echo ""
fi

echo "Manage:    docker compose -f ${COMPOSE_FILE} ps"
echo "Logs:      docker compose -f ${COMPOSE_FILE} logs -f"
echo "Stop:      docker compose -f ${COMPOSE_FILE} down"
echo "Upgrade:   docker compose -f ${COMPOSE_FILE} pull && docker compose -f ${COMPOSE_FILE} up -d"
echo "Uninstall agent: sudo systemctl disable --now ${AGENT_SERVICE_NAME}; sudo rm -f /etc/systemd/system/${AGENT_SERVICE_NAME}.service /usr/local/bin/vps-manager-agent; sudo rm -rf /etc/vps-manager-agent"
echo "Uninstall app:   docker compose -f ${COMPOSE_FILE} down    # add -v and rm -rf ${APP_DIR} only if you want to purge data"
echo ""
# Runbook pointer (plan §5): the app never silently upgrades the local
# agent or the updater; both stay operator-driven.
echo "Local agent/updater upgrades are NEVER automatic (plan §5)."
echo "  Manual updater bootstrap: sudo ./scripts/install-updater.sh --binary <vps-updater> --config <config.json> \\"
echo "                            --manifest <manifest.json> --pubkey-file <pinned-release-pub.b64>"
echo "                            (--sha256 <entry-sha256> optional extra pin; must equal the signed entry, never trusted alone)"
echo "  Offline runbook:          docs/local-agent-upgrade-operations.md"
