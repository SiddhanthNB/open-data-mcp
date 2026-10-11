import { SpanStatusCode } from "@opentelemetry/api";

import type { AuthEnv, WorkerHandler } from "../auth";
import {
  logger,
  resolveLogLevel,
  sanitizeErrorMessage,
  withLogLevel,
} from "./logger";
import {
  configureTracing,
  traceIdAsUuid,
  withRequestSpan,
} from "./tracing";

const requestIdHeader = "X-Request-ID";

function exposeRequestId(headers: Headers): void {
  const exposed = (headers.get("Access-Control-Expose-Headers") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!exposed.some((value) => value.toLowerCase() === "x-request-id")) {
    exposed.push(requestIdHeader);
  }
  headers.set("Access-Control-Expose-Headers", exposed.join(", "));
}

function withRequestId(response: Response, requestId: string): Response {
  const observed = new Response(response.body, response);
  observed.headers.set(requestIdHeader, requestId);
  exposeRequestId(observed.headers);
  return observed;
}

function internalErrorResponse(): Response {
  return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
}

function requestSpanName(request: Request): string {
  const pathname = new URL(request.url).pathname;
  return `HTTP ${request.method.toUpperCase()} ${pathname.slice(0, 120)}`;
}

export function createObservedWorkerHandler(
  handler: WorkerHandler,
): WorkerHandler {
  configureTracing();
  return {
    async fetch(request, env, context) {
      const logLevel = resolveLogLevel(env.OPEN_DATA_MCP_LOG_LEVEL);
      const pathname = new URL(request.url).pathname;
      if (pathname === "/ping") {
        return withLogLevel(logLevel, () => {
          logger.debug("Health check completed");
          return Response.json({ status: "ok" });
        });
      }

      return withRequestSpan(
        requestSpanName(request),
        logLevel,
        async (span) => {
          const requestId = traceIdAsUuid(span.spanContext().traceId);
          let response: Response;
          try {
            response = await handler.fetch(request, env, context);
          } catch (error) {
            logger.error(
              `Unhandled request error: ${sanitizeErrorMessage(error)}`,
            );
            response = internalErrorResponse();
          }

          span.setAttribute("http.response.status_code", response.status);
          if (response.status >= 400) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.setAttribute("outcome", "failed");
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
            span.setAttribute("outcome", "success");
          }
          return withRequestId(response, requestId);
        },
      );
    },
  };
}
