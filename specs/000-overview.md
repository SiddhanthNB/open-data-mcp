# Ireland Open Data MCP — Overview

## Project

**Name:** Ireland Open Data MCP
**Repository:** `ireland-open-data-mcp`

Ireland Open Data MCP is a remote Model Context Protocol (MCP) server that provides a consistent interface for accessing publicly available Irish datasets.

It acts strictly as a **data transport and access layer** between MCP-compatible clients and Irish open-data providers.

The server does not analyse, interpret, rank, recommend, or derive insights from the data it exposes.

## Goal

Provide MCP-compatible applications with a simple way to:

- discover Irish public data
- inspect data metadata and access points
- query supported access points
- obtain browser-openable links to catalogued data
- access multiple Irish open-data providers through one MCP interface

The project is Ireland-specific.

## Primary Users

The project serves:

- developers building AI agents and MCP applications
- analysts and researchers using MCP-compatible AI clients

Any MCP-compatible client should be able to connect.

## Initial Data Sources

The supported providers are:

- `data_gov_ie`
- `smart_dublin`
- `met_eireann`
- `open_meteo_ie`

Additional Irish public-data providers may be added later.

`met_eireann` is the authoritative Irish weather source. `open_meteo_ie` is a
non-authoritative ECMWF IFS model-forecast source restricted to point queries
inside the Republic of Ireland. The two sources remain separate and their data
must not be silently merged.

## Core Principles

### Data layer only

The MCP server transports public data.

It must not:

- generate insights
- rank results
- calculate trends
- create recommendations
- perform analytical aggregation
- interpret datasets
- combine datasets into derived results

Each request operates against a single upstream source.

### Generic MCP interface

MCP tools must remain provider-independent.

Provider selection and querying are controlled through parameters such as:

- `source`
- query keywords
- data identifiers
- access identifiers
- limits
- opaque cursors
- optional field, point, and time-range selectors where a source supports them

Provider-specific MCP tools must not be exposed.

### Minimal transformation

Format conversion is allowed when required for interoperability.

Examples:

- CSV to structured JSON
- XML to structured JSON
- transport-level response normalization

The server should preserve upstream field names and semantics wherever practical.

Format conversion must not become semantic data processing.

### Read only

The system is strictly read-only.

It must never modify, upload, delete, or write data to upstream providers.

## Provenance

Responses should include provenance information where available:

- source provider
- upstream resource URL
- dataset or resource identifier
- original format
- retrieval timestamp

## Error Handling

All providers should expose failures through a consistent error model.

Example error shape:

`{"error":"RESOURCE_NOT_FOUND","message":"The requested resource could not be found."}`

Provider-specific failures should be translated into consistent server-level errors where practical.

## Runtime

Primary deployment target:

**Cloudflare Workers using TypeScript**

The service is exposed as a **stateless remote MCP server over Streamable HTTP** at `/mcp`.

The Worker uses the official Cloudflare Agents SDK stateless MCP handler with the official MCP TypeScript server package.

Each MCP request is handled without application session state. Durable Objects are not required for the core service.

Local `stdio` transport is not part of the core server.

A local proxy may be added later if required.

## Authentication

Authentication is not required for core data access because the upstream datasets are public.

GitHub OAuth through Cloudflare may be introduced after the core MCP functionality is complete.

Authentication remains separate from upstream provider access.

## Caching

Metadata caching is planned for a later phase.

Likely cache candidates include:

- dataset metadata
- catalogue metadata
- resource descriptions

Live or frequently changing data should only be cached when an explicit freshness policy exists.

## Non-Goals

Ireland Open Data MCP is not:

- an AI assistant
- a chatbot
- an analytics engine
- a recommendation system
- a data warehouse
- an ETL platform
- a cross-dataset join engine
- a replacement for upstream open-data portals

Its responsibility ends at providing reliable, standardized access to Irish public data through MCP.
