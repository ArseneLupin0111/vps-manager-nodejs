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
sudo ./scripts/install-updater.sh \
  --binary ./vps-updater-linux-amd64 \
  --config ./updater-config.json \
  --manifest ./manifest.json \
  --pubkey-file /path/to/release-pub.b64 \
  --sha256 <entry-sha256>   # optional extra pin; must equal the signed entry, never trusted alone
```

Install (including `--dry-run` preview: add `--dry-run` to print every step without changes) refuses to proceed unless the binary's byte size and SHA-256 equal the signed updater entry and `<binary> -version` prints the manifest's `<version>+<buildId>` identity — a tampered manifest, wrong component, mismatched binary or stale identity fails **before** any file or unit is written. `--uninstall` (optionally `--purge-state`) needs no manifest. Do not take a hash from the agent entry or trust a URL without signature verification.

Rotate a signing key by publishing a new trusted public key to both API and host updater configurations **before** publishing manifests signed by the replacement private key. Verify the staged trust change with an immutable release in staging; revoke the old key only after all updater installations have switched. If a private key is compromised, disable the stable pointer/job creation and revoke updater credentials; do not sign another release with that key. Back up the old binary and journal until an operator validates recovery.

## Bootstrap and authorization

Install the updater separately from the local metrics agent: it uses a scoped updater credential bound to the local VPS, not a dashboard cookie or metrics token. Generate this credential using the API bootstrap command, transfer it to the host over a secure operator channel, and place it in the root-owned updater config alongside the pinned release key and HTTPS API URL. Follow `scripts/install-updater.sh --help` for the supported installation/uninstall flags. Bootstrap is explicit and manual; an API image deploy never invokes this installer. Inspect the generated systemd service and privileged helper policies before enabling. The updater downloads signed artifacts and requests only fixed agent-binary swap/restart actions; no request can supply a shell command, binary path, systemd unit, arbitrary URL or release signing key.

Limit updater credentials to a single local VPS and rotate/revoke them independently of metrics credentials. A credential leak warrants immediate revocation and host inspection. An updater that is absent or unhealthy leaves the dashboard in manual-instructions mode; it must not show an actionable upgrade button.

Credential cutover: `bootstrap-local-updater --rotate` creates a new scoped credential, revokes older updater credentials, and prints the new token once. The running updater will fail authentication until its root-owned config is updated and its service restarted. For uninterrupted cutover, use `bootstrap-local-updater --rotate --keep-previous`, install the new token, confirm the updater is healthy, then close the overlap with `revoke-agent-credentials --scope local-updater --keep-credential-id <newCredentialId>`. That revoke command defaults to the `agent` scope when `--scope` is omitted; it refuses a missing, inactive, or wrong-scope keep ID without revoking anything. Never leave the overlap open indefinitely.

## Upgrade and incident checks

1. On the dashboard's local VPS card or table, compare installed version/build ID and heartbeat age with target release ID. `unknown` or stale heartbeat is not evidence that the agent is current. Check updater status and compatibility before opening the confirmation dialog.
2. Confirm a single job. The API stores the chosen release ID/hash, idempotency key and deadline; the updater claims it with a lease/fencing token. Refreshing the dashboard must reuse the existing job instead of creating another one.
3. On the host inspect `systemctl status vps-updater.service vps-updater-apply.path vps-manager-agent.service` and `journalctl -u vps-updater.service -u vps-updater-apply.service --since '30 minutes ago'`. Use `vps-updater status` to inspect durable journal and pending actions. Avoid printing credential/config content in diagnostics.
4. A successful job requires a *new* heartbeat carrying the target build ID, from the correct VPS after restart. `systemctl is-active` or a changed binary hash alone is insufficient. Verify `vps-manager-agent -version` matches the release identity, the local Docker snapshot source sequence advances, and at least two fresh samples appear in the chart before closing the incident.
5. On rollback, verify the old binary identity and a fresh heartbeat carrying its previous build ID. `rollback_unverified` means host state is uncertain: stop creating new jobs, retain backup and journal, inspect binary hash/service state manually. After recovery, run `sudo -u vps-updater /usr/local/lib/vps-manager-agent/vps-updater ack -config /etc/vps-updater/config.json` (not as root: the journal must remain owned by the daemon); confirm the server rules `rolled_back` and the updater consumes its journal. Do not delete backups or blindly retry a swapped mutation.
6. If the updater is not installed, follow the dashboard's signed-manifest manual instructions during a maintenance window. Verify signature and SHA-256 before installing; keep the previous binary and config, restart the fixed unit, verify a fresh matching heartbeat, otherwise restore the binary and verify rollback. Never run a release URL or command copied from an untrusted page without independent signature validation.

## Rollout and rollback gate

Use a disposable Linux staging host first. Install the updater and scoped credential, publish a signed compatible release, run a real upgrade, verify process build ID, fresh heartbeat, Docker source sequence and chart samples. Fault-inject corrupt signature, interrupted download, disk exhaustion, crash after swap and missing heartbeat; verify no unconfirmed success and a recoverable journal/backup. Force a failed restart and confirm rollback identity. Only then canary on production. If the release must be withdrawn, disable the stable pointer/job creation and retain the last verified binary; redeploying the API/web image alone does not roll back a host agent. Never label a staging or production rollout verified without observing those host checks.
