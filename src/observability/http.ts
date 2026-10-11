import { SpanStatusCode } from "@opentelemetry/api";

import { withHttpSpan } from "./tracing";

const propagationHeaders = ["traceparent", "tracestate", "baggage"];

function withoutTraceHeaders(
  input: RequestInfo | URL,
  init?: RequestInit,
): [RequestInfo | URL, RequestInit | undefined] {
  const inputHeaders = input instanceof Request ? input.headers : undefined;
  const headers = new Headers(init?.headers ?? inputHeaders);
  for (const header of propagationHeaders) {
    headers.delete(header);
  }

  if (input instanceof Request) {
    const request = new Request(input, { ...init, headers });
    return [request, undefined];
  }
  return [input, { ...init, headers }];
}

export function createTracedFetch(fetcher: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    withHttpSpan(async (span) => {
      const [safeInput, safeInit] = withoutTraceHeaders(input, init);
      const response = await fetcher(safeInput, safeInit);
      span.setAttribute("http.response.status_code", response.status);
      if (response.status >= 400) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute("outcome", "failed");
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
        span.setAttribute("outcome", "success");
      }
      return response;
    })) as typeof fetch;
}
