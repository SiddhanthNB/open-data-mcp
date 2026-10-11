# Architecture

## Overview

Open Data MCP uses a layered architecture so MCP clients remain independent from the implementation details of each public-data provider.

The main flow is:

MCP Client
→ MCP Server
→ Source Router
→ Provider Adapter
→ Resource Handler
→ Upstream Irish Open Data Source

## Layers

### 1. MCP Layer

Responsible for:

- exposing generic MCP tools
- validating tool inputs
- selecting the requested source
- calling the provider abstraction
- returning standardized responses
- returning standardized errors
- enforcing shared tool-execution limits after input validation

The MCP layer must not contain provider-specific logic.

The MCP layer is implemented as a TypeScript Cloudflare Worker:

- application code lives under `src/`
- `src/index.ts` is the Worker entry point
- `src/server.ts` creates and registers the MCP server and its generic tools
- `McpServer` comes from the official MCP TypeScript server package
- `createMcpHandler` comes from the Cloudflare Agents SDK stateless server path
- the handler serves Streamable HTTP at `/mcp`
- a fresh MCP server instance is created for each request

The core server is stateless and does not require Durable Objects.

Valid tool executions use configuration-driven sliding-window limits backed by
Upstash Redis. The authenticated GitHub user ID is the per-user key. Cloudflare
Workers Rate Limiting bindings run first and provide a per-location fallback
when Redis is unavailable. Initialization, tool discovery, and ping do not
consume tool limits.

Each valid tool call costs one quota unit. Independent calls may run in
parallel, with at most three recommended concurrently. Cursor pages belonging
to the same query must be requested sequentially. `RATE_LIMITED` tool results
include `retry_after_seconds`; no live remaining-quota counter is exposed.

The outer Worker handler starts one fresh OpenTelemetry server span for every
request except `/ping`. Incoming trace context is ignored and outbound trace
context is never propagated. App-owned tool and provider spans are children of
the request span. HTTP client and Redis rate-limit spans are library spans.
There is no exporter: a synchronous span processor writes one flat console line
per ended span, and `X-Request-ID` is the trace ID formatted as a UUID.

## 2. Source Router

The router maps a source identifier to its provider adapter.

Provider configuration may explicitly set `enabled: false`. Disabled adapters
are not initialized or returned by `list_sources`; direct calls return
`SOURCE_DISABLED`. A missing `enabled` field defaults to enabled.

Mappings:

- `data_gov_ie` → DataGovAdapter
- `smart_dublin` → SmartDublinAdapter
- `met_eireann` → MetEireannAdapter
- `open_meteo_ie` → OpenMeteoAdapter
- `cso_pxstat` → CsoPxStatAdapter
- `marine_institute` → MarineErddapAdapter
- `geohive` → GeoHiveAdapter
- `opw` → OpwAdapter
- `epa` → EpaAdapter
- `tfi_nta` → TfiNtaAdapter
- `seai` → scoped CKAN adapter
- `eirgrid` → EirGridAdapter
- `open_data_ni` → scoped CKAN adapter

Adding a new source should require:

1. implementing a provider adapter
2. registering the adapter

The MCP tool layer should not require changes.

## 3. Provider Interface

Every provider adapter implements the same internal contract.

Core operations:

- `search_data(...)`
- `describe_data(...)`
- `query_data(...)`
- `get_data_link(...)`

Each adapter is responsible for translating these generic operations into the upstream provider's API or catalogue structure.

## 4. Provider Adapters

Provider adapters contain source-specific behaviour.

Examples:

- DataGovAdapter
- SmartDublinAdapter
- MetEireannAdapter
- OpenMeteoAdapter
- CsoPxStatAdapter
- MarineErddapAdapter
- GeoHiveAdapter
- OpwAdapter
- EpaAdapter
- TfiNtaAdapter
- EirGridAdapter

Sources with the same upstream protocol may reuse an adapter with separate
validated configuration. `seai` and `open_data_ni` use the CKAN adapter with
different catalogue scopes and coverage metadata.

Responsibilities include:

- calling upstream APIs
- translating upstream identifiers
- extracting dataset metadata
- discovering resources
- mapping upstream failures into internal errors

Provider adapters must not perform analytics or semantic transformations.

## 5. Resource Handlers

Resource format handling is separated from provider handling.

Provider adapters locate resources.

Resource handlers retrieve and convert them into MCP-friendly representations.

Shared handler types include:

- CSV
- JSON
- XML

Example flow:

Provider Adapter
→ resource URL
→ Resource Handler
→ structured response

This prevents CSV, JSON, or XML parsing logic from being duplicated across providers.

Large or non-queryable files are not streamed through the Worker. Their access
points remain discoverable and `get_data_link_by_id` returns only the catalogued
browser-openable URL.

## Response Normalization

The architecture may normalize transport-level structure across providers.

Examples include:

- source metadata
- data identifiers
- access identifiers
- format
- upstream URL
- retrieval timestamp
- cursor pagination metadata

The underlying dataset fields and values should remain unchanged wherever practical.

## Request Flow

Example data search:

1. MCP client calls `search_data_by_source`.
2. MCP layer validates the request.
3. Source router selects the requested adapter.
4. Provider adapter queries the upstream source.
5. Adapter maps the upstream response into the common response structure.
6. MCP layer returns the response.

Example structured query:

1. MCP client calls `query_data_by_id` with a source, data ID, and access ID.
2. Source router selects the provider adapter.
3. Provider adapter resolves the provider-specific resource.
4. Appropriate resource handler is selected.
5. Resource handler fetches and converts the resource if necessary.
6. MCP layer returns bounded data with an opaque continuation cursor when more
   data may be available.

Adapters use the same public flow. They may validate source-neutral field,
typed filter, WGS84 point or bounding-box, and RFC3339 time-range selectors,
then translate only the subset advertised by that access point. Unsupported
selectors fail explicitly.

Example link lookup:

1. MCP client calls `get_data_link_by_id` with a source, data ID, and access ID.
2. Provider adapter resolves the catalogued upstream URL.
3. MCP layer returns link metadata and an MCP `resource_link` without fetching,
   streaming, or previewing the linked bytes.

## Design Rules

- MCP tools remain generic.
- MCP transport remains stateless.
- Provider-specific logic stays inside adapters.
- Format-specific logic stays inside resource handlers.
- Access-point descriptions advertise query and link capabilities plus the
  supported query schema.
- One request targets one provider.
- No cross-provider joins.
- No analytics.
- No derived insights.
- No write operations.
- No provider-specific MCP tools.
- Authoritative and non-authoritative sources remain explicitly labelled and
  are never silently merged.

## Extensibility

New Irish public-data sources should follow the same pattern:

New Source
→ New Provider Adapter
→ Register Adapter
→ Existing MCP Interface

New resource formats should follow:

New Format
→ New Resource Handler
→ Register Handler

The public MCP interface should remain stable as providers and formats are added.
