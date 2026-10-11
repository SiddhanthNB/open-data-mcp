import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import {
  contextWithLogLevel,
  emitFlatLog,
  sanitizeLogText,
  type LogIdentifiers,
  type LogLevel,
  type LogSeverity,
} from "./logger";
import { WorkerContextManager } from "./context";

export const SERVICE_NAME = "open-data-mcp";
const appScope = SERVICE_NAME;
const httpScope = `${SERVICE_NAME}.library.http`;
const redisScope = `${SERVICE_NAME}.library.redis`;
const loggedAttributes = [
  "mcp.tool.name",
  "source",
  "outcome",
  "error.type",
  "http.response.status_code",
] as const;

type SpanLogEmitter = (
  severity: LogSeverity,
  message: string,
  identifiers: LogIdentifiers,
) => void;

class NoPropagation implements TextMapPropagator {
  inject<Carrier>(
    _context: Context,
    _carrier: Carrier,
    _setter: TextMapSetter<Carrier>,
  ): void {}

  extract<Carrier>(
    parent: Context,
    _carrier: Carrier,
    _getter: TextMapGetter<Carrier>,
  ): Context {
    return parent;
  }

  fields(): string[] {
    return [];
  }
}

function durationMilliseconds(span: ReadableSpan): number {
  return Math.round(
    (span.duration[0] * 1_000 + span.duration[1] / 1_000_000) * 100,
  ) / 100;
}

function statusName(span: ReadableSpan): string {
  switch (span.status.code) {
    case SpanStatusCode.OK:
      return "OK";
    case SpanStatusCode.ERROR:
      return "ERROR";
    default:
      return "UNSET";
  }
}

function printableAttribute(value: unknown): string | undefined {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return undefined;
  }
  return sanitizeLogText(value, 160);
}

export class FlatLogSpanProcessor implements SpanProcessor {
  constructor(private readonly emit: SpanLogEmitter = emitFlatLog) {}

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    const severity: LogSeverity =
      span.kind === SpanKind.SERVER ||
      span.instrumentationScope.name === appScope
        ? "info"
        : "debug";
    const parent = span.parentSpanContext?.spanId ?? "-";
    const fields = [
      `[name: ${sanitizeLogText(span.name, 160)}]`,
      `[parent: ${parent}]`,
      `[duration_ms: ${durationMilliseconds(span)}]`,
      `[status: ${statusName(span)}]`,
    ];

    for (const key of loggedAttributes) {
      const value = printableAttribute(span.attributes[key]);
      if (value !== undefined) {
        fields.push(`[${key}: ${value}]`);
      }
    }

    const spanContext = span.spanContext();
    this.emit(severity, `${fields.join(" ")} Span ended`, {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
    });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

let configured = false;

export function configureTracing(): void {
  if (configured) {
    return;
  }

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": SERVICE_NAME }),
    spanProcessors: [new FlatLogSpanProcessor()],
  });
  context.setGlobalContextManager(
    new WorkerContextManager().enable(),
  );
  propagation.setGlobalPropagator(new NoPropagation());
  trace.setGlobalTracerProvider(provider);
  configured = true;
}

function errorType(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return sanitizeLogText(error.code, 80);
  }
  if (error instanceof Error && error.name) {
    return sanitizeLogText(error.name, 80);
  }
  return "UnknownError";
}

function recordFailure(span: Span, error: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.setAttribute("outcome", "failed");
  span.setAttribute("error.type", errorType(error));
}

interface SpanOptions {
  readonly attributes?: Attributes;
  readonly parent?: Context;
  readonly successOutcome?: string | false;
}

async function inSpan<T>(
  tracerScope: string,
  name: string,
  kind: SpanKind,
  operation: (span: Span) => Promise<T>,
  options: SpanOptions = {},
): Promise<T> {
  configureTracing();
  const tracer = trace.getTracer(tracerScope);
  const run = async (span: Span): Promise<T> => {
    try {
      const result = await operation(span);
      if (options.successOutcome !== false) {
        span.setStatus({ code: SpanStatusCode.OK });
        span.setAttribute("outcome", options.successOutcome ?? "success");
      }
      return result;
    } catch (error) {
      recordFailure(span, error);
      throw error;
    } finally {
      span.end();
    }
  };

  if (options.parent !== undefined) {
    return tracer.startActiveSpan(
      name,
      { kind, attributes: options.attributes },
      options.parent,
      run,
    );
  }
  return tracer.startActiveSpan(
    name,
    { kind, attributes: options.attributes },
    run,
  );
}

function responseEndingWithSpan(
  response: Response,
  span: Span,
  activeContext: Context,
): Response {
  if (response.body === null) {
    span.end();
    return response;
  }

  const reader = response.body.getReader();
  let ended = false;
  const end = (): void => {
    if (!ended) {
      ended = true;
      span.end();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await context.with(activeContext, () => reader.read());
        if (chunk.done) {
          controller.close();
          end();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        recordFailure(span, error);
        controller.error(error);
        end();
      }
    },
    async cancel(reason) {
      try {
        await context.with(activeContext, () => reader.cancel(reason));
      } finally {
        end();
      }
    },
  });
  return new Response(body, response);
}

export async function withRequestSpan(
  name: string,
  logLevel: LogLevel,
  operation: (span: Span) => Promise<Response>,
): Promise<Response> {
  configureTracing();
  const tracer = trace.getTracer(appScope);
  return tracer.startActiveSpan(
    name,
    { kind: SpanKind.SERVER },
    contextWithLogLevel(ROOT_CONTEXT, logLevel),
    async (span) => {
      try {
        const response = await operation(span);
        return responseEndingWithSpan(response, span, context.active());
      } catch (error) {
        recordFailure(span, error);
        span.end();
        throw error;
      }
    },
  );
}

export async function withAppSpan<T>(
  name: string,
  attributes: Attributes,
  operation: (span: Span) => Promise<T>,
  successOutcome: string | false = "success",
): Promise<T> {
  return inSpan(appScope, name, SpanKind.INTERNAL, operation, {
    attributes,
    successOutcome,
  });
}

export async function withHttpSpan<T>(
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return inSpan(httpScope, "http.client", SpanKind.CLIENT, operation, {
    successOutcome: false,
  });
}

export async function withRedisSpan<T>(
  attributes: Attributes,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return inSpan(redisScope, "redis.rate_limit", SpanKind.CLIENT, operation, {
    attributes,
    successOutcome: false,
  });
}

export function traceIdAsUuid(traceId: string): string {
  if (!/^[0-9a-f]{32}$/u.test(traceId)) {
    throw new Error("Cannot format an invalid trace ID as a UUID");
  }
  return `${traceId.slice(0, 8)}-${traceId.slice(8, 12)}-${traceId.slice(12, 16)}-${traceId.slice(16, 20)}-${traceId.slice(20)}`;
}
