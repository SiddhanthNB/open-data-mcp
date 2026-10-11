import {
  context,
  createContextKey,
  trace,
  type Context,
  type SpanContext,
} from "@opentelemetry/api";

export type LogLevel = "debug" | "info";
export type LogSeverity = "debug" | "info" | "warn" | "error";

export interface LogIdentifiers {
  readonly traceId: string;
  readonly spanId: string;
}

const logLevelKey = createContextKey("open-data-mcp.log-level");
const severityOrder: Readonly<Record<LogSeverity, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function resolveLogLevel(value: unknown): LogLevel {
  return typeof value === "string" && value.trim().toLowerCase() === "debug"
    ? "debug"
    : "info";
}

export function contextWithLogLevel(
  parent: Context,
  level: LogLevel,
): Context {
  return parent.setValue(logLevelKey, level);
}

export function withLogLevel<T>(
  level: LogLevel,
  operation: () => T,
): T {
  return context.with(contextWithLogLevel(context.active(), level), operation);
}

function activeLogLevel(): LogLevel {
  return context.active().getValue(logLevelKey) === "debug" ? "debug" : "info";
}

function isEnabled(severity: LogSeverity): boolean {
  return severityOrder[severity] >= severityOrder[activeLogLevel()];
}

function validIdentifiers(spanContext?: SpanContext): LogIdentifiers {
  if (spanContext === undefined || !spanContext.traceId || !spanContext.spanId) {
    return { traceId: "-", spanId: "-" };
  }
  return {
    traceId: /^[0-9a-f]{32}$/u.test(spanContext.traceId)
      ? spanContext.traceId
      : "-",
    spanId: /^[0-9a-f]{16}$/u.test(spanContext.spanId)
      ? spanContext.spanId
      : "-",
  };
}

export function activeLogIdentifiers(): LogIdentifiers {
  return validIdentifiers(trace.getSpan(context.active())?.spanContext());
}

export function sanitizeLogText(value: unknown, maxLength = 500): string {
  const flattened = String(value)
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  if (flattened.length <= maxLength) {
    return flattened;
  }
  return `${flattened.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeLogText(
    message
      .replace(/https?:\/\/[^\s]+/giu, "[url]")
      .replace(/\bBearer\s+[^\s]+/giu, "Bearer [redacted]")
      .replace(
        /\b(token|secret|password|authorization)\s*[=:]\s*[^\s,;]+/giu,
        "$1=[redacted]",
      ),
    160,
  );
}

export function formatLogLine(
  severity: LogSeverity,
  message: unknown,
  identifiers: LogIdentifiers = activeLogIdentifiers(),
): string {
  return `[${severity.toUpperCase()}] [trace: ${identifiers.traceId}] [span: ${identifiers.spanId}] : ${sanitizeLogText(message)}`;
}

export function emitFlatLog(
  severity: LogSeverity,
  message: unknown,
  identifiers?: LogIdentifiers,
): void {
  if (!isEnabled(severity)) {
    return;
  }

  const line = formatLogLine(severity, message, identifiers);
  switch (severity) {
    case "debug":
      console.debug(line);
      break;
    case "info":
      console.info(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
  }
}

export const logger = {
  debug(message: unknown): void {
    emitFlatLog("debug", message);
  },
  info(message: unknown): void {
    emitFlatLog("info", message);
  },
  warn(message: unknown): void {
    emitFlatLog("warn", message);
  },
  error(message: unknown): void {
    emitFlatLog("error", message);
  },
};
