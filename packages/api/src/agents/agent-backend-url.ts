import { BadRequestException } from "@nestjs/common";
import type { AppConfig } from "../config/app-config.js";

/** Resolve the explicitly configured URL reachable from the target VPS. */
export function resolveAgentBackendUrl(config: AppConfig): string {
  if (!config.agentPublicBaseUrl) {
    throw new BadRequestException(
      "AGENT_PUBLIC_BASE_URL must be configured before installing the agent. Set it to a URL reachable from the target VPS.",
    );
  }

  const url = new URL(config.agentPublicBaseUrl);
  if (url.protocol === "http:" && !config.allowInsecureAgentHttp) {
    throw new BadRequestException(
      "AGENT_PUBLIC_BASE_URL must use HTTPS unless ALLOW_INSECURE_AGENT_HTTP=true is explicitly configured.",
    );
  }

  return config.agentPublicBaseUrl;
}
