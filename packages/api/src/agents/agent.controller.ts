import { Body, Controller, HttpCode, Inject, Post, Req, Param, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { AgentMetricPayload } from "./agent.models.js";
import { AgentService, type IngestMetricResult } from "./agent.service.js";
import { DockerManagementService } from "../docker/docker-management.service.js";
import {
  agentCommandClaimRequestSchema,
  agentCommandReportSchema,
  dockerManagementClaimSchema,
  dockerManagementResultSchema,
} from "../docker/docker-management.schemas.js";

/**
 * Extended response for successful metric ingest.
 * Returns runtime config so the agent can learn dashboard intent.
 * Never exposes credential ids or token details.
 */
type AgentIngestResponse = {
  data: {
    ok: true;
    vpsId: string;
    receivedAt: string;
    config: IngestMetricResult["config"];
    docker?: IngestMetricResult["docker"];
  };
};

@Controller("api/agent")
export class AgentController {
  constructor(
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(DockerManagementService) private readonly management: DockerManagementService,
  ) {}

  /**
   * POST /api/agent/metrics
   *
   * Accepts agent metric payloads authenticated via Bearer token.
   * Token format: vma_<credentialId>_<secret>
   */
  @Post("metrics")
  async ingestMetrics(
    @Req() req: Request,
    @Body() body: AgentMetricPayload,
  ): Promise<AgentIngestResponse> {
    // 1. Authenticate via bearer token
    const authHeader = req.header("authorization");
    const credential = await this.agentService.verifyAgentBearerToken(authHeader);

    // 2. Ingest the metric payload
    // ZodError from schema validation propagates to the global exception filter
    // and results in a 400 Bad Request.
    const { sample, config, docker } = await this.agentService.ingestMetric(
      credential,
      body,
      req.ip,
    );

    return {
      data: {
        ok: true,
        vpsId: sample.vpsId,
         receivedAt: sample.receivedAt!,
         config,
         ...(docker ? { docker } : {}),
       },
    };
  }

  /**
   * POST /api/agent/commands/claim
   *
   * The agent's durable command pull: body {agentInstanceId}, answered with
   * {"data":{"command":{...}|null}}. Null covers an empty queue and every
   * denied state (management disabled or system-managed host), so policy
   * state never leaks; 401 stays reserved for credential problems.
   */
  @Post("commands/claim")
  @HttpCode(200)
  async claimCommand(@Req() req: Request, @Body() body: unknown) {
    const credential = await this.agentService.verifyAgentBearerToken(
      req.header("authorization"),
    );
    const input = agentCommandClaimRequestSchema.parse(body);
    return {
      data: {
        command: await this.management.claimForAgent(
          credential.vpsId,
          input.agentInstanceId,
        ),
      },
    };
  }

  /**
   * POST /api/agent/commands/result
   *
   * Terminal receipt echo:
   * {"data":{"ok":true,"commandId":"...","agentInstanceId":"..."}} — ids must
   * match the report exactly; the agent only commits its durable receipt on
   * this echo.
   */
  @Post("commands/result")
  @HttpCode(200)
  async reportCommandResult(@Req() req: Request, @Body() body: unknown) {
    const credential = await this.agentService.verifyAgentBearerToken(
      req.header("authorization"),
    );
    const report = agentCommandReportSchema.parse(body);
    return {
      data: await this.management.resultForAgent(credential.vpsId, report),
    };
  }

  @Post("docker-management/:vpsId/:operationId/claim")
  async claim(@Param("vpsId") vpsId: string, @Param("operationId") operationId: string, @Req() req: Request, @Body() body: unknown) {
    const credential = await this.agentService.verifyAgentBearerToken(req.header("authorization"));
    if (credential.vpsId !== vpsId) throw new UnauthorizedException();
    const input = dockerManagementClaimSchema.parse(body);
    const agentIdentity = req.header("x-agent-instance");
    if (!agentIdentity || input.claimedBy !== agentIdentity) {
      throw new UnauthorizedException({ error: { message: "Agent identity mismatch" } });
    }
    return { data: this.management.claim(vpsId, operationId, agentIdentity) };
  }

  @Post("docker-management/:vpsId/:operationId/result")
  async result(@Param("vpsId") vpsId: string, @Param("operationId") operationId: string, @Req() req: Request, @Body() body: unknown) {
    const credential = await this.agentService.verifyAgentBearerToken(req.header("authorization"));
    if (credential.vpsId !== vpsId) throw new UnauthorizedException();
    const input = dockerManagementResultSchema.parse(body);
    return { data: this.management.result(vpsId, operationId, req.header("x-agent-instance") ?? "", input) };
  }
}
