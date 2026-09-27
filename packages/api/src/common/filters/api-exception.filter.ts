import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { DockerManagementConflict } from "../../docker/docker-management.models.js";
import {
  AgentAuthError,
  DemoMutationBlockedError,
  DemoSshDisabledError,
  DuplicateAgentInstallError,
  SshHostBlockedError,
  SshHostKeyScanFailedError,
  SshHostKeyTrustRequiredError,
  SshOperationError,
  VpsNotFoundError,
} from "../errors.js";
import { safeErrorMessage } from "../redaction.js";

function errorBody(
  message: string,
  _requestId?: string,
  extra?: Record<string, string>,
) {
  return { error: { message, ...extra } };
}

export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = request.requestId;

    if (error instanceof ZodError) {
      return response.status(400).json(errorBody("Invalid request", requestId));
    }

    if (error instanceof VpsNotFoundError) {
      return response.status(404).json(errorBody("VPS not found", requestId));
    }

    if (error instanceof DockerManagementConflict) {
      return response.status(409).json(errorBody("Docker management operation conflict", requestId));
    }

    if (
      error instanceof DemoMutationBlockedError ||
      error instanceof DemoSshDisabledError ||
      error instanceof SshHostBlockedError
    ) {
      return response
        .status(403)
        .json(errorBody(safeErrorMessage(error), requestId));
    }

    if (error instanceof SshOperationError) {
      return response
        .status(502)
        .json(errorBody(safeErrorMessage(error), requestId));
    }

    if (error instanceof SshHostKeyScanFailedError) {
      return response
        .status(502)
        .json(errorBody(safeErrorMessage(error), requestId));
    }

    if (error instanceof SshHostKeyTrustRequiredError) {
      return response.status(409).json({
        error: {
          message: safeErrorMessage(error),
          ...error.info,
        },
      });
    }

    if (error instanceof AgentAuthError) {
      return response
        .status(401)
        .json(errorBody(safeErrorMessage(error), requestId));
    }

    if (error instanceof DuplicateAgentInstallError) {
      return response
        .status(409)
        .json(errorBody(safeErrorMessage(error), requestId));
    }

    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return response
        .status(404)
        .json(errorBody("Required resource not found", requestId));
    }

    if (error instanceof HttpException) {
      const payload = error.getResponse();
      const responseBody =
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>)
          : undefined;

      // Standard NestJS HttpException responses are
      // { statusCode, message, error } where `error` is the HTTP error name
      // (a plain string). Nested payloads are { error: { message } }.
      // Prefer the nested error.message when truly nested, otherwise use the
      // top-level message string. Array messages (validation detail lists)
      // and other non-string payloads intentionally fall through to the safe
      // generic response.
      const nestedError =
        responseBody &&
        typeof responseBody.error === "object" &&
        responseBody.error !== null
          ? (responseBody.error as Record<string, unknown>)
          : undefined;
      let message: unknown;
      if (responseBody) {
        if (
          nestedError &&
          typeof nestedError.message === "string"
        ) {
          message = nestedError.message;
        } else if (typeof responseBody.message === "string") {
          message = responseBody.message;
        }
      } else {
        message = error.message;
      }

      // Whitelist machine-readable contract fields (e.g. error codes, the
      // conflicting job id, and the incompatibility reason) from nested payloads.
      const extra: Record<string, string> = {};
      if (nestedError) {
        if (typeof nestedError.code === "string") {
          extra.code = nestedError.code;
        }
        if (typeof nestedError.jobId === "string") {
          extra.jobId = nestedError.jobId;
        }
        if (typeof nestedError.reason === "string") {
          extra.reason = nestedError.reason;
        }
      }

      return response
        .status(error.getStatus())
        .json(
          errorBody(
            typeof message === "string"
              ? safeErrorMessage(message)
              : "Request failed",
            requestId,
            extra,
          ),
        );
    }

    return response
      .status(500)
      .json(errorBody("Internal server error", requestId));
  }
}

Catch()(ApiExceptionFilter);
