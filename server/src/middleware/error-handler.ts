import type { Request, Response, NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import { ZodError } from "zod";

/** Upper bound on caller-supplied key names echoed back in a validation error. */
const MAX_ECHOED_UNRECOGNIZED_KEYS = 10;
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { captureException } from "../sentry.js";
import { COMPANY_IMPORT_API_PATH } from "../routes/company-import-paths.js";
import { logger } from "./logger.js";
import { isSecretSensitiveHttpRequest } from "./http-log-policy.js";
import {
  collectSensitiveStringValues,
  redactSensitiveValueOccurrences,
} from "./redact-sensitive.js";
import { recordResponsibleUserDenialOnActiveRun } from "../services/responsible-user-denial-run-outcomes.js";

export interface ErrorContext {
  error: {
    message: string;
    stack?: string;
    name?: string;
    details?: unknown;
    raw?: unknown;
  };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function isRedactedSkillPolicyDenial(details: Record<string, unknown> | null) {
  return details?.code === "skill_policy_denied";
}

function readZodIssues(err: unknown): unknown[] | null {
  if (err instanceof ZodError) return err.issues;
  if (
    !err ||
    typeof err !== "object" ||
    (err as { name?: unknown }).name !== "ZodError"
  )
    return null;
  const issues = (err as { issues?: unknown }).issues;
  return Array.isArray(issues) ? issues : null;
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

function sanitizeSecretSensitiveError(req: Request, error: Error): Error {
  if (!isSecretSensitiveHttpRequest(req.method, req.originalUrl)) return error;
  const sanitized = new Error("Secret-sensitive request failed");
  // Both `name` and `message` are attacker/provider-controlled properties on
  // JavaScript errors. Do not preserve either on a credential-bearing route.
  sanitized.name = "Error";
  return sanitized;
}

function sanitizeSecretSensitiveResponse(
  req: Request,
  value: unknown,
): unknown {
  if (!isSecretSensitiveHttpRequest(req.method, req.originalUrl)) return value;
  return redactSensitiveValueOccurrences(
    value,
    collectSensitiveStringValues(req.body),
  );
}

/** Report a server-side crash to every error sink. */
function reportCrash(error: Error): void {
  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: error.name });
  captureException(error);
}

function getPaperclipDb(req: Request): Db | null {
  const locals = req.app?.locals as { paperclipDb?: Db; db?: Db } | undefined;
  return locals?.paperclipDb ?? locals?.db ?? null;
}

function recordResponsibleUserDenialFromHttpError(
  req: Request,
  details: Record<string, unknown> | null,
) {
  if (req.actor?.type !== "agent") return;
  const db = getPaperclipDb(req);
  if (!db) return;

  void recordResponsibleUserDenialOnActiveRun(db, {
    runId: req.actor.runId ?? null,
    agentId: req.actor.agentId ?? null,
    companyId: req.actor.companyId ?? null,
    code: details?.code,
  }).catch((recordErr) => {
    logger.warn(
      {
        err: recordErr,
        runId: req.actor?.runId ?? null,
        agentId:
          req.actor?.type === "agent" ? (req.actor.agentId ?? null) : null,
      },
      "failed to record responsible-user denial on heartbeat run",
    );
  });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    const details =
      err.details &&
      typeof err.details === "object" &&
      !Array.isArray(err.details)
        ? (err.details as Record<string, unknown>)
        : null;
    const redactedSkillPolicyDenial = isRedactedSkillPolicyDenial(details);
    const workspaceRepairPreconditionFailure =
      details?.code === "workspace_repair_precondition_failed";
    const structuredConnectionError = new Set([
      "user_authorization_required",
      "organization_authorization_required",
      "grant_audience_denied",
      "grant_revoked",
      "needs_reauthorization",
      "installation_required",
      "connection_not_installed",
      "subject_not_permitted",
      "standing_delegation_required",
      "grant_owner_membership_inactive",
    ]).has(typeof details?.code === "string" ? details.code : "");
    const responseDetailsValue = sanitizeSecretSensitiveResponse(
      req,
      err.details,
    );
    const responseDetails =
      responseDetailsValue &&
      typeof responseDetailsValue === "object" &&
      !Array.isArray(responseDetailsValue)
        ? (responseDetailsValue as Record<string, unknown>)
        : null;
    recordResponsibleUserDenialFromHttpError(req, details);
    if (err.status >= 500) {
      const reportableError = sanitizeSecretSensitiveError(req, err);
      attachErrorContext(
        req,
        res,
        isSecretSensitiveHttpRequest(req.method, req.originalUrl)
          ? { message: reportableError.message, name: reportableError.name }
          : {
              message: err.message,
              stack: err.stack,
              name: err.name,
              details: err.details,
            },
        reportableError,
      );
      reportCrash(reportableError);
    }
    const secretSensitiveServerError =
      err.status >= 500 &&
      isSecretSensitiveHttpRequest(req.method, req.originalUrl);
    res.status(err.status).json(
      secretSensitiveServerError
        ? { error: "Internal server error" }
        : {
            error: sanitizeSecretSensitiveResponse(req, err.message),
            ...(typeof responseDetails?.code === "string"
              ? { code: responseDetails.code }
              : {}),
            ...(redactedSkillPolicyDenial &&
            typeof responseDetails?.reason === "string"
              ? { reason: responseDetails.reason }
              : {}),
            ...(workspaceRepairPreconditionFailure &&
            typeof responseDetails?.reason === "string"
              ? { reason: responseDetails.reason }
              : {}),
            ...(workspaceRepairPreconditionFailure &&
            typeof responseDetails?.repairPhase === "string"
              ? { repairPhase: responseDetails.repairPhase }
              : {}),
            ...(typeof responseDetails?.remediation === "string" ||
            (structuredConnectionError &&
              responseDetails?.remediation &&
              typeof responseDetails.remediation === "object")
              ? { remediation: responseDetails.remediation }
              : {}),
            ...(structuredConnectionError && responseDetails?.connection
              ? { connection: responseDetails.connection }
              : {}),
            ...(structuredConnectionError && responseDetails?.subject
              ? { subject: responseDetails.subject }
              : {}),
            ...(structuredConnectionError &&
            typeof responseDetails?.grantId === "string"
              ? { grantId: responseDetails.grantId }
              : {}),
            ...(!redactedSkillPolicyDenial &&
            !workspaceRepairPreconditionFailure &&
            responseDetailsValue
              ? { details: responseDetailsValue }
              : {}),
          },
    );
    return;
  }

  const zodIssues = readZodIssues(err);
  if (zodIssues) {
    // Name unrecognized fields in `error` itself: a caller that misspells a field otherwise sees a
    // generic message and has to dig through `details` to learn which key was rejected.
    const unrecognizedKeys = [
      ...new Set(
        (zodIssues as any[]).flatMap((issue) =>
          issue.code === "unrecognized_keys"
            ? issue.keys.map((key: unknown) => [...issue.path, String(key).slice(0, 64)].join("."))
            : [],
        ),
      ),
    ];
    // Key names are caller-supplied, so echo a bounded sample rather than the whole set: a body
    // with thousands of unknown keys would otherwise turn a small request into a huge response.
    const sampledKeys = unrecognizedKeys.slice(0, MAX_ECHOED_UNRECOGNIZED_KEYS);
    const omittedKeyCount = unrecognizedKeys.length - sampledKeys.length;
    res.status(400).json({
      error:
        unrecognizedKeys.length > 0
          ? // #13038 applies to this message too: the key names come from the request
            // body, so on a credential-bearing route an unrecognized key whose *name*
            // is a submitted secret would otherwise be echoed back verbatim. Upstream's
            // constant "Validation error" needs no sanitizing, so it is left untouched.
            sanitizeSecretSensitiveResponse(
              req,
              `Unrecognized field(s): ${sampledKeys.join(", ")}${
                omittedKeyCount > 0 ? ` (and ${omittedKeyCount} more)` : ""
              }`,
            )
          : "Validation error",
      // #13038: zod issues can echo request values on credential-bearing routes.
      details: sanitizeSecretSensitiveResponse(req, zodIssues),
    });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));

  // The client tore down the connection mid-request (closed tab, dropped
  // mobile network, cancelled upload): Node surfaces it as `Error: aborted`
  // with ECONNRESET. There is no server fault to report and nobody left to
  // answer, so skip the error sinks and just close out the response.
  if (
    rootError.message === "aborted" &&
    (rootError as NodeJS.ErrnoException).code === "ECONNRESET"
  ) {
    if (!res.headersSent) res.status(499);
    res.end();
    return;
  }

  const reportableError = sanitizeSecretSensitiveError(req, rootError);
  attachErrorContext(
    req,
    res,
    isSecretSensitiveHttpRequest(req.method, req.originalUrl)
      ? { message: reportableError.message, name: reportableError.name }
      : err instanceof Error
        ? { message: err.message, stack: err.stack, name: err.name }
        : {
            message: String(err),
            raw: err,
            stack: rootError.stack,
            name: rootError.name,
          },
    reportableError,
  );

  reportCrash(reportableError);

  res.status(500).json({
    error: "Internal server error",
    ...(shouldExposeTrustedCloudTenantImportError(req)
      ? { message: rootError.message }
      : {}),
  });
}

function shouldExposeTrustedCloudTenantImportError(req: Request) {
  return (
    req.actor?.source === "cloud_tenant" &&
    req.method === "POST" &&
    req.originalUrl.split("?")[0] === COMPANY_IMPORT_API_PATH
  );
}
