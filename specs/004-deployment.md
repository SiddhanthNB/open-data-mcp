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

## Deployment Flow

Expected flow:

1. Install locked npm dependencies.
2. Develop locally with Wrangler.
3. Run the local Worker environment with `wrangler dev`.
4. Run type checks and automated tests.
5. Validate the MCP tools at `/mcp`.
6. Deploy with `wrangler deploy`.
7. Test the deployed remote MCP endpoint.

## Configuration

Provider configuration files are stored under:

- `config/data_gov_ie.yml`
- `config/smart_dublin.yml`
- `config/met_eireann.yml`
- `config/open_meteo_ie.yml`

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

Authentication is not required for the initial core service.

GitHub OAuth may be added later through Cloudflare as an access-control layer.

OAuth protects access to the MCP server itself.

It does not authenticate against the public-data providers.

## GitHub OAuth

When enabled, the flow should be:

MCP Client  
→ OAuth authorization  
→ GitHub identity  
→ Cloudflare MCP server  
→ Public data provider

OAuth must remain optional and separate from core provider functionality.

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

The application should log operational information needed for debugging.

Logs should include:

- provider
- operation
- success or failure
- upstream status where relevant
- execution duration where practical

Logs must not expose secrets or authentication tokens.

Logging should use Worker-compatible console output and structured fields where practical.

## Caching

Caching is not required for the initial deployment.

A later phase may introduce Cloudflare caching for stable metadata.

Potential cache targets include:

- dataset metadata
- catalogue responses
- resource descriptions

Live data should not be cached without an explicit freshness policy.

## Forecast Deployment Gates

The new forecast capabilities must not be deployed until both gates are met:

1. Met Éireann weather-warning display and attribution requirements are
   implemented for the intended public client experience.
2. Source-wide Open-Meteo rate limiting is implemented so limits apply across
   Worker instances rather than only inside one stateless request.

These gates do not block local tests. OAuth does not replace either gate.

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
- no database dependency required for core functionality
- authentication remains optional
