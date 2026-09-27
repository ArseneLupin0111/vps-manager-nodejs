#!/usr/bin/env bash
# shellcheck disable=SC2317
#
# install-updater.sh — Bootstrap the pull-only local-agent safe-upgrade
# updater (docs/local-agent-upgrade-plan.md §4/§5). Manual, operator-driven
# install: CI/deploy never runs this silently.
#
# Usage:
#   sudo ./install-updater.sh --binary <path> --config <path> [options]
#
# Options:
#   --binary <path>       Path to the vps-updater binary (required).
#   --config <path>       Path to the updater config JSON (required).
#   --manifest <path>     Path to the Ed25519-signed release manifest
#                         (required in install mode, including --dry-run;
#                         not needed for --uninstall). Verified offline
#                         against the pinned public key with
#                         scripts/release/verify-manifest.mjs before
#                         anything is installed; the exact
#                         component:"updater"/os/arch entry supplies the
#                         expected size, SHA-256 and
#                         <version>+<buildId> identity checked against the
#                         binary. No network access, no unverified path.
#   --pubkey <b64>        Pinned release public key (raw 32-byte Ed25519,
#                         base64). Exactly one of --pubkey/--pubkey-file/
#                         --pubkey-env must be given with --manifest.
#   --pubkey-file <path>  File holding the pinned base64 public key.
#   --pubkey-env <name>   Environment variable holding the pinned key.
#   --sha256 <hex>        Optional extra pin: must equal the signed
#                         manifest's updater-entry SHA-256 (never trusted
#                         on its own — the manifest entry is authoritative).
#   --dry-run             Print what would be done without making changes.
#   --uninstall           Stop/disable updater units and remove updater files.
#                         Preserves /var/lib/vps-updater (journals, backups).
#   --purge-state         With --uninstall: also remove /var/lib/vps-updater.
#   --help                Show this help.
#
# This script:
#   1. Verifies the signed release manifest offline against the pinned
#      public key (scripts/release/verify-manifest.mjs), selects the exact
#      component:"updater" artifact for this os/arch, and refuses to install
#      unless the binary's size, SHA-256 and `-version` identity match that
#      signed entry. Verification failure stops the install before any file
#      or unit is written.
#   2. Installs the updater binary to /usr/local/lib/vps-manager-agent/
#      vps-updater (root:root 0755) — NOT writable by the updater user and
#      never a path the privileged helper may replace.
#   3. Creates system user/group vps-updater (no shell, no home).
#   4. Installs config to /etc/vps-updater/config.json (root:vps-updater
#      0640, dir 0750) with apiBase https, fixed agentBinary/agentUnit.
#   5. Creates the state layout /var/lib/vps-updater with the DAC model the
#      capability-less helper relies on:
#        pending/ results/ staging/  root:vps-updater 0770 (shared)
#        helper/                     root:root 0755 (updater reads only)
#        helper/backups/             root:root 0755
#   6. Writes three hardened systemd units:
#        vps-updater.service       unprivileged pull-only daemon
#        vps-updater-apply.path    watches stateDir/pending
#        vps-updater-apply.service root oneshot, FIXED argv, empty
#                                  CapabilityBoundingSet — the daemon can
#                                  never pass commands, paths or units
#   7. Enables the daemon and the path unit. Never touches
#      vps-manager-agent.service beyond what the helper itself restarts.
#
# Requires root (except --dry-run, which works unprivileged).

set -euo pipefail
umask 077

# ── Constants (fixed by the updater's production invariants) ──────────────

BINARY_DEST="/usr/local/lib/vps-manager-agent/vps-updater"
CONFIG_DIR="/etc/vps-updater"
CONFIG_FILE="${CONFIG_DIR}/config.json"
STATE_DIR="/var/lib/vps-updater"
SERVICE_USER="vps-updater"
UNIT_DAEMON="/etc/systemd/system/vps-updater.service"
UNIT_PATH="/etc/systemd/system/vps-updater-apply.path"
UNIT_HELPER="/etc/systemd/system/vps-updater-apply.service"
# Ed25519 manifest verification runs offline via the repo's existing CLI.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_MANIFEST_CLI="${SCRIPT_DIR}/release/verify-manifest.mjs"
# The install target is always a Linux systemd host, whatever platform the
# operator previews it from; arch follows the running machine.
TARGET_OS="linux"
case "$(uname -m)" in
  x86_64|amd64) TARGET_ARCH="amd64" ;;
  aarch64|arm64) TARGET_ARCH="arm64" ;;
  *) TARGET_ARCH="$(uname -m)" ;;
esac

# ── Args ──────────────────────────────────────────────────────────────────

BINARY_SRC=""
CONFIG_SRC=""
MANIFEST_SRC=""
PUBKEY=""
PUBKEY_FILE=""
PUBKEY_ENV=""
SHA256_EXPECTED=""
DRY_RUN=false
UNINSTALL=false
PURGE_STATE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary)
      BINARY_SRC="$2"; shift 2 ;;
    --config)
      CONFIG_SRC="$2"; shift 2 ;;
    --manifest)
      MANIFEST_SRC="$2"; shift 2 ;;
    --pubkey)
      PUBKEY="$2"; shift 2 ;;
    --pubkey-file)
      PUBKEY_FILE="$2"; shift 2 ;;
    --pubkey-env)
      PUBKEY_ENV="$2"; shift 2 ;;
    --sha256)
      SHA256_EXPECTED="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=true; shift ;;
    --uninstall)
      UNINSTALL=true; shift ;;
    --purge-state)
      PURGE_STATE=true; shift ;;
    --help)
      sed -n '2,66p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Error: Unknown argument: $1" >&2
      echo "Usage: sudo ./install-updater.sh --binary <path> --config <path> --manifest <path> (--pubkey <b64>|--pubkey-file <path>|--pubkey-env <name>) [--dry-run|--uninstall]" >&2
      exit 1 ;;
  esac
done

# ── Root check (dry-run works unprivileged) ───────────────────────────────

if [[ $EUID -ne 0 && "$DRY_RUN" != "true" ]]; then
  echo "Error: This script must be run as root (sudo), or use --dry-run." >&2
  exit 1
fi

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would run: $*"
  else
    "$@"
  fi
}

# ── Uninstall mode ────────────────────────────────────────────────────────

if [[ "$UNINSTALL" == "true" ]]; then
  echo "[Uninstall] Removing the local-agent updater..."
  for u in "vps-updater-apply.path" "vps-updater-apply.service" "vps-updater.service"; do
    if systemctl list-unit-files "$u" &>/dev/null || [[ -f "/etc/systemd/system/$u" ]]; then
      run systemctl disable --now "$u" 2>/dev/null || true
      # disable --now on a .path also stops the triggered .service
      run systemctl stop "${u%.path}.service" 2>/dev/null || true
    fi
    if [[ -f "/etc/systemd/system/$u" ]]; then
      run rm -f "/etc/systemd/system/$u"
    fi
  done
  run systemctl daemon-reload

  if [[ -f "$BINARY_DEST" ]]; then
    run rm -f "$BINARY_DEST"
  fi
  if [[ -d "$CONFIG_DIR" ]]; then
    run rm -rf "$CONFIG_DIR"
  fi

  if [[ "$PURGE_STATE" == "true" ]]; then
    if [[ -d "$STATE_DIR" ]]; then
      echo "  WARNING: purging ${STATE_DIR} (journals and any retained backups)" >&2
      run rm -rf "$STATE_DIR"
    fi
  elif [[ -d "$STATE_DIR" ]]; then
    echo "[Uninstall] Preserved ${STATE_DIR} (journals/backups; use --purge-state to remove)."
    echo "[Uninstall] Offline recovery: see docs/local-agent-upgrade-plan.md runbook."
  fi
  echo "[Uninstall] The agent unit ${UNIT_HELPER##*/} was not modified; vps-manager-agent keeps running."
  exit 0
fi

# ── Install mode validation ───────────────────────────────────────────────

if [[ -z "$BINARY_SRC" ]]; then
  echo "Error: --binary <path> is required." >&2
  exit 1
fi
if [[ ! -f "$BINARY_SRC" ]]; then
  echo "Error: Binary not found: ${BINARY_SRC}" >&2
  exit 1
fi
if [[ -z "$CONFIG_SRC" ]]; then
  echo "Error: --config <path> is required." >&2
  exit 1
fi
if [[ ! -f "$CONFIG_SRC" ]]; then
  echo "Error: Config file not found: ${CONFIG_SRC}" >&2
  exit 1
fi

# Signed-manifest trust bootstrap (plan §4): install mode — including
# --dry-run — refuses any binary whose size/SHA-256/-version identity is not
# covered by the Ed25519-signed updater artifact entry. --sha256 alone is
# never sufficient: it is only cross-checked against the signed entry.
# --uninstall above needs no manifest; there is no unverified install path.
if [[ -z "$MANIFEST_SRC" ]]; then
  echo "Error: --manifest <path> is required (the signed release manifest)." >&2
  echo "  Obtain it from the release pipeline and verify it against your" >&2
  echo "  pinned public key; install never accepts an unverified binary." >&2
  exit 1
fi
if [[ ! -f "$MANIFEST_SRC" ]]; then
  echo "Error: Manifest not found: ${MANIFEST_SRC}" >&2
  exit 1
fi
PUBKEY_SOURCES=0
if [[ -n "$PUBKEY" ]]; then PUBKEY_SOURCES=$((PUBKEY_SOURCES + 1)); fi
if [[ -n "$PUBKEY_FILE" ]]; then PUBKEY_SOURCES=$((PUBKEY_SOURCES + 1)); fi
if [[ -n "$PUBKEY_ENV" ]]; then PUBKEY_SOURCES=$((PUBKEY_SOURCES + 1)); fi
if [[ "$PUBKEY_SOURCES" -ne 1 ]]; then
  echo "Error: exactly one of --pubkey, --pubkey-file, --pubkey-env is required with --manifest." >&2
  exit 1
fi
if [[ -n "$PUBKEY_FILE" && ! -f "$PUBKEY_FILE" ]]; then
  echo "Error: Public key file not found: ${PUBKEY_FILE}" >&2
  exit 1
fi
if [[ ! -f "$VERIFY_MANIFEST_CLI" ]]; then
  echo "Error: verify-manifest.mjs not found: ${VERIFY_MANIFEST_CLI}" >&2
  echo "  install-updater.sh must ship alongside scripts/release/verify-manifest.mjs." >&2
  exit 1
fi
if ! command -v node &>/dev/null; then
  echo "Error: node is required to validate the updater config and verify the signed manifest." >&2
  exit 1
fi

VERIFY_ARGS=(--manifest "$MANIFEST_SRC")
if [[ -n "$PUBKEY" ]]; then
  VERIFY_ARGS+=(--pubkey "$PUBKEY")
elif [[ -n "$PUBKEY_FILE" ]]; then
  VERIFY_ARGS+=(--pubkey-file "$PUBKEY_FILE")
else
  VERIFY_ARGS+=(--pubkey-env "$PUBKEY_ENV")
fi
if ! MF_OUT="$(node "$VERIFY_MANIFEST_CLI" "${VERIFY_ARGS[@]}" 2>&1)"; then
  echo "Error: signed manifest verification failed: ${MANIFEST_SRC}" >&2
  printf '%s\n' "$MF_OUT" | sed 's/^/  /' >&2
  exit 1
fi
echo "[Install] Signed manifest verified: ${MF_OUT}"

# Select the exact updater artifact for this platform. component/os/arch
# must match exactly; a missing, duplicated or foreign entry fails closed
# (e.g. an agent-only manifest cannot bootstrap the updater).
if ! ENTRY="$(node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const os = process.argv[2];
  const arch = process.argv[3];
  const hits = (Array.isArray(m.artifacts) ? m.artifacts : []).filter(
    (a) => a && a.component === "updater" && a.os === os && a.arch === arch,
  );
  if (hits.length !== 1) {
    console.error(`manifest carries ${hits.length} component:"updater" artifacts for ${os}/${arch}; exactly 1 required`);
    process.exit(1);
  }
  const a = hits[0];
  console.log(`${m.version} ${m.buildId} ${m.releaseId} ${a.sha256} ${a.size}`);
' "$MANIFEST_SRC" "$TARGET_OS" "$TARGET_ARCH" 2>&1)"; then
  echo "Error: no verified updater artifact in manifest: ${MANIFEST_SRC}" >&2
  printf '%s\n' "$ENTRY" | sed 's/^/  /' >&2
  exit 1
fi
read -r ENTRY_VERSION ENTRY_BUILDID ENTRY_RELEASE ENTRY_SHA ENTRY_SIZE <<<"$ENTRY"

# Binary size and SHA-256 against the signed entry.
BINARY_SIZE="$(wc -c < "$BINARY_SRC" | tr -d '[:space:]')"
if ! [[ "$BINARY_SIZE" =~ ^[0-9]+$ ]]; then
  echo "Error: cannot measure binary size: ${BINARY_SRC}" >&2
  exit 1
fi
if [[ "$BINARY_SIZE" -ne "$ENTRY_SIZE" ]]; then
  echo "Error: binary size mismatch: got ${BINARY_SIZE} bytes, signed updater entry says ${ENTRY_SIZE}." >&2
  exit 1
fi
if command -v sha256sum &>/dev/null; then
  ACTUAL_SHA="$(sha256sum "$BINARY_SRC" | awk '{print $1}')"
elif command -v shasum &>/dev/null; then
  ACTUAL_SHA="$(shasum -a 256 "$BINARY_SRC" | awk '{print $1}')"
else
  echo "Error: cannot verify binary hash (no sha256sum or shasum)." >&2
  exit 1
fi
if [[ "${ACTUAL_SHA,,}" != "${ENTRY_SHA,,}" ]]; then
  echo "Error: binary SHA-256 mismatch: got ${ACTUAL_SHA}, signed updater entry says ${ENTRY_SHA}." >&2
  exit 1
fi
echo "[Install] Binary SHA-256 verified against signed entry: ${ACTUAL_SHA} (${BINARY_SIZE} bytes)"
if [[ -n "$SHA256_EXPECTED" ]]; then
  if ! [[ "$SHA256_EXPECTED" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "Error: --sha256 must be 64 hex characters." >&2
    exit 1
  fi
  if [[ "${SHA256_EXPECTED,,}" != "${ENTRY_SHA,,}" ]]; then
    echo "Error: --sha256 does not match the signed manifest updater entry (${ENTRY_SHA})." >&2
    exit 1
  fi
fi

# `-version` must report the signed release identity "<version>+<buildId>",
# so a stale or foreign binary fails closed before install. The bootstrap
# binary runs on the target host: no executable means no verified identity,
# hence no install. The installed copy is NOT on PATH ($BINARY_DEST), so the
# source is checked here.
WANT_ID="${ENTRY_VERSION}+${ENTRY_BUILDID}"
if [[ ! -x "$BINARY_SRC" ]]; then
  echo "Error: ${BINARY_SRC} is not executable; cannot check -version against signed identity ${WANT_ID}." >&2
  echo "  Build it on this host: (cd packages/agent && go build -o <path> ./cmd/vps-updater)" >&2
  exit 1
fi
if ! UPD_VER="$("$BINARY_SRC" -version 2>&1)"; then
  echo "Error: ${BINARY_SRC} -version failed: ${UPD_VER}" >&2
  exit 1
fi
UPD_VER="${UPD_VER//$'\r'/}"
if [[ "$UPD_VER" != "$WANT_ID" ]]; then
  echo "Error: binary -version mismatch: got '${UPD_VER}', signed manifest says '${WANT_ID}'." >&2
  exit 1
fi
echo "[Install] Updater identity verified: ${UPD_VER} (release ${ENTRY_RELEASE})"

# Validate the updater config: required fields and the production invariants
# the updater itself enforces (https apiBase, fixed binary/state targets).
# node was already required above for manifest verification.
if ! CFG_ERR="$(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const k of ["apiBase", "credential", "pinnedPublicKey", "agentBinary", "stateDir"]) {
    if (typeof c[k] !== "string" || !c[k]) throw new Error(`missing ${k}`);
  }
  const api = new URL(c.apiBase);
  if (api.protocol !== "https:" || api.username || api.password) throw new Error("apiBase must be HTTPS without userinfo");
  if (!c.credential.startsWith("vma_")) throw new Error("credential must be a scoped vma_ bearer");
  if (c.agentBinary !== "/usr/local/bin/vps-manager-agent") throw new Error("agentBinary must be /usr/local/bin/vps-manager-agent");
  if ((c.agentUnit ?? "vps-manager-agent.service") !== "vps-manager-agent.service") throw new Error("agentUnit must be vps-manager-agent.service");
  if (c.stateDir !== "/var/lib/vps-updater") throw new Error("stateDir must be /var/lib/vps-updater");
  if ("allowedHosts" in c) throw new Error("allowedHosts is pinned in the binary");
  let raw;
  try { raw = Buffer.from(c.pinnedPublicKey, "base64"); } catch { throw new Error("pinnedPublicKey must be base64"); }
  if (raw.length !== 32) throw new Error(`pinnedPublicKey must decode to 32 bytes, got ${raw.length}`);
' "$CONFIG_SRC" 2>&1)"; then
  echo "Error: Config is not a valid updater config (see plan §5): ${CONFIG_SRC}" >&2
  printf '%s\n' "$CFG_ERR" | sed 's/^/  /' >&2
  exit 1
fi

# ── Install ───────────────────────────────────────────────────────────────

echo "[Install] Installing the local-agent updater..."

# User/group
if ! getent group "$SERVICE_USER" &>/dev/null; then
  run groupadd --system "$SERVICE_USER"
fi
if ! getent passwd "$SERVICE_USER" &>/dev/null; then
  run useradd --system --no-create-home --shell /sbin/nologin -g "$SERVICE_USER" "$SERVICE_USER"
fi

# Binary (directory not writable by the updater user: it cannot replace
# itself; only the fixed helper may touch /usr/local/bin/vps-manager-agent).
run mkdir -p "$(dirname "$BINARY_DEST")"
run cp -f "$BINARY_SRC" "$BINARY_DEST"
run chown root:root "$BINARY_DEST"
run chmod 0755 "$BINARY_DEST"

# Config
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would create ${CONFIG_DIR} (root:${SERVICE_USER} 0750)"
  echo "  [DRY-RUN] Would install ${CONFIG_SRC} -> ${CONFIG_FILE} (root:${SERVICE_USER} 0640)"
else
  mkdir -p "$CONFIG_DIR"
  chown root:"$SERVICE_USER" "$CONFIG_DIR"
  chmod 0750 "$CONFIG_DIR"
  if [[ "$CONFIG_SRC" != "$CONFIG_FILE" ]]; then
    cp -f "$CONFIG_SRC" "$CONFIG_FILE"
  fi
  chown root:"$SERVICE_USER" "$CONFIG_FILE"
  chmod 0640 "$CONFIG_FILE"
fi

# State layout. The privileged helper runs with an empty
# CapabilityBoundingSet (uid 0 only, no CAP_DAC_OVERRIDE), so every path it
# writes must be root-owned; the daemon-owned dirs are group-writable by
# vps-updater so root (as owner) and the daemon (as group) can both use them.
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would create ${STATE_DIR}/{pending,results,staging} (root:${SERVICE_USER} 0770)"
  echo "  [DRY-RUN] Would create ${STATE_DIR}/helper/{,backups} (root:root 0755)"
else
  mkdir -p "$STATE_DIR"
  chown root:"$SERVICE_USER" "$STATE_DIR"
  chmod 0770 "$STATE_DIR"
  for d in pending results staging; do
    mkdir -p "$STATE_DIR/$d"
    chown root:"$SERVICE_USER" "$STATE_DIR/$d"
    chmod 0770 "$STATE_DIR/$d"
  done
  mkdir -p "$STATE_DIR/helper/backups"
  chown -R root:root "$STATE_DIR/helper"
  chmod 0755 "$STATE_DIR/helper" "$STATE_DIR/helper/backups"
fi

# ── systemd units ─────────────────────────────────────────────────────────

DAEMON_UNIT_CONTENT=$(
  cat <<UNIT
[Unit]
Description=VPS Manager Local-Agent Updater (pull-only)
Documentation=https://github.com/sondoan17/vps-manager-nodejs
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=${BINARY_DEST} daemon -config ${CONFIG_FILE}
Restart=always
RestartSec=10

# Security hardening: outbound HTTPS only, no privileged socket, no access
# to agent config/tokens, Docker state, or the binary it must not replace.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${STATE_DIR}
ProtectHome=true
InaccessiblePaths=/etc/vps-manager-agent
CapabilityBoundingSet=
AmbientCapabilities=
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectClock=true
ProtectControlGroups=true
SystemCallFilter=@system-service
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
RemoveIPC=true

[Install]
WantedBy=multi-user.target
UNIT
)

PATH_UNIT_CONTENT=$(
  cat <<UNIT
[Unit]
Description=Watch vps-updater privileged action requests

[Path]
DirectoryNotEmpty=${STATE_DIR}/pending
Unit=vps-updater-apply.service

[Install]
WantedBy=multi-user.target
UNIT
)

HELPER_UNIT_CONTENT=$(
  cat <<UNIT
[Unit]
Description=VPS Manager updater privileged helper (fixed operations)

[Service]
Type=oneshot
User=root
Group=root
# FIXED ARGV. The daemon never passes commands, paths or units — the helper
# only learns <action>.<jobId> from ${STATE_DIR}/pending and re-verifies
# signature/hash/buildId itself before any swap.
ExecStart=${BINARY_DEST} helper -config ${CONFIG_FILE}
TimeoutStartSec=300s
UMask=0022

# Hardening: root uid but no capabilities (every path it writes is
# root-owned), no config/token visibility, no kernel/clock access.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${STATE_DIR} /usr/local/bin
ProtectHome=true
InaccessiblePaths=/etc/vps-manager-agent
CapabilityBoundingSet=
AmbientCapabilities=
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectClock=true
ProtectControlGroups=true
SystemCallFilter=@system-service
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
RemoveIPC=true
UNIT
)

write_unit() {
  local path="$1" content="$2"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would write systemd unit: ${path}"
    echo "---"
    echo "$content"
    echo "---"
  else
    printf '%s\n' "$content" > "$path"
    chmod 0644 "$path"
    echo "  Written systemd unit: ${path}"
  fi
}

write_unit "$UNIT_DAEMON" "$DAEMON_UNIT_CONTENT"
write_unit "$UNIT_PATH" "$PATH_UNIT_CONTENT"
write_unit "$UNIT_HELPER" "$HELPER_UNIT_CONTENT"

# Reload and enable (daemon restarted only — the agent is untouched).
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would run: systemctl daemon-reload"
  echo "  [DRY-RUN] Would run: systemctl enable --now vps-updater.service"
  echo "  [DRY-RUN] Would run: systemctl enable --now vps-updater-apply.path"
else
  systemctl daemon-reload
  systemctl enable --now vps-updater.service
  systemctl enable --now vps-updater-apply.path
  echo "  Started vps-updater.service and vps-updater-apply.path (enabled on boot)"
fi

echo ""
echo "[Install] Local-agent updater installed."
echo "  Binary:   ${BINARY_DEST}"
echo "  Config:   ${CONFIG_FILE}"
echo "  State:    ${STATE_DIR}"
echo "  Service:  vps-updater.service  (pull-only daemon, user ${SERVICE_USER})"
echo "  Trigger:  vps-updater-apply.path -> vps-updater-apply.service (root, fixed argv)"
echo ""
echo "Check status: sudo ${BINARY_DEST} status -config ${CONFIG_FILE}"
echo "Ack a hold:   sudo ${BINARY_DEST} ack -config ${CONFIG_FILE}"
echo "View logs:    sudo journalctl -u vps-updater.service -f"
echo "Runbook:      docs/local-agent-upgrade-plan.md"
