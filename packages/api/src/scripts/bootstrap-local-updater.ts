/**
 * CLI script to bootstrap the local-updater credential for a host.
 *
 * The local-updater credential is distinct from the metrics/agent credential:
 * it is scoped `local-updater` so it can only pull upgrade jobs, never push
 * metrics or claim agent commands.
 *
 * Compiled to dist/scripts/bootstrap-local-updater.js during `npm run build`.
 * For production runtime:
 *   node dist/scripts/bootstrap-local-updater.js --backend-url http://127.0.0.1:3000
 *
 * Usage:
 *   node dist/scripts/bootstrap-local-updater.js [options]
 *
 * Options:
 *   --backend-url <url>   Required. Backend URL the updater polls.
 *   --vps-id <id>         Local VPS record ID (default: vps_local_host).
 *   --rotate              Rotate credential if one already exists.
 *   --keep-previous       With --rotate: keep the previous credential active
 *                         (explicit staged overlap window).
 *   --help                Show this help.
 *
 * Rotation / cutover semantics:
 *   --rotate (default cutover)
 *     A fresh credential is issued first, then every other active
 *     `local-updater` credential for the host is revoked before the new token
 *     is printed. The old token stops working at that moment, so a running
 *     updater fails auth until its config is replaced with the new token and
 *     it is restarted. `agent`-scoped credentials are never touched.
 *   --rotate --keep-previous (staged overlap)
 *     The previous credential(s) stay active — reported as
 *     `retainedCredentialIds` — so an already-running updater keeps working
 *     while its config is being replaced. Close the overlap explicitly once
 *     the updater runs on the new token:
 *       node dist/scripts/revoke-agent-credentials.js \
 *         --scope local-updater --keep-credential-id <newCredentialId>
 *
 * The script:
 *   1. Loads app config (reads .env via loadAppConfig).
 *   2. Creates repositories matching the active storage driver.
 *   3. Ensures the local host VPS record exists (and is actually local).
 *   4. Creates (or rotates) an active credential with scope `local-updater`.
 *   5. Outputs JSON with vpsId, credentialId, token, revokedCredentialIds,
 *      and retainedCredentialIds — token once, ids only otherwise.
 *   6. Never writes the token to stderr, logs, or audit.
 *   7. Closes DB pool in finally.
 */

import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname, userInfo } from "node:os";
import { loadAppConfig } from "../config/app-config.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import { createRepositories } from "../persistence/repositories/create-repositories.js";
import { revokeScopedAgentCredentials } from "./revoke-agent-credentials.js";

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_LOCAL_HOST_ID = "vps_local_host";
const TOKEN_PREFIX = "vma_";

// ── Helpers ──────────────────────────────────────────────────────────────

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const val = process.argv[idx + 1];
  return val && !val.startsWith("--") ? val : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function usage(exitCode = 0): never {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage: node dist/scripts/bootstrap-local-updater.js --backend-url <url> [options]

Options:
  --backend-url <url>             Required. Backend URL the updater polls.
  --vps-id <id>                   Local VPS record ID (default: vps_local_host).
  --rotate                        Rotate credential if one already exists.
                                  Previous active local-updater credentials
                                  are revoked as part of the rotation.
  --keep-previous                 With --rotate: keep the previous credential
                                  active (staged overlap; revoke it explicitly
                                  afterwards via revoke-agent-credentials).
  --help                          Show this help.
`);
  process.exit(exitCode);
}

/**
 * Validate a backend URL for updater use.
 * - HTTPS is always allowed.
 * - HTTP is allowed for loopback addresses (127.0.0.1, ::1, localhost) only.
 *   There is no override: a non-loopback backend must be HTTPS.
 */
export function validateBackendUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid backend URL: ${urlString}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Backend URL must use http or https protocol: ${urlString}`,
    );
  }

  if (url.protocol === "https:") {
    return url; // HTTPS always ok
  }

  // http: — loopback only, no override.
  const rawHostname = url.hostname.toLowerCase();
  const hostname = rawHostname.replace(/^\[|\]$/g, "");
  const isLoopback =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

  if (!isLoopback) {
    throw new Error(
      `Insecure backend URL (http) for non-loopback host "${rawHostname}". ` +
        `Use https, or http with a loopback host (127.0.0.1, ::1, localhost).`,
    );
  }

  return url;
}

/**
 * Hash a secret using SHA-256.
 */
function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// ── Main ─────────────────────────────────────────────────────────────────

export type BootstrapUpdaterOutput = {
  vpsId: string;
  credentialId: string;
  token: string;
  /** Previous active local-updater credential ids revoked in this run. */
  revokedCredentialIds: string[];
  /** Previous active local-updater credential ids kept active (--keep-previous). */
  retainedCredentialIds: string[];
};

/** Repository surface the updater bootstrap needs. */
export type UpdaterCredentialRepository = Pick<
  AgentRepository,
  "createCredential" | "listCredentialsByVps" | "revokeCredential"
>;

export type IssuedUpdaterCredential = Omit<BootstrapUpdaterOutput, "vpsId">;

/**
 * Issue a fresh `local-updater` credential and settle the previous ones.
 *
 * Cutover semantics:
 * - `rotate=false`: issue only (the caller has already rejected the case of an
 *   existing active updater credential — its raw token is unrecoverable).
 * - `rotate=true` (default cutover): the new credential exists first, then
 *   every other active `local-updater` credential for the host is revoked, so
 *   the old token dies at the moment the new one is printed. A running updater
 *   starts failing auth until its config is replaced and it restarts —
 *   intentional, no lingering alternate credential.
 * - `rotate=true, keepPrevious=true` (staged overlap): previous credentials
 *   stay active and are reported in `retainedCredentialIds`, so an
 *   already-running updater keeps working while its config is replaced. Close
 *   the overlap explicitly afterwards via
 *   `revoke-agent-credentials --scope local-updater --keep-credential-id <new>`.
 *
 * Only `local-updater` credentials are ever revoked here — `agent` credentials
 * are out of scope by construction. Returns ids plus the single new token;
 * previous secrets are hashes and unrecoverable, so no extra credential
 * material is exposed.
 */
export async function issueUpdaterCredential(
  agentRepository: UpdaterCredentialRepository,
  options: { vpsId: string; rotate: boolean; keepPrevious: boolean },
): Promise<IssuedUpdaterCredential> {
  const { vpsId, rotate, keepPrevious } = options;

  // Issue the new credential first: if the subsequent revocation step fails,
  // the host still holds a valid credential (availability over cleanup; the
  // failure surfaces as a non-zero exit instead of a silent partial state).
  const secret = randomBytes(32).toString("hex");
  const credential = await agentRepository.createCredential({
    vpsId,
    secretHash: hashSecret(secret),
    status: "active",
    scope: "local-updater",
  });
  const token = `${TOKEN_PREFIX}${credential.id}_${secret}`;

  const revokedCredentialIds: string[] = [];
  const retainedCredentialIds: string[] = [];

  if (rotate) {
    if (keepPrevious) {
      const credentials = await agentRepository.listCredentialsByVps(vpsId);
      retainedCredentialIds.push(
        ...credentials
          .filter(
            (other) =>
              other.id !== credential.id &&
              other.status === "active" &&
              (other.scope ?? "agent") === "local-updater",
          )
          .map((other) => other.id),
      );
    } else {
      const revocation = await revokeScopedAgentCredentials(agentRepository, {
        vpsId,
        scope: "local-updater",
        keepCredentialId: credential.id,
      });
      revokedCredentialIds.push(...revocation.revokedCredentialIds);
    }
  }

  return {
    credentialId: credential.id,
    token,
    revokedCredentialIds,
    retainedCredentialIds,
  };
}

export async function bootstrapLocalUpdater(): Promise<BootstrapUpdaterOutput> {
  // ── Parse args ───────────────────────────────────────────────────────
  if (hasFlag("--help")) usage();

  const backendUrlRaw = argValue("--backend-url");
  if (!backendUrlRaw) {
    console.error("Error: --backend-url is required.");
    usage(1);
  }

  const vpsId = argValue("--vps-id") ?? DEFAULT_LOCAL_HOST_ID;
  const rotate = hasFlag("--rotate");
  const keepPrevious = hasFlag("--keep-previous");
  if (keepPrevious && !rotate) {
    console.error("Error: --keep-previous requires --rotate.");
    process.exit(1);
  }

  let backendUrl: URL;
  try {
    backendUrl = validateBackendUrl(backendUrlRaw);
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // ── Bootstrap repositories ───────────────────────────────────────────
  const config = loadAppConfig();
  if (config.mode !== "local") {
    console.error("Error: bootstrap-local-updater requires APP_MODE=local.");
    process.exit(1);
  }
  const repos = createRepositories(config);
  const { vps: vpsRepository, agent: agentRepository, pool } = repos;

  let result: BootstrapUpdaterOutput;

  try {
    // ── Ensure local host record ────────────────────────────────────────
    const localHostname = (() => {
      try {
        return hostname();
      } catch {
        return "Local host";
      }
    })();
    const localUsername = (() => {
      try {
        return userInfo().username;
      } catch {
        return "root";
      }
    })();

    await vpsRepository.ensureLocalHost({
      id: vpsId,
      name: localHostname,
      host: backendUrl.hostname,
      port: 22,
      username: localUsername,
      provider: "local",
      tags: ["local", "local-agent", "system"],
      status: "unknown",
      kind: "local",
      managedBy: "system",
      notes: `Local agent auto-managed. Host: ${localHostname}, User: ${localUsername}`,
    });

    // The updater credential may only ever bind to a local host record —
    // refuse if the record at this id is remote (e.g. a recycled id).
    const vps = await vpsRepository.get(vpsId);
    if (!vps || (vps.kind !== "local" && vps.managedBy !== "system")) {
      console.error(
        `Error: VPS record "${vpsId}" is not a local host; refusing to issue an updater credential.`,
      );
      process.exit(1);
    }

    // ── Find existing updater credential / issue new ────────────────────
    const existingCredentials =
      await agentRepository.listCredentialsByVps(vpsId);
    const activeUpdaterCredentials = existingCredentials.filter(
      (credential) =>
        credential.status === "active" &&
        (credential.scope ?? "agent") === "local-updater",
    );

    if (activeUpdaterCredentials.length > 0 && !rotate) {
      throw new Error(
        `An active local-updater credential already exists for ${vpsId}, and the raw token cannot be recovered. ` +
          `Pass --rotate to issue a new token (add --keep-previous for a staged overlap window).`,
      );
    }

    // Issue the fresh credential (scope local-updater, never agent metrics)
    // and settle previous updater credentials per the cutover semantics:
    // revoke them by default, retain them with --keep-previous.
    const issued = await issueUpdaterCredential(agentRepository, {
      vpsId,
      rotate,
      keepPrevious,
    });
    const output: BootstrapUpdaterOutput = { vpsId, ...issued };

    // Output the raw token exactly once, to stdout, as JSON.
    console.log(JSON.stringify(output));
    result = output;
  } finally {
    if (pool) await pool.end();
  }

  return result;
}

// Allow both direct execution and import
const isDirectRun = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isDirectRun) {
  bootstrapLocalUpdater().catch((error: unknown) => {
    console.error(
      "Failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
