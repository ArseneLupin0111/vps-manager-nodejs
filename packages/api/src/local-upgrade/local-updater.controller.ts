import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import type { AgentCredential } from "../agents/agent.models.js";
import { AgentService } from "../agents/agent.service.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import { VPS_REPOSITORY } from "../tokens.js";
import {
  localUpdaterProgressSchema,
  localUpdaterResultSchema,
} from "./local-upgrade.schemas.js";
import { isLocalHostVps, LocalUpgradeService } from "./local-upgrade.service.js";

/**
 * Pull-only updater API. Authenticated by a dedicated bearer credential
 * scoped `local-updater` (never the metrics/agent credential), bound to the
 * local host VPS record. No dashboard session, no Origin check: the updater
 * is a headless client; scope + local binding are the authorization.
 */
@Controller("api/local-updater")
export class LocalUpdaterController {
  constructor(
    @Inject(LocalUpgradeService)
    private readonly service: LocalUpgradeService,
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(VPS_REPOSITORY) private readonly vps: VpsRepository,
  ) {}

  @Post("jobs/claim")
  @HttpCode(200)
  async claim(@Req() req: Request) {
    const credential = await this.authenticate(req);
    const claim = await this.service.claim(credential);
    if (!claim) return { data: { job: null } };
    return {
      data: {
        job: claim.job,
        requiresReconcile: claim.requiresReconcile,
      },
    };
  }

  @Post("jobs/:jobId/progress")
  @HttpCode(200)
  async progress(
    @Req() req: Request,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
  ) {
    const credential = await this.authenticate(req);
    const input = localUpdaterProgressSchema.parse(body);
    const job = await this.service.progress(credential, jobId, input);
    return { data: { job } };
  }

  @Post("jobs/:jobId/result")
  @HttpCode(200)
  async result(
    @Req() req: Request,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
  ) {
    const credential = await this.authenticate(req);
    const input = localUpdaterResultSchema.parse(body);
    const outcome = await this.service.result(credential, jobId, input);
    return {
      data: {
        job: outcome.job,
        ...(outcome.awaitHeartbeat ? { awaitHeartbeat: true as const } : {}),
      },
    };
  }

  @Get("jobs/:jobId")
  async getJob(@Req() req: Request, @Param("jobId") jobId: string) {
    const credential = await this.authenticate(req);
    return { data: { job: await this.service.getUpdaterJob(credential, jobId) } };
  }

  private async authenticate(req: Request): Promise<AgentCredential> {
    const credential = await this.agentService.verifyBearerToken(
      req.header("authorization"),
    );
    if (credential.scope !== "local-updater") {
      throw new ForbiddenException({
        error: {
          message: "Credential is not scoped for the local updater",
          code: "invalid_credential_scope",
        },
      });
    }
    const vps = await this.vps.get(credential.vpsId);
    if (!vps || !isLocalHostVps(vps)) {
      throw new ForbiddenException({
        error: {
          message: "Updater credential is not bound to a local host",
          code: "invalid_credential_scope",
        },
      });
    }
    return credential;
  }
}
