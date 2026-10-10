# Data Sources

## Overview

Ireland Open Data MCP supports four providers:

- `data_gov_ie`
- `smart_dublin`
- `met_eireann`
- `open_meteo_ie`

Each provider is implemented through its own adapter and configuration file.

## Provider Configuration

Each provider has an independent YAML configuration file:

- `config/data_gov_ie.yml`
- `config/smart_dublin.yml`
- `config/met_eireann.yml`
- `config/open_meteo_ie.yml`

Provider URLs and operational settings must not be hardcoded in application code.

The YAML files are bundled with the TypeScript Worker as read-only text modules through Wrangler. A shared configuration module under `src/` parses and validates them.

The Worker must not depend on runtime filesystem access for provider configuration.

## Configuration Responsibilities

Provider configuration may define:

- provider name
- base URL
- API endpoint paths
- HTTP timeout
- pagination defaults
- maximum result limits
- supported resource formats
- other connection-level settings
- authority status and geographic coverage
- provider-specific forecast endpoint, model, field allowlist, units, horizon,
  attribution, and spatial bounds where applicable

Response parsing and provider-specific transformation logic must remain in adapter code.

## Capabilities

Each provider configuration must contain a dedicated `capabilities` section.

Example structure:

    provider: data_gov_ie

    type: catalogue

    capabilities:
      search_data_by_source: true
      describe_data_by_id: true
      query_data_by_id: true
      get_data_link_by_id: true

    formats:
      - csv
      - json
      - xml

Capabilities determine which generic MCP operations can be executed against the provider.

Unsupported operations must fail with a standardized error.

## Supported Formats

Each provider explicitly declares the resource formats its shared direct
resource handlers support.

Examples:

- CSV
- JSON
- XML

Catalogue discovery must preserve every resource and its reported format, even
when the server cannot retrieve that format directly. This keeps unsupported
files discoverable instead of making them appear absent.

The initial shared direct handlers support CSV, JSON, and XML. A resource backed
by CKAN DataStore may instead be returned through DataStore as typed JSON.
Attempting to query any other direct format must return the standardized
`UNSUPPORTED_FORMAT` error. Unsupported formats remain available through
`get_data_link_by_id` when the catalogue provides a browser-openable URL.

## Provider Adapters

Each provider has its own adapter:

- `DataGovAdapter`
- `SmartDublinAdapter`
- `MetEireannAdapter`
- `OpenMeteoAdapter`

Adapters are responsible for:

- reading provider configuration
- communicating with the upstream service
- mapping generic operations to provider APIs
- parsing provider-specific responses
- discovering available resources
- returning data through the common internal model
- translating upstream errors into standard errors

## DataGov.ie

Source identifier:

`data_gov_ie`

The adapter provides access to datasets exposed by Ireland's national open-data portal.

It should support the generic MCP operations enabled by its configuration.

Provider-specific catalogue behaviour must remain inside `DataGovAdapter`.

Data.gov.ie may contain records harvested from another supported catalogue.
Those records belong to the data.gov.ie view when `source` is `data_gov_ie`.

## Smart Dublin

Source identifier:

`smart_dublin`

The adapter provides access to public datasets exposed through Smart Dublin.

Provider-specific catalogue behaviour must remain inside `SmartDublinAdapter`.

A harvested Smart Dublin record may also be visible through `data_gov_ie`.
Metadata such as the licence may differ because `source` selects the upstream
catalogue and representation; it does not identify one globally canonical
record.

## Met Éireann

Source identifier:

`met_eireann`

The adapter provides access to publicly available Met Éireann data.

It exposes the Met Éireann publisher subset of data.gov.ie and the official
point forecast for dataset `fa9574c1-48f4-4a98-a22b-d1c23c433821` through the
synthetic `point_forecast` access point. Point forecasts require a configured
Ireland-bounded WGS84 point. The adapter converts the forecast XML into bounded
structured data without changing its weather semantics.

Met Éireann is authoritative. Public displays of its forecast data must follow
the upstream licence notice, including attribution and weather-warning display
requirements.

These differences must remain hidden inside `MetEireannAdapter`.

The MCP layer must continue exposing the same generic interface.

## Open-Meteo Ireland

Source identifier:

`open_meteo_ie`

This source exposes a small configured catalogue containing the
`weather_forecast` data object and its `hourly_forecast` access point. It
returns forecast data only for WGS84 points inside the Republic of Ireland.
Place-name geocoding is not supported.

The source forces the configured `ecmwf_ifs` model and accepts at most ten
unique fields from its configured hourly field allowlist. It requires a bounded
forecast time range and returns JSON rows with the upstream units and model
provenance.

Open-Meteo is operated by Open-Meteo GmbH, not an Irish public body. Its data is
non-authoritative model output, not observations or an official Irish forecast.
It must remain visibly distinct from Met Éireann.

## Resource Retrieval

When a provider returns a resource:

1. The provider adapter resolves the resource.
2. The resource format is identified.
3. The corresponding shared resource handler is selected.
4. The resource is fetched.
5. Minimal format conversion is performed when required.
6. The result is returned with provenance metadata.

CSV handlers preserve source values as strings. DataStore retrieval preserves
the value types returned by CKAN. The server must not infer types or reinterpret
provider-specific sentinel values.

For OpenAPI or similar description documents, `query_data_by_id` returns the
catalogued document itself. It does not execute the API described by that
document or accept arbitrary provider-specific request parameters. The two
explicit forecast adapters are allowlisted implementations, not general API
execution.

## Configuration-Driven Behaviour

Configuration should control behaviour that can reasonably change without modifying code.

Examples:

- API locations
- enabled capabilities
- supported formats
- limits
- timeout values
- pagination defaults

Complex parsing logic must not be implemented in YAML.

## Adding Providers

Adding another Irish public-data provider should require:

1. creating a provider configuration file
2. implementing the common provider interface
3. registering the adapter

Existing MCP tools must not require modification.

## Design Constraint

Providers may expose completely different upstream APIs.

The adapter layer exists specifically to absorb these differences.

Neither MCP clients nor MCP tools should need to understand how an individual upstream provider works.
