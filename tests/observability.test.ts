import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
} from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";

import { createTracedFetch } from "../src/observability/http";
import {
  formatLogLine,
  logger,
  sanitizeErrorMessage,
  withLogLevel,
} from "../src/observability/logger";
import {
  configureTracing,
  FlatLogSpanProcessor,
  traceIdAsUuid,
} from "../src/observability/tracing";

const traceId = "1234567890abcdef1234567890abcdef";
const spanId = "1234567890abcdef";

function readableSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: "provider\nquery",
    kind: SpanKind.SERVER,
    spanContext: () => ({ traceId, spanId, traceFlags: TraceFlags.SAMPLED }),
    parentSpanContext: {
      traceId,
      spanId: "fedcba0987654321",
      traceFlags: TraceFlags.SAMPLED,
    },
    startTime: [1, 0],
    endTime: [1, 812_400_000],
    duration: [0, 812_400_000],
    status: { code: SpanStatusCode.ERROR },
    attributes: {
      source: "data_gov_ie",
      outcome: "failed",
      "error.type": "RateLimitError",
      "http.response.status_code": 429,
      secret: "must-not-be-logged",
    },
    links: [],
    events: [],
    ended: true,
    resource: {} as ReadableSpan["resource"],
    instrumentationScope: { name: "ireland-open-data-mcp" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ...overrides,
  };
}

describe("flat OpenTelemetry logging", () => {
  it("writes one flat whitelisted span-end line with IDs and timing", () => {
    const lines: Array<{ severity: string; line: string }> = [];
    const processor = new FlatLogSpanProcessor(
      (severity, message, identifiers) => {
        lines.push({
          severity,
          line: formatLogLine(severity, message, identifiers),
        });
      },
    );

    processor.onEnd(readableSpan());

    expect(lines).toHaveLength(1);
    expect(lines[0]?.severity).toBe("info");
    expect(lines[0]?.line).toBe(
      "[INFO] [trace: 1234567890abcdef1234567890abcdef] [span: 1234567890abcdef] : [name: provider query] [parent: fedcba0987654321] [duration_ms: 812.4] [status: ERROR] [source: data_gov_ie] [outcome: failed] [error.type: RateLimitError] [http.response.status_code: 429] Span ended",
    );
    expect(lines[0]?.line).not.toContain("secret");
    expect(lines[0]?.line).not.toMatch(/[\r\n]/u);
  });

  it("uses DEBUG for library spans and INFO for app spans", () => {
    const levels: string[] = [];
    const processor = new FlatLogSpanProcessor((severity) => {
      levels.push(severity);
    });

    processor.onEnd(readableSpan());
    processor.onEnd(
      readableSpan({
        kind: SpanKind.CLIENT,
        instrumentationScope: {
          name: "ireland-open-data-mcp.library.http",
        },
      }),
    );

    expect(levels).toEqual(["info", "debug"]);
  });

  it("includes active IDs and defaults to INFO logging", () => {
    configureTracing();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const activeSpan = trace.wrapSpanContext({
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
    });

    context.with(trace.setSpan(context.active(), activeSpan), () => {
      logger.info("hello\nworld");
      logger.debug("hidden");
    });

    expect(info).toHaveBeenCalledWith(
      "[INFO] [trace: 1234567890abcdef1234567890abcdef] [span: 1234567890abcdef] : hello world",
    );
    expect(debug).not.toHaveBeenCalled();

    withLogLevel("debug", () => logger.debug("visible"));
    expect(debug).toHaveBeenCalledWith(
      "[DEBUG] [trace: -] [span: -] : visible",
    );
  });

  it("redacts and trims dynamic error text", () => {
    const sanitized = sanitizeErrorMessage(
      new Error(
        `failed\nBearer abc https://example.test/path?token=secret ${"x".repeat(300)}`,
      ),
    );

    expect(sanitized).not.toContain("abc");
    expect(sanitized).not.toContain("secret");
    expect(sanitized).not.toContain("\n");
    expect(sanitized.length).toBeLessThanOrEqual(160);
  });

  it("never forwards trace propagation headers in traced fetch", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.has("traceparent")).toBe(false);
      expect(headers.has("tracestate")).toBe(false);
      expect(headers.has("baggage")).toBe(false);
      expect(headers.get("accept")).toBe("application/json");
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const response = await createTracedFetch(fetcher)(
      "https://example.test/data?token=not-logged",
      {
        headers: {
          accept: "application/json",
          traceparent: `00-${traceId}-${spanId}-01`,
          tracestate: "vendor=value",
          baggage: "key=value",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("formats the trace ID as the request UUID", () => {
    expect(traceIdAsUuid(traceId)).toBe(
      "12345678-90ab-cdef-1234-567890abcdef",
    );
  });
});
