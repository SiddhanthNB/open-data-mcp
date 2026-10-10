# MCP Tools

## Overview

Ireland Open Data MCP exposes exactly five provider-independent tools:

1. `list_sources`
2. `search_data_by_source`
3. `describe_data_by_id`
4. `query_data_by_id`
5. `get_data_link_by_id`

Supported sources:

- `data_gov_ie`
- `smart_dublin`
- `met_eireann`
- `open_meteo_ie`
- `cso_pxstat`
- `marine_institute`
- `geohive`
- `opw`
- `epa`
- `tfi_nta`
- `seai`
- `eirgrid`
- `open_data_ni`

The public transport is stateless Streamable HTTP at `/mcp`. Each request
receives a fresh server instance and must not depend on in-memory session state.

## Identifiers

The public contract uses two source-neutral identifiers:

- `data_id` identifies a logical dataset, cube, feed, station collection, or
  equivalent provider object.
- `access_id` identifies one table, file, feed, API representation, or other
  access point belonging to that data object.

An identifier is interpreted only together with `source`. The source must not
be encoded into either identifier. Clients obtain `data_id` from search and
`access_id` from describe.

## 1. list_sources

Lists configured sources and their source type, authority status, geographic
coverage, description, enabled capabilities, queryable formats, default limit,
and maximum limit.

This tool takes no inputs. Its response is derived from provider configuration.

## 2. search_data_by_source

Searches within exactly one source.

### Inputs

- `source` — required
- `query` — optional keyword search
- `limit` — optional configured bounded integer
- `cursor` — optional opaque continuation cursor returned by this tool

### Response

Includes:

- results containing `data_id`, title, optional description and publisher,
  available formats, and provenance
- returned result count
- total when known
- `truncated`
- `next_cursor` when more results may be available

The server must not expose provider-specific offset or query syntax as part of
the public contract. A search cursor is bound to its source and query.

## 3. describe_data_by_id

Describes one logical data object.

### Inputs

- `source` — required
- `data_id` — required; obtain it from `search_data_by_source`

### Response

Includes normalized metadata and the complete list of access points. Each
access point includes:

- `access_id`
- reported format
- catalogued upstream URL
- explicit `query` and `link` capabilities
- optional query schema describing fields, types, allowed operators and spatial
  selector types, plus supported and required selectors
- optional title, description, size, and last-modified metadata

The access-point list is metadata and is intentionally not paginated.
Unsupported query formats remain discoverable and linkable when the catalogue
provides a valid public HTTP or HTTPS URL.

## 4. query_data_by_id

Returns bounded structured data from one access point.

### Inputs

- `source` — required
- `data_id` — required
- `access_id` — required; obtain it from `describe_data_by_id`
- `fields` — optional list of up to ten unique field names
- `filters` — optional list of up to twenty typed field filters; operators are
  `eq`, `in`, `lt`, `lte`, `gt`, and `gte`, and `in` accepts at most 100 values
- `spatial` — optional WGS84 point or bounding box
- `time_range` — optional bounded RFC3339 start and end timestamps
- `limit` — optional configured bounded integer
- `cursor` — optional opaque continuation cursor returned by this tool

### Response

Includes:

- source-neutral identifiers
- returned data
- provenance
- returned item count where pagination applies
- total when known
- `truncated`
- `next_cursor` when more data may be available

Cursor tokens are stateless, validated, and bound to the source, data ID,
access ID, and selectors. Provider adapters may translate a valid cursor into
an internal offset or another provider-specific pagination mechanism.

Pagination applies to CKAN DataStore rows, tabular resources, and top-level
JSON arrays. Whole JSON and XML documents are returned as documents and are
not paginated. `total` remains optional because a bounded streaming resource
may not know it without reading the complete upstream body.

Direct structured query initially supports CSV, JSON, and XML. CKAN
DataStore-backed access points can be queried regardless of the original file
format. Unsupported direct formats return `UNSUPPORTED_FORMAT`.

The tool retrieves only the described access point. It does not execute an API
described by an OpenAPI document and does not accept arbitrary provider
parameters, sorting, grouping, or aggregation. Fields, filters, spatial
selectors, and time ranges are translated only by adapters that explicitly
advertise and implement them. Unsupported selectors fail explicitly.

Every tool response is subject to the shared configured output-size limit.

The Met Éireann `point_forecast` access point requires `spatial`. Open-Meteo's
`hourly_forecast` requires `spatial`, `fields`, and `time_range`; it accepts
only Republic of Ireland points and its configured ECMWF IFS hourly fields.

Other source-specific constraints are advertised through access-point metadata:

- CSO PxStat queries require exact dimension selections and are capped at 100
  selected Cartesian cells.
- Marine ERDDAP selectors depend on each dataset's dimensions and variables.
- GeoHive feature layers may accept fields, point or bounding-box selection,
  and time ranges; WMS remains link-only.
- OPW sensor queries require a time range inside the rolling 35-day window.
- EPA initially supports only the described Bathing Water measurement filter.
- TFI/NTA realtime access is disabled until its operational gates are met.
- EirGrid queries require a time range of at most 24 hours and the filter shown
  by the selected data object.

## 5. get_data_link_by_id

Returns metadata and a clickable MCP `resource_link` for one catalogued access
point.

### Inputs

- `source` — required
- `data_id` — required
- `access_id` — required; obtain it from `describe_data_by_id`

The tool never downloads, streams, parses, or previews the linked bytes. It
accepts no arbitrary URL. It returns only a catalogued HTTP or HTTPS URL and
must never add or expose provider credentials. Links containing URL user-info,
credential query parameters, or credential fragments are rejected.

Dynamic forecast access points have `link: false`; calling this tool for them
returns `UNSUPPORTED_OPERATION` because no stable browser-openable data URL
exists without query parameters.

## Source Parameter

`source` is a fixed enum:

- `data_gov_ie`
- `smart_dublin`
- `met_eireann`
- `open_meteo_ie`
- `cso_pxstat`
- `marine_institute`
- `geohive`
- `opw`
- `epa`
- `tfi_nta`
- `seai`
- `eirgrid`
- `open_data_ni`

Unknown sources return `INVALID_SOURCE`; configured but disabled sources return
`SOURCE_DISABLED`. A harvested record can appear through
more than one source, and its metadata may differ between catalogues.

`met_eireann` is authoritative. `open_meteo_ie` is a non-authoritative model
forecast source restricted to Republic of Ireland point queries.
`open_data_ni` covers Northern Ireland, United Kingdom. EirGrid records may
cover the Republic of Ireland, Northern Ireland, or the all-island system and
must retain their upstream region label.

## Limits

Default and maximum limits come from provider configuration. Requests above
the common advertised maximum are rejected during tool validation. Provider
adapters also enforce their own configured maximum.

The current provider configurations use a maximum limit of 100.

## Standard Response Metadata

Responses include provenance where available:

- `source`
- `upstream_url`
- `retrieved_at`
- `original_format` where applicable

## Standard Errors

The MCP server uses consistent error codes:

- `INVALID_SOURCE`
- `INVALID_REQUEST`
- `DATASET_NOT_FOUND`
- `RESOURCE_NOT_FOUND`
- `UNSUPPORTED_OPERATION`
- `UNSUPPORTED_FORMAT`
- `RESOURCE_TOO_LARGE`
- `UPSTREAM_ERROR`
- `UPSTREAM_TIMEOUT`
- `RATE_LIMITED`

The existing dataset/resource error code names are retained internally for
compatibility, while public tool fields use `data_id` and `access_id`.

## Design Rules

- Tools remain generic.
- One tool call targets one provider.
- No cross-source search.
- No joins, analytics, aggregation, derived insights, or recommendations.
- No write operations.
- No provider-specific MCP tools.
- No arbitrary API execution.
- Format conversion is allowed; semantic transformation is not.
