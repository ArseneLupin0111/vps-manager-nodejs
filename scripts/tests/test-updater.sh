#!/usr/bin/env bash
# shellcheck disable=SC2317
#
# test-updater.sh — Durable assertions for the local-agent updater slice
# (scripts/install-updater.sh + packages/agent/internal/updater +
# packages/agent/cmd/vps-updater).
#
# Verifies:
#   1. Syntax: install-updater.sh, install-local-agent.sh, install.sh and
#      this test pass `bash -n`.
#   2. Static invariants in install-updater.sh:
#        - set -euo pipefail, umask 077, root check (dry-run exempt);
#        - fixed paths (binary/state/config) and dedicated vps-updater user;
#        - mandatory signed manifest + pinned public key verified offline
#          via scripts/release/verify-manifest.mjs before any install step;
#        - exact component:"updater"/os/arch entry selection, then binary
#          size/SHA-256/-version identity compared to that signed entry;
#        - mandatory node config validation enforcing https apiBase, fixed
#          agentBinary/agentUnit/stateDir, 32-byte pinned key, no allowlist;
#        - three units: daemon (unprivileged + hardening), .path trigger,
#          root oneshot helper with FIXED argv and empty capability set;
#        - no sudoers/polkit, no Docker socket, agent config blocked;
#        - uninstall preserves state unless --purge-state; full binary path
#          in the operations footer.
#   3. Live `--help` and behavioral `--dry-run` rejection checks
#      (unprivileged): unsigned binary, standalone hash, missing manifest,
#      missing/ambiguous key source, and invalid manifest fail closed.
#   4. Scoped Go verification: vet + tests for internal/updater and
#      internal/config, plus a GOOS=linux build of cmd/vps-updater.
#
# Safe to run anywhere: live checks use --help/--dry-run only (no systemd
# writes); does not require root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_UPDATER="${REPO_ROOT}/scripts/install-updater.sh"
INSTALL_LOCAL="${REPO_ROOT}/scripts/install-local-agent.sh"
INSTALL_SH="${REPO_ROOT}/scripts/install.sh"
AGENT_DIR="${REPO_ROOT}/packages/agent"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1" >&2; }

# ── 1. Syntax ─────────────────────────────────────────────────────────────

for f in "$INSTALL_UPDATER" "$INSTALL_LOCAL" "$INSTALL_SH" "${BASH_SOURCE[0]}"; do
  if bash -n "$f"; then pass "$(basename "$f") syntax OK"; else fail "$(basename "$f") syntax"; fi
done

# ── 2. Static invariants ──────────────────────────────────────────────────

# Hardening preamble
if grep -Fq 'set -euo pipefail' "$INSTALL_UPDATER" \
  && grep -Fq 'umask 077' "$INSTALL_UPDATER"; then
  pass "install-updater.sh uses set -euo pipefail + umask 077"
else
  fail "install-updater.sh must set -euo pipefail and umask 077"
fi

if grep -Fq 'if [[ $EUID -ne 0 && "$DRY_RUN" != "true" ]]' "$INSTALL_UPDATER"; then
  pass "install-updater.sh requires root (dry-run exempt)"
else
  fail "install-updater.sh must refuse non-root unless --dry-run"
fi

# Fixed paths and dedicated user
if grep -Fq 'BINARY_DEST="/usr/local/lib/vps-manager-agent/vps-updater"' "$INSTALL_UPDATER" \
  && grep -Fq 'STATE_DIR="/var/lib/vps-updater"' "$INSTALL_UPDATER" \
  && grep -Fq 'CONFIG_DIR="/etc/vps-updater"' "$INSTALL_UPDATER" \
  && grep -Fq 'SERVICE_USER="vps-updater"' "$INSTALL_UPDATER"; then
  pass "install-updater.sh uses fixed paths and a dedicated vps-updater user"
else
  fail "install-updater.sh must fix binary/state/config paths and use user vps-updater"
fi

# Signed bootstrap: mandatory signed manifest + pinned key, offline verify
if grep -Fq 'MANIFEST_SRC=""' "$INSTALL_UPDATER" \
  && grep -Fq -- '--manifest <path> is required (the signed release manifest)' "$INSTALL_UPDATER" \
  && grep -Fq 'release/verify-manifest.mjs' "$INSTALL_UPDATER" \
  && grep -Fq 'exactly one of --pubkey, --pubkey-file, --pubkey-env is required with --manifest' "$INSTALL_UPDATER" \
  && grep -Fq 'signed manifest verification failed' "$INSTALL_UPDATER"; then
  pass "install-updater.sh requires a signed manifest verified offline against a pinned key"
else
  fail "install-updater.sh must require --manifest + one pubkey source verified via verify-manifest.mjs"
fi

# Exact updater entry + size/SHA-256/-version identity gates before install
if grep -Fq 'a.component === "updater" && a.os === os && a.arch === arch' "$INSTALL_UPDATER" \
  && grep -Fq 'binary size mismatch' "$INSTALL_UPDATER" \
  && grep -Fq 'binary SHA-256 mismatch' "$INSTALL_UPDATER" \
  && grep -Fq 'binary -version mismatch' "$INSTALL_UPDATER" \
  && grep -Fq 'WANT_ID="${ENTRY_VERSION}+${ENTRY_BUILDID}"' "$INSTALL_UPDATER"; then
  pass "install-updater.sh selects the exact updater entry and gates size/SHA/-version"
else
  fail "install-updater.sh must gate install on exact entry selection + size/SHA/-version"
fi

# --sha256 is optional and only ever cross-checked against the signed entry
if grep -Fq 'SHA256_EXPECTED=""' "$INSTALL_UPDATER" \
  && grep -Fq 'does not match the signed manifest updater entry' "$INSTALL_UPDATER"; then
  pass "--sha256 cross-checks the signed entry (never a standalone trust source)"
else
  fail "--sha256 must be cross-checked against the signed manifest entry"
fi

# Mandatory node config validation with production invariants
if grep -Fq 'node is required to validate the updater config' "$INSTALL_UPDATER"; then
  pass "install-updater.sh fails closed without node"
else
  fail "install-updater.sh must fail when node is missing (no skipped validation)"
fi
if grep -Fq 'apiBase must be HTTPS without userinfo' "$INSTALL_UPDATER" \
  && grep -Fq 'agentBinary must be /usr/local/bin/vps-manager-agent' "$INSTALL_UPDATER" \
  && grep -Fq 'stateDir must be /var/lib/vps-updater' "$INSTALL_UPDATER" \
  && grep -Fq 'must decode to 32 bytes' "$INSTALL_UPDATER" \
  && grep -Fq 'allowedHosts is pinned in the binary' "$INSTALL_UPDATER"; then
  pass "config gate enforces https, fixed targets, 32-byte key, pinned allowlist"
else
  fail "config gate must enforce https/fixed agentBinary/fixed stateDir/32-byte key/no allowlist override"
fi

# Three units with the expected names
if grep -Fq 'UNIT_DAEMON="/etc/systemd/system/vps-updater.service"' "$INSTALL_UPDATER" \
  && grep -Fq 'UNIT_PATH="/etc/systemd/system/vps-updater-apply.path"' "$INSTALL_UPDATER" \
  && grep -Fq 'UNIT_HELPER="/etc/systemd/system/vps-updater-apply.service"' "$INSTALL_UPDATER"; then
  pass "three systemd units are defined (service + path + apply service)"
else
  fail "install-updater.sh must define daemon, .path and root helper units"
fi

# Daemon unit hardening
if grep -Fq 'User=${SERVICE_USER}' "$INSTALL_UPDATER" \
  && grep -Fq 'NoNewPrivileges=true' "$INSTALL_UPDATER" \
  && grep -Fq 'ProtectSystem=strict' "$INSTALL_UPDATER" \
  && grep -Fq 'InaccessiblePaths=/etc/vps-manager-agent' "$INSTALL_UPDATER" \
  && grep -Fq 'ReadWritePaths=${STATE_DIR}' "$INSTALL_UPDATER"; then
  pass "daemon unit runs unprivileged with hardening and agent-config isolation"
else
  fail "daemon unit must harden (NoNewPrivileges/ProtectSystem/InaccessiblePaths/ReadWritePaths)"
fi

# Empty capability bounding set on both units (root helper without caps)
CAP_SETS="$(grep -c 'CapabilityBoundingSet=$' "$INSTALL_UPDATER" || true)"
if [[ "$CAP_SETS" -ge 2 ]]; then
  pass "both units set an empty CapabilityBoundingSet ($CAP_SETS occurrences)"
else
  fail "daemon and helper units must both set empty CapabilityBoundingSet (found $CAP_SETS)"
fi

# Helper unit: fixed argv, root, no daemon-supplied args
if grep -Fq 'ExecStart=${BINARY_DEST} helper -config ${CONFIG_FILE}' "$INSTALL_UPDATER" \
  && grep -Fq 'User=root' "$INSTALL_UPDATER"; then
  pass "helper unit uses fixed argv (helper -config) as root"
else
  fail "helper ExecStart must be fixed argv 'helper -config' as root"
fi
if grep -n 'ExecStart=${BINARY_DEST} helper' "$INSTALL_UPDATER" | grep -q '\$2\|\$@\|${1}'; then
  fail "helper ExecStart must not interpolate daemon input"
else
  pass "helper ExecStart takes no daemon-supplied arguments"
fi

# Path unit trigger
if grep -Fq 'DirectoryNotEmpty=${STATE_DIR}/pending' "$INSTALL_UPDATER" \
  && grep -Fq 'Unit=vps-updater-apply.service' "$INSTALL_UPDATER"; then
  pass "path unit watches pending/ and triggers the root helper"
else
  fail "path unit must watch ${STATE_DIR}/pending and trigger vps-updater-apply.service"
fi

# Never touch the running agent config; no privileged escalation channels
if grep -Eq 'sudoers|polkit|pkexec|docker\.sock' "$INSTALL_UPDATER"; then
  fail "install-updater.sh must not reference sudoers/polkit/pkexec/docker.sock"
else
  pass "no sudoers/polkit/pkexec/docker.sock in install-updater.sh"
fi

# Uninstall safety: state preserved unless --purge-state
if grep -Fq 'Preserved ${STATE_DIR}' "$INSTALL_UPDATER" \
  && grep -Fq 'PURGE_STATE' "$INSTALL_UPDATER"; then
  pass "uninstall preserves state journals/backups unless --purge-state"
else
  fail "uninstall must preserve ${STATE_DIR} unless --purge-state"
fi

# Operations footer uses the full installed path (binary is not on PATH)
if grep -Fq 'sudo ${BINARY_DEST} status -config ${CONFIG_FILE}' "$INSTALL_UPDATER" \
  && grep -Fq 'sudo ${BINARY_DEST} ack -config ${CONFIG_FILE}' "$INSTALL_UPDATER"; then
  pass "operations footer prints full installed binary path (status/ack)"
else
  fail "operations commands must use the full ${BINARY_DEST} path"
fi

# Go invariants: production invariants live in LoadConfig, test-only escape
CFG="${AGENT_DIR}/internal/updater/config.go"
if grep -Fq 'func (c *Config) EnableTestOverrides()' "$CFG" \
  && grep -Fq 'testMode bool' "$CFG" \
  && grep -Fq 'stateDir must be /var/lib/vps-updater' "$CFG" \
  && grep -Fq 'got %d bytes' "$CFG"; then
  pass "updater config.go enforces fixed stateDir/32-byte key with in-process test gate"
else
  fail "config.go must enforce fixed stateDir + 32-byte key, gated by unexported testMode"
fi
if grep -Fq 'allowedHosts cannot be overridden in production' "$CFG"; then
  pass "config.go pins the download allowlist in production"
else
  fail "config.go must reject allowedHosts overrides outside the test harness"
fi
if grep -Fq 'isLoopbackHost' "${AGENT_DIR}/internal/config/config.go" \
  && grep -Fq 'http is only allowed for loopback' "${AGENT_DIR}/internal/config/config.go"; then
  pass "agent config.go rejects non-loopback http backendUrl"
else
  fail "agent config.go must allow http only for loopback hosts"
fi

# Runbook hooks: installers point at the updater bootstrap / offline runbook
if grep -Fq 'install-updater.sh' "$INSTALL_LOCAL" || grep -Fq 'install-updater.sh' "$INSTALL_SH"; then
  pass "installer runbook references the updater bootstrap"
else
  fail "install-local-agent.sh/install.sh must reference scripts/install-updater.sh"
fi

# ── 3. Live --help and --dry-run (unprivileged) ───────────────────────────

if OUT="$("$INSTALL_UPDATER" --help 2>&1)"; then
  if printf '%s' "$OUT" | grep -Fq -- '--manifest' \
    && printf '%s' "$OUT" | grep -Fq -- '--pubkey-file'; then
    pass "--help documents --manifest and pinned-key options"
  else
    fail "--help must document --manifest and --pubkey-file"
  fi
else
  fail "--help must exit 0"
fi

# Unprivileged install refuses before any write; dry-run still verifies trust.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
printf 'not-a-real-binary' > "$WORK/vps-updater"
if ERR="$("$INSTALL_UPDATER" --binary "$WORK/vps-updater" --config "$WORK/missing.json" 2>&1)"; then
  fail "install without --config must fail"
else
  if printf '%s' "$ERR" | grep -Fq 'must be run as root'; then
    pass "install without root and without --dry-run is refused"
  else
    fail "non-root install must be refused before other checks"
  fi
fi

# Dry-run: valid fixed-path config, must print the unit bodies.
if command -v node &>/dev/null && command -v sha256sum &>/dev/null; then
  PUBKEY_B64="$(node -e 'console.log(Buffer.alloc(32, 7).toString("base64"))')"
  cat > "$WORK/config.json" <<JSON
{
  "apiBase": "https://api.example.com",
  "credential": "vma_bootstrap_local_updater_secret",
  "pinnedPublicKey": "${PUBKEY_B64}",
  "agentBinary": "/usr/local/bin/vps-manager-agent",
  "agentUnit": "vps-manager-agent.service",
  "stateDir": "/var/lib/vps-updater"
}
JSON
  SHA256_REAL="$(sha256sum "$WORK/vps-updater" | awk '{print $1}')"
  if OUT="$("$INSTALL_UPDATER" --dry-run --binary "$WORK/vps-updater" --config "$WORK/config.json" 2>&1)"; then
    fail "--dry-run without signed manifest must fail"
  elif printf '%s' "$OUT" | grep -Fq -- '--manifest <path> is required'; then
    pass "--dry-run refuses an unsigned binary"
  else
    fail "--dry-run must require a signed manifest: $OUT"
  fi
  if OUT="$("$INSTALL_UPDATER" --dry-run --binary "$WORK/vps-updater" --config "$WORK/config.json" --sha256 "$SHA256_REAL" 2>&1)"; then
    fail "--sha256 alone must not authorize install"
  elif printf '%s' "$OUT" | grep -Fq -- '--manifest <path> is required'; then
    pass "matching standalone hash cannot bypass manifest gate"
  else
    fail "hash-only install must require manifest: $OUT"
  fi
  if OUT="$("$INSTALL_UPDATER" --dry-run --binary "$WORK/vps-updater" --config "$WORK/config.json" --manifest "$WORK/missing.json" --pubkey "$PUBKEY_B64" 2>&1)"; then
    fail "missing signed manifest must fail"
  elif printf '%s' "$OUT" | grep -Fq 'Manifest not found'; then
    pass "missing signed manifest is refused"
  else
    fail "missing manifest must be reported: $OUT"
  fi
  if OUT="$("$INSTALL_UPDATER" --dry-run --binary "$WORK/vps-updater" --config "$WORK/config.json" --manifest "$WORK/config.json" 2>&1)"; then
    fail "manifest without pinned key must fail"
  elif printf '%s' "$OUT" | grep -Fq 'exactly one of --pubkey'; then
    pass "manifest requires exactly one pinned key source"
  else
    fail "missing pinned key must be reported: $OUT"
  fi
  if OUT="$("$INSTALL_UPDATER" --dry-run --binary "$WORK/vps-updater" --config "$WORK/config.json" --manifest "$WORK/config.json" --pubkey "$PUBKEY_B64" 2>&1)"; then
    fail "invalid signature must fail"
  elif printf '%s' "$OUT" | grep -Fq 'signed manifest verification failed'; then
    pass "invalid signed manifest is refused before install"
  else
    fail "invalid signature must be reported: $OUT"
  fi
  if OUT="$("$INSTALL_UPDATER" --dry-run --binary "$WORK/vps-updater" --config "$WORK/config.json" --manifest "$WORK/config.json" --pubkey "$PUBKEY_B64" --pubkey-file "$WORK/config.json" 2>&1)"; then
    fail "multiple key sources must fail"
  elif printf '%s' "$OUT" | grep -Fq 'exactly one of --pubkey'; then
    pass "ambiguous pinned key sources are refused"
  else
    fail "multiple key sources must be reported: $OUT"
  fi
else
  fail "node/sha256sum unavailable for dry-run smoke"
fi

# ── 4. Scoped Go verification ─────────────────────────────────────────────

if command -v go &>/dev/null; then
  if (cd "$AGENT_DIR" && go vet ./internal/updater/ ./internal/config/ ./cmd/vps-updater/); then
    pass "go vet updater + config + cmd"
  else
    fail "go vet"
  fi
  if (cd "$AGENT_DIR" && go test ./internal/updater/ ./internal/config/ -count=1 >/dev/null 2>&1); then
    pass "go test internal/updater + internal/config"
  else
    fail "go test internal/updater + internal/config"
  fi
  if (cd "$AGENT_DIR" && GOOS=linux GOARCH=amd64 go build ./cmd/vps-updater/ ./internal/updater/); then
    pass "GOOS=linux GOARCH=amd64 build of cmd/vps-updater"
    rm -f "$AGENT_DIR/vps-updater" 2>/dev/null || true
  else
    fail "linux/amd64 build of cmd/vps-updater"
  fi
else
  fail "go toolchain unavailable for scoped verification"
fi

# ── Summary ───────────────────────────────────────────────────────────────

echo ""
echo "${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
echo "ALL_OK"
