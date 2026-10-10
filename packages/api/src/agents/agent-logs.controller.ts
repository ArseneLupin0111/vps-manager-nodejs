import { Body, Controller, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { AgentService } from "../agents/agent.service.js";
import type { AgentCredential } from "../agents/agent.models.js";
import {
  DockerLogsProtocolError,
  DockerLogsService,
} from "../docker/docker-logs.service.js";
import type { DockerLogsSubscription } from "../docker/docker-logs.service.js";
import {
  DOCKER_LOGS_MAX_BODY_BYTES,
  dockerLogsClaimRequestSchema,
} from "../docker/docker-logs.schemas.js";

/**
 * Agent-facing routes for the realtime log broker (`/api/agent/logs`).
 *
 * Auth is the agent bearer token, verified by the same scope-isolated helper
 * used for metrics and commands: the local-updater credential is rejected.
 * Every route binds the credential's vpsId to the subscription it touches, so
 * a credential for one VPS can neither claim nor write another VPS's stream.
 * Unknown subscription ids answer 404 and closed ones 410, so a caller can
 * never learn whether an id it does not own exists.
 */
@Controller("api/agent/logs")
export class AgentLogsController {
  constructor(
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(DockerLogsService) private readonly logs: DockerLogsService,
  ) {}

  /**
   * POST /api/agent/logs/claim — body `{agentInstanceId}` answers
   * `{data:{subscription:null|ClaimedSubscription}}`. Null covers an empty
   * queue and every denied policy state, mirroring the command claim:
   * policy never leaks, and 401 stays reserved for credential problems.
   * Claim is FIFO by viewer-open order and flips waiting -> claimed once.
   */
  @Post("claim")
  @HttpCode(200)
  async claim(
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<{ data: { subscription: DockerLogsSubscription | null } }> {
    this.assertBodyWithinBounds(req, body);
    const input = dockerLogsClaimRequestSchema.parse(body);
    const credential = await this.verify(req);
    const subscription = await this.logs.claim(credential, input);
    return { data: { subscription } };
  }

  /**
   * POST /api/agent/logs/:subscriptionId/chunks — one ordered batch or
   * heartbeat. Sequence must be the next expected number (409 otherwise),
   * because a blind retry of an already-delivered batch duplicates lines in
   * the viewer. Sequence 1 with `ready:true` is the moment the Docker source
   * answered 2xx, which flips the viewer to `live`.
   */
  @Post(":subscriptionId/chunks")
  @HttpCode(200)
  async chunks(
    @Req() req: Request,
    @Param("subscriptionId") subscriptionId: string,
    @Body() body: unknown,
  ): Promise<{ data: { ok: true; subscriptionId: string; sequence: number } }> {
    this.assertBodyWithinBounds(req, body);
    const credential = await this.verify(req);
    const data = await this.logs.chunks(credential, subscriptionId, body);
    return { data };
  }

  /**
   * POST /api/agent/logs/:subscriptionId/result — terminal outcome.
   * `completed` only on a clean Docker EOF; `failed` carries one safe error
   * code. The response echoes the ids so the agent can stop retrying; the
   * daemon's error body never crosses the wire.
   */
  @Post(":subscriptionId/result")
  @HttpCode(200)
  async result(
    @Req() req: Request,
    @Param("subscriptionId") subscriptionId: string,
    @Body() body: unknown,
  ): Promise<{ data: { ok: true; subscriptionId: string; agentInstanceId: string } }> {
    this.assertBodyWithinBounds(req, body);
    const credential = await this.verify(req);
    const data = await this.logs.result(credential, subscriptionId, body);
    return { data };
  }

  private async verify(req: Request): Promise<AgentCredential> {
    return this.agentService.verifyAgentBearerToken(req.header("authorization"));
  }
  /**
   * Body-size guard for the shared JSON parser, which has no per-route cap.
   * The log contract already bounds serialized batches at 32 KiB in
   * `dockerLogsChunksRequestSchema`; this rejects oversized payloads before
   * that parse so the parser never allocates on unbounded input.
   */
  private assertBodyWithinBounds(req: Request, body: unknown): void {
    if ("rawBody" in req) {
      const rawBody = req.rawBody;
      if (Buffer.isBuffer(rawBody) && rawBody.length > DOCKER_LOGS_MAX_BODY_BYTES) {
        throw new DockerLogsProtocolError(400, "body_too_large");
      }
    }
    const contentLength = Number(req.header("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > DOCKER_LOGS_MAX_BODY_BYTES
    ) {
      throw new DockerLogsProtocolError(400, "body_too_large");
    }
    if (body === undefined || body === null) return;
    const size = Buffer.byteLength(JSON.stringify(body), "utf8");
    if (size > DOCKER_LOGS_MAX_BODY_BYTES) {
      throw new DockerLogsProtocolError(400, "body_too_large");
    }
  }
}
