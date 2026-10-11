# Deployment

## Overview

Ireland Open Data MCP is deployed as a remote MCP server on:

**Cloudflare Workers using TypeScript**

The service is accessed over Streamable HTTP at `/mcp`.

Local `stdio` transport is not part of the core deployment.

## Runtime

Primary runtime:

- Cloudflare Workers
- TypeScript
- Cloudflare Agents SDK stateless MCP handler
- official MCP TypeScript server package

The implementation should remain compatible with Cloudflare Worker runtime constraints.

Application source code is stored under `src/`.

`src/index.ts` is the Worker entry point. It exposes `/mcp` through `createMcpHandler` from `agents/mcp/server`.

`src/server.ts` creates a fresh `McpServer` from `@modelcontextprotocol/server`
for each request and registers the five generic MCP tools.

The core service is stateless. It must not use `McpAgent`, legacy stateful transports, or Durable Objects.

Dependencies should be kept minimal and locked to compatible versions.

Packages must be compatible with the Cloudflare Workers runtime. Node.js-only APIs, native add-ons, and dependencies that require a traditional server process should be avoided.

Shared sliding-window rate limiting uses the Worker-compatible Upstash REST
clients. It does not require a TCP Redis connection.

## Deployment Flow

Expected flow:

1. Install locked npm dependencies.
2. Develop locally with Wrangler.
3. Run the local Worker environment with `wrangler dev`.
4. Run type checks and automated tests.
5. Validate the MCP tools at `/mcp`.
6. Deploy with `wrangler deploy`.
7. Test the deployed remote MCP endpoint.

Production releases use `.github/workflows/ci-cd.yml`. Pushing a `v*` tag runs
the locked install, typecheck, tests, and Wrangler dry-run against that tagged
commit. Deployment runs only after those checks pass, using the GitHub Actions
repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Configuration

Provider configuration files are stored under:

- `config/data_gov_ie.yml`
- `config/smart_dublin.yml`
- `config/met_eireann.yml`
- `config/open_meteo_ie.yml`
- `config/cso_pxstat.yml`
- `config/marine_institute.yml`
- `config/geohive.yml`
- `config/opw.yml`
- `config/epa.yml`
- `config/tfi_nta.yml`
- `config/seai.yml`
- `config/eirgrid.yml`
- `config/open_data_ni.yml`

Configuration should contain provider-specific operational settings and capabilities.

Wrangler must bundle the YAML files as read-only text modules. The TypeScript configuration loader parses and validates them when the application starts.

The Worker must not rely on runtime filesystem access.

Sensitive values must not be committed to the repository.

The Met Éireann forecast endpoint is currently the only explicit provider URL
allowed to use HTTP because that is the published upstream endpoint. Catalogue
base URLs and all other configured upstream URLs must use HTTPS.

## Secrets

Secrets must be stored using Cloudflare-supported secret management.

Examples include:

- OAuth client secrets
- future upstream API keys
- other credentials
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Secrets must never be stored in YAML configuration files or source code.

## Public MCP Endpoint

The deployed service exposes a stateless remote MCP endpoint at `/mcp` over HTTPS.

The MCP client communicates directly with this endpoint.

Example conceptual flow:

MCP Client  
→ HTTPS  
→ Cloudflare Worker  
→ Ireland Open Data MCP  
→ Public Data Provider

## Authentication

`auth.mode` in `config/server.yml` selects `none`, `bearer`, or `oauth`.

- `none` leaves `/mcp` anonymous.
- `bearer` checks one secret-backed bearer token.
- `oauth` makes the Worker the MCP authorization server and uses GitHub as the
  identity provider.

OAuth protects access to the MCP server itself. It does not authenticate
against public-data providers and does not satisfy their rate or caching rules.

## GitHub OAuth

When enabled, the flow is:

MCP Client  
→ OAuth authorization  
→ GitHub identity  
→ Cloudflare MCP server  
→ Public data provider

The Worker exposes OAuth discovery, authorization, dynamic registration, token,
and revocation endpoints. OAuth state and grants use the `OAUTH_KV` binding.
GitHub client credentials are Worker secrets. Detailed setup is documented in
`docs/authentication.md`.

OAuth remains optional and separate from core provider functionality.

## Rate Limiting

Valid MCP tool executions are checked against Cloudflare Workers Rate Limiting
bindings and Upstash Redis. Cloudflare bindings provide fast per-location
minute limits. Redis provides shared rolling minute and 24-hour user and global
limits across Worker locations.

The native bindings are:

- `MCP_USER_RATE_LIMITER` — 60 requests per minute per user
- `MCP_GLOBAL_RATE_LIMITER` — 300 requests per minute for the service
- `OAUTH_RATE_LIMITER` — 20 requests per minute per client IP

If Redis is unavailable, general tool and OAuth traffic may continue only when
the corresponding Cloudflare check succeeds. If both mechanisms are
unavailable, the request fails closed. `open_meteo_ie` always fails closed when
Redis is unavailable because its upstream quota must be coordinated globally.

## Availability

The service should fail gracefully when an upstream provider is unavailable.

Upstream failures must not crash the Worker.

Failures should return standardized MCP errors such as:

- `UPSTREAM_ERROR`
- `UPSTREAM_TIMEOUT`
- `RATE_LIMITED`

## Timeouts

Outbound requests must use the Cloudflare Workers Fetch API with explicit timeout and abort handling.

Timeout values may be configured per provider.

## Logging

Workers Logs persists the application's flat console output. Cloudflare trace
persistence is disabled. The service uses the OpenTelemetry JavaScript SDK with
a `service.name` resource, an AsyncLocalStorage context manager, a custom span
processor, and no exporter.

Every emitted application line is single-line text and carries a 32-hex trace
ID plus a 16-hex span ID, or `-` outside a span. The span processor emits one
end line containing name, parent span ID, duration, status, and only these
optional attributes:

- `mcp.tool.name`
- `source`
- `outcome`
- `error.type`
- `http.response.status_code`

Request, tool, and provider spans log at `INFO`. HTTP and Redis library spans
log at `DEBUG`. Production defaults to `INFO`; setting
`OPEN_DATA_MCP_LOG_LEVEL=debug` enables debug lines. Dynamic text is flattened,
bounded, and scrubbed before logging. Secrets and raw URLs must not be logged.

Every non-`/ping` request begins a new root trace without accepting an inbound
`traceparent`. Outbound fetches remove trace propagation headers. The trace ID
is formatted as a UUID in the `X-Request-ID` response header, which is exposed
through `Access-Control-Expose-Headers`. `/ping` is untraced and logs only at
`DEBUG`.

## Caching

The generic core does not require caching. Some expanded sources require shared
cache or rate coordination before they can be enabled in a public deployment.

Potential cache targets include:

- dataset metadata
- catalogue responses
- resource descriptions

Live data should not be cached without an explicit freshness or upstream-usage
policy. Per-instance memory is not sufficient for source-wide limits on a
stateless Worker.

## Deployment Gates

The expanded source set must not be deployed publicly until its applicable
gates are cleared:

1. Met Éireann weather-warning display and attribution requirements are
   implemented for the intended public client experience.
2. Source-wide Open-Meteo rate limiting is validated using the deployed Upstash
   credentials before `open_meteo_ie` is enabled.
3. Marine Institute ERDDAP live connectivity and response compatibility are
   verified from the deployment environment.
4. OPW uses the required shared 15-minute cache and continues filtering station
   references according to the upstream publishing conditions.
5. TFI/NTA realtime access remains disabled until an API key, shared cache,
   one-call-per-minute coordination, and live payload validation exist.
6. EirGrid endpoint stability and upstream rate behaviour are verified.
7. Per-record or per-dataset licences and attribution remain visible for
   GeoHive, Marine, OpenDataNI, and other mixed-licence catalogues.
8. Existing high-severity audit findings in the Cloudflare Agents/MCP dependency
   chain are reviewed without applying a breaking automatic downgrade.

These gates do not block local or mocked tests. OAuth does not replace them.

## Deployment Principles

- single remote HTTP service
- Cloudflare Workers as primary runtime
- TypeScript implementation
- stateless Streamable HTTP at `/mcp`
- official Cloudflare Agents SDK MCP handler
- configuration-driven providers
- secrets outside source control
- minimal dependencies
- no traditional server process
- no Durable Object dependency required for core functionality
- shared Redis rate limiting with Cloudflare-native fallback
- authentication mode remains independent of providers
