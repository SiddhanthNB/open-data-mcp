# Ireland Open Data MCP

Read-only Irish public data through one remote MCP endpoint.

## Providers

- `data_gov_ie`
- `smart_dublin`
- `met_eireann`
- `open_meteo_ie` — non-authoritative ECMWF IFS model forecast, Ireland-only

## Tools

- `list_sources`
- `search_data_by_source`
- `describe_data_by_id`
- `query_data_by_id`
- `get_data_link_by_id`

No joins, analytics, recommendations, or derived insights.

`source` selects one upstream catalogue. Harvested datasets can appear in more
than one catalogue and may have different metadata there.

Use `source + data_id` for a logical data object and `access_id` for one of its
access points. Search and structured queries use opaque continuation cursors.

Current provider configs allow `limit` values from 1 to 100. Structured queries
support CSV, JSON, XML, and CKAN DataStore-backed access points. Other formats
remain discoverable through browser-openable links.

Forecast queries use the same tools. Met Éireann exposes an authoritative point
forecast. Open-Meteo exposes non-authoritative ECMWF IFS model output for points
inside the Republic of Ireland.

Do not deploy the forecast expansion yet: Met Éireann warning-display licence
compliance and source-wide Open-Meteo rate limiting remain deployment gates.

## Local development

Requires Node.js 22+.

```bash
npm install
cp .env.example .env
npm run dev
```

MCP endpoint: `https://ireland-open-data-mcp.ireland-open-data-mcp.workers.dev/mcp`

The checked-in configuration uses GitHub OAuth. Add the GitHub client values to
`.env` before starting locally. Authentication modes are documented in
[`docs/authentication.md`](docs/authentication.md).

## Checks

```bash
npm run typecheck
npm test
```

## Deploy

```bash
npm run deploy
```

Authentication modes are configured in `config/server.yml`.

## Runtime

- Cloudflare Workers
- TypeScript
- Stateless Streamable HTTP MCP at `/mcp`
- YAML-configured provider adapters
