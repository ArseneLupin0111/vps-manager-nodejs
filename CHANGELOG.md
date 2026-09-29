# Changelog

## Unreleased — local agent upgrade

- Add signed, immutable agent/updater release manifests with pinned Ed25519 verification, a stable-channel catalog, build IDs, and compatibility checks.
- Add a separately installed, pull-only host updater with scoped credentials, a constrained privileged helper, durable journal, lease/fencing, signed-artifact verification, rollback, and backup retention when recovery is unverified.
- Add persistent local-upgrade jobs for JSON and PostgreSQL, admin confirmation and audit, idempotent outcomes, and fresh-heartbeat verification before success or verified rollback.
- Show installed build, release availability, updater health, manual instructions, confirmation, durable progress, and recovery guidance in local VPS card, table, and workspace views. Remote SSH upgrades remain separate.
- Harden installer signature gates, updater credential rotation, post-swap failure handling, filesystem boundaries, and confirmation-dialog focus restoration.

Production rollout is **not yet verified**. Complete the disposable Linux staging and fault-injection gate in `docs/local-agent-upgrade-operations.md`, publish a signed release matching the final commit, then perform an authorized production canary. API/web deployment alone does not replace the host agent.
