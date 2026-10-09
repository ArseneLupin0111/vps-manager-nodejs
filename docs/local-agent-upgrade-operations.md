# Local agent upgrades: operator runbook

The dashboard's local-agent update status compares a fresh agent heartbeat/build ID with a signed stable-channel release. API/web deployment does **not** update the host systemd agent. The API container must not receive a Docker socket, systemd socket, root filesystem mount, or host root credentials. Remote SSH agent upgrades remain a separate workflow.

## Release and trust bootstrap

The protected `release` GitHub Actions environment must require review and store `AGENT_RELEASE_SIGNING_KEY` (Ed25519 PKCS#8 private key). The key must never enter the repository, API image, browser or host logs. Run `.github/workflows/release-agent.yml` manually for a reviewed commit; the workflow builds Linux/amd64 agent and updater binaries with the same immutable SHA build ID, verifies both identities, signs the canonical manifest, publishes immutable release assets, then updates the stable channel pointer. The API and updater must be configured with the corresponding raw 32-byte Ed25519 public key (base64). Configure the API catalog pointer URL and trusted key as specified by `packages/api/src/release/release-config.ts`; restrict egress to the release allowlist. A missing/invalid pointer, signature, compatibility match, architecture artifact or fresh heartbeat must remain unavailable, not silently fall back to `latest`.

The release manifest has distinct `component: "agent"` and `component: "updater"` artifacts. Verify the signed manifest offline against the pinned public key before touching any binary (no network needed; exit 0 means the Ed25519 signature, structure and pinned key all match):

```bash
node scripts/release/verify-manifest.mjs \
  --manifest /path/to/manifest.json \
  --pubkey-env AGENT_RELEASE_PUBLIC_KEY
# also accepted: --pubkey-file /path/to/release-pub.b64  |  --pubkey <base64-raw-32B>
```

Bootstrap `vps-updater` from the **updater** entry. The installer itself requires the signed manifest plus exactly one of `--pubkey` / `--pubkey-file` / `--pubkey-env`, verifies the signature with `scripts/release/verify-manifest.mjs`, and selects the exact `component: "updater"` / `os` / `arch` entry — it fails closed if that entry is missing or duplicated:

```bash
sudo ./scripts/install/install-updater.sh \
  --binary ./vps-updater-linux-amd64 \
  --config ./updater-config.json \
  --manifest ./manifest.json \
  --pubkey-file /path/to/release-pub.b64 \
  --sha256 <entry-sha256>   # optional extra pin; must equal the signed entry, never trusted alone
```

Install (including `--dry-run` preview: add `--dry-run` to print every step without changes) refuses to proceed unless the binary's byte size and SHA-256 equal the signed updater entry and `<binary> -version` prints the manifest's `<version>+<buildId>` identity — a tampered manifest, wrong component, mismatched binary or stale identity fails **before** any file or unit is written. `--uninstall` (optionally `--purge-state`) needs no manifest. Do not take a hash from the agent entry or trust a URL without signature verification.

Rotate a signing key by publishing a new trusted public key to both API and host updater configurations **before** publishing manifests signed by the replacement private key. Verify the staged trust change with an immutable release in staging; revoke the old key only after all updater installations have switched. If a private key is compromised, disable the stable pointer/job creation and revoke updater credentials; do not sign another release with that key. Back up the old binary and journal until an operator validates recovery.

## Bootstrap and authorization

Install the updater separately from the local metrics agent: it uses a scoped updater credential bound to the local VPS, not a dashboard cookie or metrics token. Generate this credential using the API bootstrap command, transfer it to the host over a secure operator channel, and place it in the root-owned updater config alongside the pinned release key and HTTPS API URL. Follow `scripts/install/install-updater.sh --help` for the supported installation/uninstall flags. Bootstrap is explicit and manual; an API image deploy never invokes this installer. Inspect the generated systemd service and privileged helper policies before enabling. The updater downloads signed artifacts and requests only fixed agent-binary swap/restart actions; no request can supply a shell command, unit name, or arbitrary destination.

Limit updater credentials to a single local VPS and rotate/revoke them independently of metrics credentials. A credential leak warrants immediate revocation and host inspection. An updater that is absent or unhealthy leaves the dashboard in manual-instructions mode; it must not show an actionable upgrade button.

Credential cutover: `bootstrap-local-updater --rotate` creates a new scoped credential, revokes older updater credentials, and prints the new token once. The running updater will fail authentication until its root-owned config is updated and its service restarted. For uninterrupted cutover, use `bootstrap-local-updater --rotate --keep-previous`, install the new token, confirm the updater is healthy, then close the overlap with `revoke-agent-credentials --scope local-updater --keep-credential-id <newCredentialId>`. That revoke command defaults to the `agent` scope when `--scope` is omitted; it refuses a missing, inactive, or wrong-scope keep ID without revoking anything. Never leave the overlap open indefinitely.

## Backend URL cutover (`flexserverctl set-backend`)

Operational status (endpoint-only): host cutover to `https://api.flexserver.tech` verified via `applied-with-heartbeat-confirmation-required` plus a fresh heartbeat; canonical `AGENT_PUBLIC_BASE_URL` GitHub repo Variable persistently holds `https://api.flexserver.tech`; `https://flexserver.tech` remains available. Binary-upgrade production gate remains unverified.

Use `flexserverctl set-backend <URL>` to repoint an **existing** agent. Do not rerun `install.sh --backend-url` (or the standalone installers) for this: that flag sets the public setting and the default for newly written configs and deliberately leaves an already-installed config untouched rather than resetting its backend URL, so a rerun changes nothing on the agent you meant to repoint. It preserves the existing `vma_...` token, never prints it, and never logs config contents; rotation stays a separate, lossy bootstrap step (`--rotate` prints the raw token once and it cannot be recovered), so no `--rotate` is part of a URL change.

Run `flexserverctl help` for the full surface. `--dry-run` is the only safe preview — no write, no stop, no start, no backup file — printing `dry-run: no changes applied` and exiting 0. `flexserverctl validate-url <URL> [--updater]` validates a URL with zero side effects (exit 0 acceptable, 1 otherwise); `--updater` applies the stricter https-only updater `apiBase` rule.

```bash
flexserverctl help
flexserverctl validate-url https://api.flexserver.tech
sudo flexserverctl set-backend https://api.flexserver.tech --dry-run     # auto mode (default)
sudo flexserverctl set-backend https://api.flexserver.tech              # auto mode
flexserverctl set-backend https://api.flexserver.tech --mode user       # explicit mode
```

`--mode auto` (the default) picks `systemd` when running as root with a root-owned systemd agent install, else `user` when `~/.vps-manager-agent` exists, and otherwise fails with a hint to pass `--mode` explicitly; `--mode systemd` and `--mode user` remain the explicit forms. Systemd mode rewrites `backendUrl` in `/etc/vps-manager-agent/config.json` and — only when the updater config exists — `apiBase` in `/etc/vps-updater/config.json` to the same URL; when `vps-updater` is absent the updater leg is skipped. User mode (for example Azure hosts without systemd) rewrites `backendUrl` in `~/.vps-manager-agent/config.json`. Reading root-owned configs under `--mode systemd` may require `sudo`. A split backend/updater base leaves upgrades unhealthy, so apply the same URL to both when both are installed.

Migration targets must be HTTPS — an existing loopback value left in an old config is not a migration target. The updater `apiBase` must stay `https`. URL validation checks shape only: there is no hostname allowlist or denylist, so DNS and TLS are settled by the health probe rather than a name check.

The CLI probes health with a credential-free `GET <url>/api/health` (`User-Agent: flexserverctl/1.0`, system TLS verification, no redirect followed, bounded timeout/body, requiring HTTP 200 plus valid `{"ok": true}`) **before** any write, and runs one ordered transaction: snapshots, health probe, stop the owned old loop, write config(s), delivery preflight, restart, postcheck. The delivery preflight runs as `<agent> -config <cfg> -state <tempdir>/state.json -once -host-only`, so it never clobbers the real state file and never races a running loop. Applying the same URL again still restarts the agent unit (and the updater unit when installed). A restart is liveness only — never delivery proof: a clean success is reported as `applied-with-heartbeat-confirmation-required`, and only a fresh agent heartbeat from the parent API completes the cutover. The updater contributes local proof at best (`updater-process-observed`); idle journal silence is not authenticated delivery. On success the only on-disk artifact the CLI leaves behind is `.flexserverctl.bak`, which it deletes.

Updater guard: when installed, the updater must be quiescent. A persisted settled helper record (phase `restarted` or `rolled_back`) is permitted only when no daemon journal and no pending queue entries exist; an active daemon run, pending actions, or a corrupt/in-flight helper state cause the cutover to refuse before mutation. The updater daemon is stopped before the config write and a re-check occurs after the stop, so a refusal never leaves the daemon down and never mutates updater state.

Advanced (non-default) environment seams override the production literals for staging or testing: `FLEXSERVERCTL_AGENT_CONFIG`, `FLEXSERVERCTL_UPDATER_CONFIG`, `FLEXSERVERCTL_USER_CONFIG`, `FLEXSERVERCTL_AGENT_BIN`, `FLEXSERVERCTL_UPDATER_BIN`, `FLEXSERVERCTL_SYSTEMCTL_BIN`, `FLEXSERVERCTL_PROC_ROOT`, `FLEXSERVERCTL_HOME`. All default to the production paths and binaries, and there is no environment switch that skips the Linux check — the CLI is Linux-only and fails on other platforms.

Exit codes: `0` for success or a clean dry-run, `1` for any refusal (bad URL, health failure, preflight failure, `restored`, `rollback-failed`). There is no other error code and no `--yes`/`--force` override. A pre-write refusal prints its reason to stderr in the form `Error: <reason>`.

On failure each touched config is restored from its `<config>.flexserverctl.bak` companion with the original bytes, owner and mode, the newly started loop is stopped, and the original loop is restarted with its preserved argv and cwd when one was running. The outcome is `restored` when that rollback succeeds byte-for-byte. If the restore itself fails, the outcome is `rollback-failed`: the `.flexserverctl.bak` files are deliberately retained as operator recovery material (they are deleted only after a verified-successful restore) and manual intervention is required. Endpoint or service recovery is not promised — if the new backend is unreachable, the agent may report no metrics until the URL is fixed.

Stable-domain prerequisite: before cutting over to any stable API domain, its DNS must resolve from the agent host, its TLS certificate must be valid, and its reverse proxy must `proxy_pass` `/api/` to the API (for example Nginx Proxy Manager on the working `flexserver.tech` host) — the cutover validation does not follow redirects, so point at the proxied API origin rather than a redirecting URL. Keep the dashboard origin (`DASHBOARD_PUBLIC_ORIGIN`, with `TRUST_PROXY_HOPS` set per deployment, e.g. `1` behind a single reverse proxy) separate from the agent/API base URL, and set the canonical `AGENT_PUBLIC_BASE_URL` so remote installers generate reachable configs (`AGENT_PUBLIC_BASE_URL` required, HTTPS unless `ALLOW_INSECURE_AGENT_HTTP=true`). `api.flexserver.tech` DNS resolves and its HTTPS API origin is operational and verified, served through Nginx Proxy Manager with a managed certificate — it is an accepted backend URL once the health probe passes. Host cutover to `https://api.flexserver.tech` is verified (endpoint-only: `applied-with-heartbeat-confirmation-required` plus a fresh heartbeat); the canonical `AGENT_PUBLIC_BASE_URL` GitHub repo Variable persistently holds `https://api.flexserver.tech`. `flexserver.tech` remains a working origin. This does not verify the binary-upgrade production gate. Existing agents are not automatically migrated, so repoint each one explicitly with `flexserverctl set-backend`. The installers' URL acceptance is deliberately separate from the migration contract above: they still accept plain `http` for exact `localhost`, `127.0.0.1`, `[::1]` (rejecting `0.0.0.0` and lookalike hosts such as `localhost.example.com`), which is a bootstrap allowance, not permission to settle on loopback as a long-lived backend.

## Upgrade and incident checks

1. On the dashboard's local VPS card or table, compare installed version/build ID and heartbeat age with target release ID. `unknown` or stale heartbeat is not evidence that the agent is current. Check updater status and compatibility before opening the confirmation dialog.
2. Confirm a single job. The API stores the chosen release ID/hash, idempotency key and deadline; the updater claims it with a lease/fencing token. Refreshing the dashboard must reuse the existing job instead of creating another one.
3. On the host inspect `systemctl status vps-updater.service vps-updater-apply.path vps-manager-agent.service` and `journalctl -u vps-updater.service -u vps-updater-apply.service --since '30 minutes ago'`. Use `vps-updater status` to inspect durable journal and pending actions. Avoid printing credential/config content in diagnostics.
4. A successful job requires a *new* heartbeat carrying the target build ID, from the correct VPS after restart. `systemctl is-active` or a changed binary hash alone is insufficient. Verify `vps-manager-agent -version` matches the release identity, the local Docker snapshot source sequence advances, and at least two fresh samples appear in the chart before closing the incident.
5. On rollback, verify the old binary identity and a fresh heartbeat carrying its previous build ID. `rollback_unverified` means host state is uncertain: stop creating new jobs, retain backup and journal, inspect binary hash/service state manually. After recovery, run `sudo -u vps-updater /usr/local/lib/vps-manager-agent/vps-updater ack -config /etc/vps-updater/config.json` (not as root: the journal must remain owned by the daemon); confirm the server rules `rolled_back` and the updater consumes its journal. Do not delete backups or blindly retry a swapped mutation.
6. If the updater is not installed, follow the dashboard's signed-manifest manual instructions during a maintenance window. Verify signature and SHA-256 before installing; keep the previous binary and config, restart the fixed unit, verify a fresh matching heartbeat, otherwise restore the binary and verify rollback. Never run a release URL or command copied from an untrusted page without independent signature validation.

## Rollout and rollback gate

This gate covers binary upgrades only; the endpoint cutover to `https://api.flexserver.tech` is verified separately and does not satisfy this gate. Use a disposable Linux staging host first. Install the updater and scoped credential, publish a signed compatible release, run a real upgrade, verify process build ID, fresh heartbeat, Docker source sequence and chart samples. Fault-inject corrupt signature, interrupted download, disk exhaustion, crash after swap and missing heartbeat; verify no unconfirmed success and a recoverable journal/backup. Force a failed restart and confirm rollback identity. Only then canary on production. If the release must be withdrawn, disable the stable pointer/job creation and retain the last verified binary; redeploying the API/web image alone does not roll back a host agent. Never label a staging or production rollout verified without observing those host checks.
