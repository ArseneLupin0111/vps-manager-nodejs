import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import {
  issueUpdaterCredential,
  validateBackendUrl,
} from "../src/scripts/bootstrap-local-updater.js";
import { revokeScopedAgentCredentials } from "../src/scripts/revoke-agent-credentials.js";

describe("bootstrap-local-updater URL validation", () => {
  it("accepts https for any host", () => {
    expect(validateBackendUrl("https://api.example.com:8443").origin).toBe(
      "https://api.example.com:8443",
    );
  });

  it("accepts http for loopback hosts", () => {
    for (const url of [
      "http://127.0.0.1:3000",
      "http://localhost:3000/api",
      "http://[::1]:3000",
    ]) {
      expect(validateBackendUrl(url).protocol).toBe("http:");
    }
  });

  it("rejects http for non-loopback hosts with no override available", () => {
    for (const url of [
      "http://192.168.1.10:3000",
      "http://example.com:3000",
      "http://0.0.0.0:3000",
    ]) {
      expect(() => validateBackendUrl(url)).toThrow(/Insecure backend URL/);
    }
  });

  it("rejects invalid URLs and non-http(s) protocols", () => {
    expect(() => validateBackendUrl("not-a-url")).toThrow(
      /Invalid backend URL/,
    );
    expect(() => validateBackendUrl("ftp://example.com")).toThrow(
      /must use http or https/,
    );
  });
});

describe("bootstrap-local-updater credential rotation", () => {
  const VPS_ID = "vps_local_host";
  let tempDir: string;
  let repo: AgentRepository;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vps-manager-updater-rotate-"));
    repo = createJsonAgentRepository(join(tempDir, "agents.json"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seedActiveCredentials() {
    const previousUpdater = await repo.createCredential({
      vpsId: VPS_ID,
      secretHash: "previous-updater-hash",
      status: "active",
      scope: "local-updater",
    });
    const agentCredential = await repo.createCredential({
      vpsId: VPS_ID,
      secretHash: "agent-hash",
      status: "active",
    });
    return { previousUpdater, agentCredential };
  }

  async function activeCredentialIds() {
    const credentials = await repo.listCredentialsByVps(VPS_ID);
    return credentials
      .filter((credential) => credential.status === "active")
      .map((credential) => credential.id)
      .sort();
  }

  it("--rotate revokes the previous updater credential instead of leaving it active", async () => {
    const { previousUpdater, agentCredential } = await seedActiveCredentials();

    const issued = await issueUpdaterCredential(repo, {
      vpsId: VPS_ID,
      rotate: true,
      keepPrevious: false,
    });

    expect(issued.revokedCredentialIds).toEqual([previousUpdater.id]);
    expect(issued.retainedCredentialIds).toEqual([]);
    expect((await repo.getCredential(previousUpdater.id))?.status).toBe(
      "revoked",
    );
    // Exactly the new updater credential and the untouched agent credential
    // remain active — no silently lingering old updater token.
    expect(await activeCredentialIds()).toEqual(
      [issued.credentialId, agentCredential.id].sort(),
    );
    // The token exposes exactly the new credential id, nothing else.
    expect(issued.token.startsWith(`vma_${issued.credentialId}_`)).toBe(true);
  });

  it("--rotate --keep-previous stages an overlap and the overlap can be closed scoped", async () => {
    const { previousUpdater, agentCredential } = await seedActiveCredentials();

    const issued = await issueUpdaterCredential(repo, {
      vpsId: VPS_ID,
      rotate: true,
      keepPrevious: true,
    });

    // Staged overlap: previous updater credential stays active and is reported.
    expect(issued.revokedCredentialIds).toEqual([]);
    expect(issued.retainedCredentialIds).toEqual([previousUpdater.id]);
    expect((await repo.getCredential(previousUpdater.id))?.status).toBe(
      "active",
    );

    // Closing the overlap targets only local-updater credentials.
    const closure = await revokeScopedAgentCredentials(repo, {
      vpsId: VPS_ID,
      scope: "local-updater",
      keepCredentialId: issued.credentialId,
    });
    expect(closure.revokedCredentialIds).toEqual([previousUpdater.id]);
    expect((await repo.getCredential(previousUpdater.id))?.status).toBe(
      "revoked",
    );
    expect((await repo.getCredential(issued.credentialId))?.status).toBe(
      "active",
    );
    expect((await repo.getCredential(agentCredential.id))?.status).toBe(
      "active",
    );
  });

  it("fresh bootstrap without --rotate reports empty rotation lists", async () => {
    const issued = await issueUpdaterCredential(repo, {
      vpsId: VPS_ID,
      rotate: false,
      keepPrevious: false,
    });

    expect(issued.revokedCredentialIds).toEqual([]);
    expect(issued.retainedCredentialIds).toEqual([]);
    expect((await repo.getCredential(issued.credentialId))?.status).toBe(
      "active",
    );
    expect(await activeCredentialIds()).toEqual([issued.credentialId]);
  });
});
