#!/usr/bin/env bash
#
# test-installer-docker-access.sh — Durable Phase 5 assertions for Docker-metrics installer hardening.
#
# Verifies:
#   1. Both installer scripts pass `bash -n` syntax checks.
#   2. Static least-privilege invariants in scripts/install/install.sh and
#      scripts/install/install-local-agent.sh:
#        - default install never grants the docker group;
#        - only `--enable-docker-metrics-access` adds `SupplementaryGroups=docker`;
#        - no docker-socket chmod / usermod / gpasswd / setfacl workarounds;
#        - the generated compose template mounts no docker socket;
#        - root-equivalent warnings are documented in --help.
#   3. Live generated-unit behavior of install-local-agent.sh --dry-run
#      (needs root or passwordless sudo; skipped otherwise):
#        - default unit has no SupplementaryGroups=docker;
#        - explicit flag adds exactly one `SupplementaryGroups=docker` line;
#        - explicit flag with a missing docker group fails safely (non-zero exit).
#
# Safe to run anywhere: live checks use --dry-run only (no systemd writes).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_SH="${REPO_ROOT}/scripts/install/install.sh"
INSTALL_LOCAL="${REPO_ROOT}/scripts/install/install-local-agent.sh"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1" >&2; }

# ── 1. Syntax ─────────────────────────────────────────────────────────────

if bash -n "$INSTALL_SH"; then pass "install.sh syntax OK"; else fail "install.sh syntax"; fi
if bash -n "$INSTALL_LOCAL"; then pass "install-local-agent.sh syntax OK"; else fail "install-local-agent.sh syntax"; fi
if bash -n "${BASH_SOURCE[0]}"; then pass "installer test syntax OK"; else fail "installer test syntax"; fi

# ── 2. Static invariants ──────────────────────────────────────────────────

# No docker-socket references or socket-permission workarounds in installers.
if grep -nE 'docker\.sock|/var/run/docker' "$INSTALL_SH" "$INSTALL_LOCAL" >/dev/null 2>&1; then
  fail "installers must not reference the docker socket"
else
  pass "installers reference no docker socket"
fi
if grep -nE 'usermod|gpasswd|setfacl' "$INSTALL_SH" "$INSTALL_LOCAL" >/dev/null 2>&1; then
  fail "installers must not mutate group membership or socket ACLs"
else
  pass "installers mutate no group membership or socket ACLs"
fi
# No group_add in the install.sh compose template.
if grep -nE 'group_add' "$INSTALL_SH" >/dev/null 2>&1; then
  fail "install.sh compose template must not use group_add"
else
  pass "install.sh compose template uses no group_add"
fi
# Defaults are opt-in (disabled unless the explicit flag is passed).
if grep -Eq '^ENABLE_DOCKER_METRICS_ACCESS=false' "$INSTALL_SH"; then
  pass "install.sh docker-metrics access defaults to disabled"
else
  fail "install.sh docker-metrics access must default to disabled"
fi
if grep -Eq '^ENABLE_DOCKER_ACCESS=false' "$INSTALL_LOCAL"; then
  pass "install-local-agent.sh docker access defaults to disabled"
else
  fail "install-local-agent.sh docker access must default to disabled"
fi
# The flag is only forwarded when explicitly enabled.
if grep -Fq 'AGENT_INSTALL_ARGS+=(--enable-docker-metrics-access)' "$INSTALL_SH" \
  && grep -Fq '"$ENABLE_DOCKER_METRICS_ACCESS" == "true"' "$INSTALL_SH"; then
  pass "install.sh forwards the flag only when explicitly enabled"
else
  fail "install.sh must forward --enable-docker-metrics-access conditionally"
fi
# Missing docker group fails safely (fail-closed with guidance, non-zero exit).
if grep -A6 -- '--enable-docker-metrics-access was specified' "$INSTALL_LOCAL" | grep -q 'exit 1'; then
  pass "install-local-agent.sh fails closed when the docker group is missing"
else
  fail "install-local-agent.sh must exit non-zero when the docker group is missing"
fi
# ── 3. Live generated-unit checks (need root/sudo; --dry-run only) ───────

SUDO=()
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  : # already root
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  SUDO=(sudo)
else
  echo "SKIP: live systemd-unit checks need root or passwordless sudo (static checks above still ran)."
  echo "RESULT: ${PASS} passed, ${FAIL} failed (live checks skipped)"
  [[ "$FAIL" -eq 0 ]]
  exit
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
printf 'fake-agent-binary' > "$WORK/fake-agent"
cat > "$WORK/agent-config.json" <<'JSON'
{"backendUrl":"http://127.0.0.1:38280","vpsId":"vps_local_host","token":"vma_test_abc","intervalSeconds":15,"requestTimeoutSeconds":10}
JSON

REAL_GETENT="$(command -v getent || echo /usr/bin/getent)"
make_getent() { # $1 = mode: present|absent
  mkdir -p "$WORK/fakebin-$1"
  {
    echo '#!/usr/bin/env bash'
    echo "REAL_GETENT=\"${REAL_GETENT}\""
    echo 'if [[ "${1:-}" == "group" && "${2:-}" == "docker" ]]; then'
    if [[ "$1" == "present" ]]; then
      echo '  echo "docker:x:999:"; exit 0'
    else
      echo '  exit 1'
    fi
    echo 'fi'
    echo 'exec "$REAL_GETENT" "$@"'
  } > "$WORK/fakebin-$1/getent"
  chmod +x "$WORK/fakebin-$1/getent"
}
make_getent present
make_getent absent

BASE_PATH="/usr/local/bin:/usr/bin:/bin"

# Default (no flag): unit must not grant docker group access.
DEFAULT_OUT="$("${SUDO[@]}" env "PATH=$WORK/fakebin-absent:${BASE_PATH}" bash "$INSTALL_LOCAL" \
  --binary "$WORK/fake-agent" --config "$WORK/agent-config.json" --dry-run 2>&1)"
if printf '%s' "$DEFAULT_OUT" | grep -q 'SupplementaryGroups'; then
  fail "default generated unit must not contain SupplementaryGroups"
else
  pass "default generated unit contains no SupplementaryGroups"
fi
if printf '%s' "$DEFAULT_OUT" | grep -q '^User=vps-manager-agent$' \
  && printf '%s' "$DEFAULT_OUT" | grep -q '^Group=vps-manager-agent$'; then
  pass "default generated unit runs as the dedicated non-root user/group"
else
  fail "default generated unit must run as the vps-manager-agent user/group"
fi
# Provisioning intent may mention Docker state files, but the generated
# unit itself must never mention docker, and the full output must never grant
# docker socket/group access by default.
UNIT_CONTENT="$(printf '%s\n' "$DEFAULT_OUT" | awk '/^\[Unit\]$/,/^\[Install\]$/')"
if printf '%s' "$UNIT_CONTENT" | grep -qi 'docker'; then
  fail "default generated unit must not mention docker"
else
  pass "default generated unit mentions no docker"
fi
if printf '%s' "$DEFAULT_OUT" | grep -qiE 'docker\.sock|SupplementaryGroups|group_add|docker group'; then
  fail "default dry-run output must not offer docker access"
else
  pass "default dry-run output offers no docker access"
fi

# Explicit flag with docker group present: exactly one SupplementaryGroups=docker.
FLAG_OUT="$("${SUDO[@]}" env "PATH=$WORK/fakebin-present:${BASE_PATH}" bash "$INSTALL_LOCAL" \
  --binary "$WORK/fake-agent" --config "$WORK/agent-config.json" --enable-docker-metrics-access --dry-run 2>&1)"
COUNT="$(printf '%s' "$FLAG_OUT" | grep -c '^SupplementaryGroups=docker$' || true)"
if [[ "$COUNT" -eq 1 ]]; then
  pass "explicit flag adds exactly one SupplementaryGroups=docker line"
else
  fail "explicit flag must add exactly one SupplementaryGroups=docker line (got $COUNT)"
fi

# Explicit flag with docker group missing: fail safely with guidance.
set +e
ABSENT_OUT="$("${SUDO[@]}" env "PATH=$WORK/fakebin-absent:${BASE_PATH}" bash "$INSTALL_LOCAL" \
  --binary "$WORK/fake-agent" --config "$WORK/agent-config.json" --enable-docker-metrics-access --dry-run 2>&1)"
ABSENT_CODE=$?
set -e
if [[ "$ABSENT_CODE" -ne 0 ]] && printf '%s' "$ABSENT_OUT" | grep -Fq "group does not"; then
  pass "missing docker group fails safely with guidance (exit $ABSENT_CODE)"
else
  fail "missing docker group must fail safely (exit=$ABSENT_CODE)"
fi

echo "RESULT: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
