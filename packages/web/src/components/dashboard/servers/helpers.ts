/** Format byte counts in explicit binary units (B/KiB/MiB/GiB/TiB). */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "n/a";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let next = value;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  return `${next >= 10 || index === 0 ? next.toFixed(0) : next.toFixed(1)} ${units[index]}`;
}

/** Map Docker error codes to human-readable messages. */
export function formatDockerError(errorCode?: string): string {
  const labels: Record<string, string> = {
    socket_missing: "Docker socket was not found. Check that Docker is installed and running.",
    permission_denied: "The agent does not have permission to read the Docker socket.",
    timeout: "Docker took too long to respond. We’ll try again automatically.",
    daemon_unreachable: "The Docker daemon cannot be reached right now.",
    unsupported_os: "Docker monitoring is not supported on this operating system.",
    bad_response: "Docker returned a response the agent could not read.",
  };
  return labels[errorCode || ""] || "Docker metrics are unavailable right now.";
}
