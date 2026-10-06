import { describe, expect, it } from "vitest";
import { buildDockerStateProvisionCommand } from "../src/agents/agent-lifecycle-remote.js";

describe("buildDockerStateProvisionCommand", () => {
  const cmd = buildDockerStateProvisionCommand(
    "/home/deploy/.vps-manager-agent/vps-agent.stage-7",
    "/home/deploy/.vps-manager-agent",
  );
  const lines = cmd.split("\n");

  it("detects privilege without failing solely for missing sudo", () => {
    expect(cmd.startsWith("set -eu")).toBe(true);
    expect(cmd).toContain("command -v sudo >/dev/null 2>&1 && sudo -n true");
    // Missing sudo falls through to the unprivileged branches instead of exiting.
    expect(cmd).toContain("else _s='_nosudo'; fi");
    const probe = lines.find((l) => l.includes("command -v sudo"));
    expect(probe).toBeDefined();
    expect(probe!).not.toContain("exit 1");
    expect(cmd).not.toContain("refusing to start the agent without it");
  });

  it("refuses to rotate an existing identity before any provision call", () => {
    const guard = cmd.indexOf("refusing to rotate the installation identity");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(cmd.indexOf("-provision-docker-state"));
    // The guard fires only for the unrecoverable state: keys without identity.
    expect(cmd).toContain('[ -e "$_rk" ] && [ ! -e "$_id" ]');
    // Ungated: fires in both privileged and unprivileged modes (defense in depth).
    const guardLine = lines.find((l) =>
      l.includes("refusing to rotate the installation identity"),
    );
    expect(guardLine).toBeDefined();
    expect(guardLine!).not.toContain("_nosudo");
  });

  it("accepts only root or the login user as an existing runtime-keys owner", () => {
    const select = cmd.indexOf('case "$_o" in 0|"$_u")');
    expect(select).toBeGreaterThan(-1);
    expect(select).toBeLessThan(cmd.indexOf("-provision-docker-state"));
    expect(cmd).toContain("stat -c %u");
    expect(cmd).toContain("refusing to touch Docker runtime keys");
    // Fresh state provisions as root, then ownership is corrected.
    expect(cmd).toContain("_p=0");
    // Ungated: the owner allowlist applies before any provision call.
    const selectLine = lines.find((l) => l.includes('case "$_o" in 0|"$_u")'));
    expect(selectLine).toBeDefined();
    expect(selectLine!).not.toContain("_nosudo");
  });

  it("provisions privileged twice, plus unprivileged clean-install and user-owned passes", () => {
    expect(cmd.match(/-provision-docker-state/g)).toHaveLength(4);
    // Privileged initial pass preserves the existing runtime owner (root or login user).
    expect(cmd).toContain(
      '$_s "$_b" -provision-docker-state -docker-identity-path "$_id" -docker-runtime-keys-path "$_rk" -docker-runtime-owner-uid "$_p"',
    );
    // Privileged verification plus both unprivileged provision calls validate as the login user.
    expect(cmd.match(/-docker-runtime-owner-uid "\$_u"/g)).toHaveLength(3);
    const privileged = lines.find(
      (l) =>
        l.includes("!= '_nosudo'") && l.includes("-provision-docker-state"),
    );
    expect(privileged).toBeDefined();
    // Both privileged passes live on the gated branch, before any unprivileged exit.
    expect(privileged!).toContain('-docker-runtime-owner-uid "$_p"');
    expect(privileged!).toContain('-docker-runtime-owner-uid "$_u"');
    expect(cmd.indexOf("!= '_nosudo'")).toBeLessThan(
      cmd.indexOf('[ ! -e "$_id" ] && [ ! -e "$_rk" ]'),
    );
  });

  it("enforces agent-expected ownership and mode between the privileged passes", () => {
    const first = cmd.indexOf("-provision-docker-state");
    const second = cmd.indexOf("-provision-docker-state", first + 1);
    const chownIdentity = cmd.indexOf("chown root:root");
    const chownRuntime = cmd.indexOf('chown "$_u:$(id -gn)"');
    const chmod = cmd.indexOf("chmod 0600");
    expect(first).toBeGreaterThan(-1);
    expect(chownIdentity).toBeGreaterThan(first);
    expect(chownRuntime).toBeGreaterThan(chownIdentity);
    expect(chmod).toBeGreaterThan(chownRuntime);
    expect(second).toBeGreaterThan(chmod);
    // Ownership correction lives only on the privileged branch.
    const privileged = lines.find((l) => l.includes("chown root:root"));
    expect(privileged).toBeDefined();
    expect(privileged!).toContain("!= '_nosudo'");
    expect(privileged!).toContain('chown "$_u:$(id -gn)"');
    expect(privileged!).toContain("chmod 0600");
  });

  it("never deletes or replaces existing state", () => {
    expect(cmd).not.toMatch(/\brm\b/);
    expect(cmd).not.toMatch(/\bmv\b/);
    // Unprivileged branches never change ownership or mode either.
    for (const l of lines) {
      if (l.includes("chown") || l.includes("chmod 0600")) {
        expect(l).toContain("!= '_nosudo'");
      }
    }
  });

  it("provisions a user-owned pair on clean install without sudo", () => {
    const clean = lines.find((l) =>
      l.includes('[ ! -e "$_id" ] && [ ! -e "$_rk" ]'),
    );
    expect(clean).toBeDefined();
    expect(clean!).toContain('"$_b" -provision-docker-state');
    expect(clean!).toContain('-docker-runtime-owner-uid "$_u"');
    expect(clean!).not.toContain("sudo");
    expect(clean!).toContain("exit 0");
    expect(cmd.indexOf('[ ! -e "$_id" ] && [ ! -e "$_rk" ]')).toBeGreaterThan(
      cmd.indexOf("!= '_nosudo'"),
    );
  });

  it("re-provisions an intact user-owned pair without rotating identity", () => {
    const reuse =
      'if [ "$_io" = "$_u" ] && [ "$_ro" = "$_u" ]; then "$_b" -provision-docker-state -docker-identity-path "$_id" -docker-runtime-keys-path "$_rk" -docker-runtime-owner-uid "$_u"; exit 0; fi';
    expect(cmd).toContain(reuse);
    // Regular-file and 0600 stat checks gate the reuse before any provision call.
    expect(cmd.indexOf('[ ! -f "$_id" ]')).toBeLessThan(cmd.indexOf(reuse));
    expect(cmd.indexOf('case "$_im" in 600)')).toBeLessThan(
      cmd.indexOf(reuse),
    );
    expect(cmd.indexOf('case "$_rm" in 600)')).toBeLessThan(
      cmd.indexOf(reuse),
    );
  });

  it("preserves a root-owned identity with user-owned runtime keys without sudo", () => {
    const preserve =
      'if [ "$_io" = 0 ] && [ "$_ro" = "$_u" ] && [ -s "$_id" ] && [ -s "$_rk" ]; then exit 0; fi';
    expect(cmd).toContain(preserve);
    // Missing privilege alone is not fatal: the split-identity exit 0 is reachable past the sudo probe.
    expect(cmd.indexOf("command -v sudo")).toBeLessThan(
      cmd.indexOf(preserve),
    );
    // The preserve branch touches nothing: no provision, no ownership/mode change.
    const line = lines.find((l) => l.includes('[ "$_io" = 0 ]'));
    expect(line).toBeDefined();
    expect(line!).not.toContain("-provision-docker-state");
    expect(line!).not.toContain("chown");
    expect(line!).not.toContain("chmod");
    // Stat guards (regular files, 0600, split owners, non-empty) precede it.
    expect(cmd.indexOf('[ ! -f "$_id" ]')).toBeLessThan(cmd.indexOf(preserve));
    expect(cmd.indexOf('case "$_im" in 600)')).toBeLessThan(
      cmd.indexOf(preserve),
    );
    // An absent identity is never silently accepted on this path.
    expect(
      cmd.indexOf("refusing to rotate the installation identity"),
    ).toBeLessThan(cmd.indexOf(preserve));
    expect(
      cmd.indexOf("refusing to provision a partial pair"),
    ).toBeLessThan(cmd.indexOf(preserve));
    // Anything unexpected after it still fails closed.
    expect(cmd.indexOf("Unexpected Docker state owners")).toBeGreaterThan(
      cmd.indexOf(preserve),
    );
  });

  it("fails closed on a partial pair before any provision call", () => {
    const guards = [
      'if [ -e "$_rk" ] && [ ! -e "$_id" ]; then echo "Docker runtime keys exist without the installation identity ($_id); refusing to rotate the installation identity" >&2; exit 1; fi',
      'if [ -e "$_id" ] && [ ! -e "$_rk" ]; then echo "Docker installation identity exists without runtime keys ($_rk); refusing to provision a partial pair" >&2; exit 1; fi',
    ];
    for (const guard of guards) {
      expect(cmd).toContain(guard);
      const line = lines.find((l) => l === guard);
      expect(line).toBeDefined();
      expect(line!).toContain("exit 1");
      expect(line!).not.toContain("-provision-docker-state");
      expect(line!).not.toContain("chown");
      expect(line!).not.toContain("chmod");
      // Ungated: both partial directions fail in privileged and unprivileged modes.
      expect(line!).not.toContain("_nosudo");
      expect(cmd.indexOf(guard)).toBeLessThan(
        cmd.indexOf("-provision-docker-state"),
      );
    }
  });

  it("fails closed without privilege on insecure modes, wrong owners, or empty/non-regular files", () => {
    expect(cmd).toContain('[ ! -f "$_id" ] || [ ! -f "$_rk" ]');
    expect(cmd).toContain("Insecure mode $_im");
    expect(cmd).toContain("Insecure mode $_rm");
    expect(cmd).toContain("Unexpected Docker state owners");
    const needles = [
      "must be regular files",
      "Insecure mode $_im",
      "Insecure mode $_rm",
      "Unexpected Docker state owners",
    ];
    for (const needle of needles) {
      const line = lines.find((l) => l.includes(needle));
      expect(line).toBeDefined();
      expect(line!).toContain("exit 1");
      expect(line!).not.toContain("-provision-docker-state");
      expect(line!).not.toContain("chown");
      expect(line!).not.toContain("chmod");
    }
  });

  it("quotes a remote directory with spaces and shell metacharacters", () => {
    const tricky = buildDockerStateProvisionCommand(
      "/home/deploy/.vps-manager-agent/vps-agent",
      "/home/deploy/dir with 'quote'",
    );
    // shellQuote: '...' with embedded '"'"' escapes; assignment stays one word.
    expect(tricky).toContain("_d='/home/deploy/dir with '\"'\"'quote'\"'\"'");
  });
});
