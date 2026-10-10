// ── Docker realtime logs transport (step 5) ────────────────────────────
// Strict mirror of `packages/api/src/docker/docker-logs.schemas.ts`:
// every event is shape-validated and bound to the subscription id the
// viewer itself received on the first `waiting` frame. Any mismatch, extra
// key, or malformed payload closes the connection instead of guessing.
//
// Reconnect is intentionally NOT implemented here: the backend treats each
// SSE connection as one ephemeral viewer, and a reconnect is a new viewer
// with a fresh 200-line window. `onerror` therefore always closes and
// surfaces a disconnected state so the user can reconnect explicitly.

/** One rendered log line. `text` never contains a trailing LF. */
export type DockerLogLine = {
  stream: "stdout" | "stderr" | "combined";
  text: string;
  truncated: boolean;
};

/** Safe error codes transported by `docker.logs.closed`. */
export type DockerLogErrorCode =
  | "container_not_found"
  | "target_mismatch"
  | "daemon_unreachable"
  | "logs_unavailable"
  | "invalid_docker_stream"
  | "agent_unavailable"
  | "stream_lost"
  | "slow_consumer"
  | "session_expired";

/** Terminal stream outcome reported by the backend. */
export type DockerLogClosedEvent = {
  reason: "completed" | "failed" | "expired";
  errorCode?: DockerLogErrorCode;
};

export type DockerLogsCallbacks = {
  /** `waiting` right after registration; `live` once the agent opened Docker. */
  onState: (status: "waiting" | "live") => void;
  /** One batch of completed lines, in backend order. */
  onLines: (lines: DockerLogLine[]) => void;
  /** Terminal outcome. The connection is already closed when this fires. */
  onClosed: (event: DockerLogClosedEvent) => void;
  /** Transport/shape failure: the stream is closed, no auto-reconnect. */
  onError: () => void;
};

/** Identity: the pair is the whole target — a key alone is never enough. */
export type DockerLogTarget = {
  agentInstanceId: string;
  containerKey: string;
};

const SSE_EVENT_STATE = "docker.logs.state";
const SSE_EVENT_LINES = "docker.logs.lines";
const SSE_EVENT_CLOSED = "docker.logs.closed";

/**
 * One line per source bound. The agent caps line length at 4 KiB and each
 * batch at 100 lines; a larger batch means the payload is not the contract
 * this viewer speaks, so it is rejected rather than partially rendered.
 */
const MAX_LINES_PER_FRAME = 100;

/** Discriminated shape of a validated `docker.logs.state` frame. */
type DockerLogStateFrame = {
  subscriptionId: string;
  status: "waiting" | "live";
};

/** Discriminated shape of a validated `docker.logs.lines` frame. */
type DockerLogLinesFrame = {
  subscriptionId: string;
  lines: DockerLogLine[];
};

/** Discriminated shape of a validated `docker.logs.closed` frame. */
type DockerLogClosedFrame = {
  subscriptionId: string;
  reason: "completed" | "failed" | "expired";
  errorCode?: DockerLogErrorCode;
};

/**
 * Opaque id charset/bounds from `docker-management.schemas.ts`; the
 * subscription id bound at registration is checked against this too.
 */
function isOpaqueId(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= max &&
    /^[A-Za-z0-9._~-]+$/.test(value)
  );
}

/**
 * A decoded JSON string can still hold lone surrogates (from a `\ud800`
 * escape). The Go agent replaces them with U+FFFD, so accepting them here
 * would diverge from the source; only well-formed pairs are accepted.
 */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/**
 * `.strict()` parity: exactly these keys, no extras, no omissions.
 * `optional` keys may be present or absent, but nothing else may appear.
 */
function matchesShape(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

/**
 * Parses one `docker.logs.state` frame. Mirrors
 * `dockerLogsStateEventSchema` (strict, both keys required, enum status).
 */
function parseStateFrame(raw: unknown): DockerLogStateFrame | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const payload = raw as Record<string, unknown>;
  if (!matchesShape(payload, ["subscriptionId", "status"])) return null;
  if (!isOpaqueId(payload.subscriptionId, 64)) return null;
  if (payload.status !== "waiting" && payload.status !== "live") return null;
  return {
    subscriptionId: payload.subscriptionId,
    status: payload.status,
  };
}

/**
 * Parses one `docker.logs.lines` frame. Mirrors
 * `dockerLogsLinesEventSchema`: strict frame, exact line shape, capped
 * batch. Empty batches are dropped by the caller, not here.
 */
function parseLinesFrame(raw: unknown): DockerLogLinesFrame | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const payload = raw as Record<string, unknown>;
  if (!matchesShape(payload, ["subscriptionId", "lines"])) return null;
  if (!isOpaqueId(payload.subscriptionId, 64)) return null;
  if (!Array.isArray(payload.lines)) return null;
  if (payload.lines.length > MAX_LINES_PER_FRAME) return null;

  const lines: DockerLogLine[] = [];
  for (const entry of payload.lines) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const line = entry as Record<string, unknown>;
    if (
      !matchesShape(line, ["stream", "text", "truncated"])
    ) {
      return null;
    }
    if (
      line.stream !== "stdout" &&
      line.stream !== "stderr" &&
      line.stream !== "combined"
    ) {
      return null;
    }
    if (typeof line.text !== "string" || typeof line.truncated !== "boolean") {
      return null;
    }
    // A line may not carry a bare LF (the backend reconstructs lines by
    // splitting there), but CR is legal: the agent splits only on LF, and
    // CRLF or carriage-return progress output legitimately keeps its CR.
    // Lone surrogates remain rejected — the Go agent rewrites them.
    if (line.text.includes("\n")) return null;
    if (hasLoneSurrogate(line.text)) return null;
    lines.push({
      stream: line.stream,
      text: line.text,
      truncated: line.truncated,
    });
  }
  return { subscriptionId: payload.subscriptionId, lines };
}

/**
 * Parses one `docker.logs.closed` frame. Mirrors
 * `dockerLogsClosedEventSchema`: strict frame, enum reason, optional enum
 * error code that must be omitted rather than null when absent.
 */
function parseClosedFrame(raw: unknown): DockerLogClosedFrame | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const payload = raw as Record<string, unknown>;
  if (!matchesShape(payload, ["subscriptionId", "reason"], ["errorCode"])) {
    return null;
  }
  if (!isOpaqueId(payload.subscriptionId, 64)) return null;
  if (
    payload.reason !== "completed" &&
    payload.reason !== "failed" &&
    payload.reason !== "expired"
  ) {
    return null;
  }
  if ("errorCode" in payload) {
    const code = payload.errorCode;
    if (
      code !== "container_not_found" &&
      code !== "target_mismatch" &&
      code !== "daemon_unreachable" &&
      code !== "logs_unavailable" &&
      code !== "invalid_docker_stream" &&
      code !== "agent_unavailable" &&
      code !== "stream_lost" &&
      code !== "slow_consumer" &&
      code !== "session_expired"
    ) {
      return null;
    }
    return { subscriptionId: payload.subscriptionId, reason: payload.reason, errorCode: code };
  }
  return {
    subscriptionId: payload.subscriptionId,
    reason: payload.reason,
  };
}

/**
 * Opens one SSE viewer for a container.
 *
 * Same-origin EventSource, no cursor and no follow option: the backend
 * decides `tail=200&follow=1`. Every event is strictly validated and must
 * carry the subscription id the viewer learned from its first `waiting`
 * frame; anything else closes the stream. The returned function closes the
 * connection and invalidates all callbacks.
 */
export function subscribeDockerContainerLogs(
  vpsId: string,
  target: DockerLogTarget,
  callbacks: DockerLogsCallbacks,
): () => void {
  const query = new URLSearchParams({
    agentInstanceId: target.agentInstanceId,
    containerKey: target.containerKey,
  });
  const url = `/api/vps/${encodeURIComponent(vpsId)}/docker/management/logs/stream?${query.toString()}`;

  let disposed = false;
  let closed = false;
  /** Learned from the first `waiting` frame; every later frame must match. */
  let subscriptionId: string | null = null;

  const source = new EventSource(url);

  const finish = () => {
    if (closed) return;
    closed = true;
    try {
      source.close();
    } catch {
      // Closing an already-dead socket is not an error state.
    }
  };

  const fail = () => {
    if (disposed || closed) return;
    // Close before notifying so a stale `onerror` cannot override the
    // terminal state the viewer is about to render.
    finish();
    callbacks.onError();
  };

  /**
   * Every frame is bound to the viewer's own subscription. A payload from
   * a different subscription — or any payload before the `waiting` frame
   * established the id — can never be this viewer's data, so it fails the
   * stream instead of rendering foreign lines.
   */
  const matchesSubscription = (frame: {
    subscriptionId: string;
  }): boolean => {
    return subscriptionId !== null && frame.subscriptionId === subscriptionId;
  };

  const decode = (event: Event): unknown => {
    const message = event as MessageEvent;
    if (typeof message.data !== "string") return undefined;
    try {
      return JSON.parse(message.data) as unknown;
    } catch {
      return undefined;
    }
  };

  source.addEventListener(SSE_EVENT_STATE, (event: Event) => {
    if (disposed || closed) return;
    const frame = parseStateFrame(decode(event));
    if (!frame || !matchesSubscription(frame)) {
      // The only frame allowed to arrive without a bound id is the very
      // first `waiting` frame, which is what establishes it.
      if (subscriptionId === null && frame && frame.status === "waiting") {
        subscriptionId = frame.subscriptionId;
        callbacks.onState(frame.status);
        return;
      }
      fail();
      return;
    }
    callbacks.onState(frame.status);
  });

  source.addEventListener(SSE_EVENT_LINES, (event: Event) => {
    if (disposed || closed) return;
    const frame = parseLinesFrame(decode(event));
    if (!frame || !matchesSubscription(frame)) {
      fail();
      return;
    }
    if (frame.lines.length > 0) callbacks.onLines(frame.lines);
  });

  source.addEventListener(SSE_EVENT_CLOSED, (event: Event) => {
    if (disposed) return;
    const frame = parseClosedFrame(decode(event));
    if (!frame || !matchesSubscription(frame)) {
      fail();
      return;
    }
    // A valid terminal frame closes the connection first so the browser's
    // own `onerror` (fired by end-of-response) cannot overwrite the state.
    finish();
    callbacks.onClosed({
      reason: frame.reason,
      ...(frame.errorCode !== undefined
        ? { errorCode: frame.errorCode }
        : {}),
    });
  });

  // No auto-reconnect: a reconnect would be a new viewer with a new
  // subscription id, and silently doing that here would abandon the
  // identity the user is watching. Surfacing it is the caller's job.
  source.onerror = () => {
    if (disposed) return;
    fail();
  };

  return () => {
    disposed = true;
    finish();
  };
}
