#!/usr/bin/env bash
#
# test-installer-docker-state.sh — Durable assertions for Docker state
# provisioning in the managed agent install/upgrade paths.
#
# Verifies:
#   1. Both installer scripts pass `bash -n` syntax checks.
#   2. Static invariants in scripts/install/install-local-agent.sh:
#        - the identity-loss guard refuses to rotate an existing identity;
#        - an existing runtime-keys owner outside {root, service uid} fails closed;
#        - provisioning runs with a computed owner uid, then ownership is
#          enforced (identity root:root 0600, runtime keys service 0600), then a
#          verification pass runs with the service uid;
#        - every provisioning failure path exits non-zero before the unit is
#          written or systemctl is invoked (fail closed before service start);
#        - the dry-run branch states the provisioning intent;
#        - install.sh delegates to install-local-agent.sh (inherits provisioning).
#   3. Live --dry-run output mentions the Docker state provisioning intent
#      (needs root or passwordless sudo; skipped otherwise).
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

# Identity-loss guard: runtime keys without identity must fail closed with
# guidance instead of rotating the existing installation identity.
if grep -Fq 'exists without' "$INSTALL_LOCAL" \
  && grep -Fq 'Refusing to rotate an existing Docker installation identity' "$INSTALL_LOCAL"; then
  pass "install-local-agent.sh refuses to rotate an existing identity"
else
  fail "install-local-agent.sh must fail closed when runtime keys exist without identity"
fi

# Foreign runtime-keys owner must be refused before any provision call.
if grep -Fq 'Refusing to touch Docker runtime keys owned by another user' "$INSTALL_LOCAL"; then
  pass "install-local-agent.sh refuses foreign-owned runtime keys"
else
  fail "install-local-agent.sh must refuse runtime keys owned by another uid"
fi

# Owner selection: root for fresh/legacy state, service uid for service-owned
# state (upgrade keeps its owner — no rotation).
if grep -Fq 'PROVISION_OWNER_UID=0' "$INSTALL_LOCAL" \
  && grep -Eq '0\|"\$SERVICE_UID"\)' "$INSTALL_LOCAL" \
  && grep -Fq 'stat -c %u "$DOCKER_RUNTIME_KEYS_FILE"' "$INSTALL_LOCAL"; then
  pass "install-local-agent.sh selects the provisioning owner from existing state"
else
  fail "install-local-agent.sh must provision with owner 0 or the service uid"
fi

# Exactly the ownership the agent validates: identity root:root 0600,
# runtime keys service-owned 0600, enforced AFTER the first provision call
# and BEFORE the verification pass.
PROVISION_LINE_NOS="$(grep -n -- '-provision-docker-state' "$INSTALL_LOCAL" | cut -d: -f1)"
IDENTITY_CHOWN_LINE="$(grep -n 'chown root:root "$DOCKER_IDENTITY_FILE"' "$INSTALL_LOCAL" | cut -d: -f1 | head -n1)"
RUNTIME_CHOWN_LINE="$(grep -n 'chown "${SERVICE_USER}:${SERVICE_USER}" "$DOCKER_RUNTIME_KEYS_FILE"' "$INSTALL_LOCAL" | cut -d: -f1 | head -n1)"
UNIT_LINE="$(grep -n 'Write systemd unit' "$INSTALL_LOCAL" | cut -d: -f1 | head -n1)"
FIRST_PROVISION_LINE="$(printf '%s\n' "$PROVISION_LINE_NOS" | head -n1)"
LAST_PROVISION_LINE="$(printf '%s\n' "$PROVISION_LINE_NOS" | tail -n1)"
if [[ -n "$IDENTITY_CHOWN_LINE" && -n "$RUNTIME_CHOWN_LINE" \
  && "$FIRST_PROVISION_LINE" -lt "$IDENTITY_CHOWN_LINE" \
  && "$IDENTITY_CHOWN_LINE" -lt "$RUNTIME_CHOWN_LINE" \
  && "$RUNTIME_CHOWN_LINE" -lt "$LAST_PROVISION_LINE" ]]; then
  pass "ownership is enforced between the initial provision and verification pass"
else
  fail "install-local-agent.sh must enforce identity/runtime ownership after provisioning (first=$FIRST_PROVISION_LINE identity=$IDENTITY_CHOWN_LINE runtime=$RUNTIME_CHOWN_LINE last=$LAST_PROVISION_LINE)"
fi

# Exactly two provision calls: create/validate with the selected owner, then
# verify with the service uid (the validation the agent performs).
PROVISION_COUNT="$(grep -c -- '-provision-docker-state' "$INSTALL_LOCAL" || true)"
if [[ "$PROVISION_COUNT" -eq 2 ]] && grep -Fq -- '-docker-runtime-owner-uid "$SERVICE_UID"' "$INSTALL_LOCAL"; then
  pass "install-local-agent.sh provisions once then verifies with the service uid"
else
  fail "install-local-agent.sh must run exactly two provision calls (got $PROVISION_COUNT)"
fi

# Fail closed before service start: every provision failure exits 1, and both
# provision calls occur before the unit write and any systemctl invocation on
# the install path (uninstall/systemctl references before the unit write are
# excluded).
if grep -Fq 'Docker state provisioning failed; not starting the service' "$INSTALL_LOCAL" \
  && grep -Fq 'Docker state verification failed; not starting the service' "$INSTALL_LOCAL"; then
  pass "install-local-agent.sh fails closed with an explicit message on provisioning errors"
else
  fail "install-local-agent.sh must exit non-zero with a message on provisioning errors"
fi
SYSTEMCTL_LINE="$(grep -nE 'systemctl (daemon-reload|enable|restart|start)' "$INSTALL_LOCAL" \
  | awk -F: -v u="$UNIT_LINE" '$1 > u' | head -n1 | cut -d: -f1)"
if [[ -n "$SYSTEMCTL_LINE" && "$LAST_PROVISION_LINE" -lt "$SYSTEMCTL_LINE" && "$LAST_PROVISION_LINE" -lt "$UNIT_LINE" ]]; then
  pass "provisioning completes before the unit is written and systemctl runs"
else
  fail "provisioning must finish before unit write/service start (last provision=$LAST_PROVISION_LINE unit=$UNIT_LINE systemctl=$SYSTEMCTL_LINE)"
fi

# Dry-run states the provisioning intent.
if grep -Fq '[DRY-RUN] Would ensure Docker state' "$INSTALL_LOCAL" \
  && grep -Fq 'without rotating an existing identity' "$INSTALL_LOCAL"; then
  pass "install-local-agent.sh dry-run announces Docker state provisioning"
else
  fail "install-local-agent.sh --dry-run must announce Docker state provisioning"
fi

# install.sh delegates the local install (and therefore provisioning) to
# install-local-agent.sh.
if grep -Fq 'install-local-agent.sh' "$INSTALL_SH"; then
  pass "install.sh delegates to install-local-agent.sh"
else
  fail "install.sh must delegate to install-local-agent.sh"
fi

# ── 3. Live dry-run output (needs root/sudo; skipped otherwise) ───────────

SUDO=()
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  : # already root
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  SUDO=(sudo)
else
  echo "SKIP: live dry-run checks need root or passwordless sudo (static checks above still ran)."
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

DRY_OUT="$("${SUDO[@]}" bash "$INSTALL_LOCAL" \
  --binary "$WORK/fake-agent" --config "$WORK/agent-config.json" --dry-run 2>&1)"
if printf '%s' "$DRY_OUT" | grep -q 'Would ensure Docker state'; then
  pass "dry-run output announces Docker state provisioning intent"
else
  fail "dry-run output must announce Docker state provisioning intent"
fi
if printf '%s' "$DRY_OUT" | grep -q 'docker-identity.json (root:root 0600)' \
  && printf '%s' "$DRY_OUT" | grep -q 'runtime-keys.json (vps-manager-agent:vps-manager-agent 0600)'; then
  pass "dry-run output states identity/runtime ownership and mode"
else
  fail "dry-run output must state identity root:root 0600 and runtime keys service-owned 0600"
fi

echo "RESULT: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
