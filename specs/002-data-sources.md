# Data Sources

## Overview

Ireland Open Data MCP supports thirteen sources:

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

Each source has independent configuration. Sources may share an adapter when
their upstream protocol is the same.

The optional top-level `enabled` setting defaults to `true`. Setting it to
`false` prevents that adapter from being initialized and removes the source
from `list_sources` without deleting its configuration.

## Provider Configuration

Each provider has an independent YAML configuration file:

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
- source-specific endpoint allowlists, field or dimension allowlists, units,
  time windows, attribution, and spatial bounds where applicable

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

Provider adapters include:

- `DataGovAdapter`
- `SmartDublinAdapter`
- `MetEireannAdapter`
- `OpenMeteoAdapter`
- `CsoPxStatAdapter`
- `MarineErddapAdapter`
- `GeoHiveAdapter`
- `OpwAdapter`
- `EpaAdapter`
- `TfiNtaAdapter`
- `EirGridAdapter`
- the scoped CKAN adapter used by `seai` and `open_data_ni`

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
It must remain visibly distinct from Met Éireann. The source is configured with
`enabled: false` until shared rate limiting is available.

## CSO PxStat

Source identifier: `cso_pxstat`

This source exposes CSO statistical matrices. `data_id` is the matrix code.
Search and metadata use the PxStat public APIs. The queryable JSON-stat access
point accepts exact dimension filters and returns at most 100 selected Cartesian
cells per request. CSV, JSON-stat, PC-Axis, and XLSX representations remain
available as links where published.

PxStat does not provide general row-offset pagination. Large dimension value
vocabularies may be truncated in the described query schema, and clients must
make explicit bounded selections.

## Marine Institute

Source identifier: `marine_institute`

This source exposes Marine Institute ERDDAP datasets through `tabledap`,
`griddap`, and file access points when advertised upstream. Field, typed filter,
spatial, and time selectors are translated only where the described dataset
supports them. Per-dataset licence metadata must be preserved.

General `tabledap` offset paging is not assumed. Responses are bounded and must
state when further data may exist. `griddap` cursor paging is exposed only when
exact constraints leave one dimension unbounded; range selections that could
skip Cartesian rows are rejected. Marine requests use a 20-second timeout and
one retry for a timeout or HTTP 502, 503, or 504 response. Live connectivity to
the upstream ERDDAP service must still be verified from the deployment
environment.

## GeoHive

Source identifier: `geohive`

This source uses the GeoHive OGC catalogue for discovery. Supported ArcGIS
feature layers may be queried with fields, point or bounding-box selection, and
time ranges. WMS and other non-queryable services remain link-only.

Only catalogued and allowlisted service URLs may be called. Licence and
attribution are preserved per catalogue record or layer.

## OPW

Source identifier: `opw`

This source exposes waterlevel.ie stations and configured sensor time series.
`data_id` identifies a station and `access_id` identifies a supported sensor.
Queries require a bounded time range inside the rolling 35-day window.

Only station references permitted for republication are exposed. Provisional
data notices, attribution, and station restrictions must be retained. Public
deployment requires a shared 15-minute cache. Hydro-Data is outside this phase.

## EPA

Source identifier: `epa`

The initial EPA scope is the Bathing Water API: locations, measurements, and
alerts. It uses a small configured catalogue rather than representing every EPA
API family as one uniform service. Measurement queries support only the
described `in_season` filter. EPA attribution and licence metadata are retained.
No numeric upstream rate limit is documented for this API scope, so requests
remain bounded and upstream rate responses must be monitored.

## TFI/NTA

Source identifier: `tfi_nta`

The initial safe scope exposes TFI/NTA feed metadata. The static GTFS schedule
archive is link-only and is never downloaded or parsed by the Worker. Realtime
feeds are described but remain non-queryable and non-linkable until API-key,
payload, shared-cache, and one-call-per-minute coordination requirements are
implemented.

## SEAI

Source identifier: `seai`

This source is a scoped view of the Sustainable Energy Authority of Ireland
publisher on data.gov.ie. It reuses the CKAN adapter while keeping a distinct
source identity, scope, provenance, and licence metadata.

## EirGrid

Source identifier: `eirgrid`

The configured catalogue contains wind generation, solar generation, and
interconnector-flow time series. Queries require a time range no longer than 24
hours. Wind and solar use an explicit region filter; interconnector queries use
the described field-name filter. Dynamic access points have no stable raw-data
link.

The adapter converts RFC3339 instants to the Europe/Dublin wall-clock format
required upstream without reinterpreting returned values. Endpoint stability
and upstream rate behaviour must be verified before deployment.

## OpenDataNI

Source identifier: `open_data_ni`

This source reuses the CKAN adapter against the OpenDataNI catalogue. Its
coverage is explicitly Northern Ireland, United Kingdom. It is relevant to
all-island use cases but must not be labelled Republic of Ireland government
data. Licences are preserved per dataset rather than assumed globally.

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

## Official Upstream References

- [data.gov.ie](https://data.gov.ie/) and [Smart Dublin](https://data.smartdublin.ie/)
- [Met Éireann forecast API](https://data.gov.ie/dataset/met-eireann-forecast-api)
  and [Open-Meteo forecast API](https://open-meteo.com/en/docs)
- [CSO PxStat](https://www.cso.ie/en/databases/userguides/pxstatuserguide/)
- [Marine Institute ERDDAP](https://erddap.marine.ie/erddap/index.html)
- [GeoHive search API](https://ga.geohive.ie/api/search/definition/)
- [OPW water-level API](https://waterlevel.ie/page/api/)
- [EPA open-data APIs](https://data.epa.ie/)
- [NTA developer portal](https://developer.nationaltransport.ie/)
- [SEAI data](https://www.seai.ie/energy-data-and-insights) and
  [EirGrid data](https://www.eirgrid.ie/grid/system-and-renewable-data-reports)
- [OpenDataNI API](https://admin.opendatani.gov.uk/en_GB/api/1/util/snippet/api_info.html?resource_id=4436c31a-12c9-4ed9-9f2f-136925ec8faa)
