# Open Data MCP

Ireland has a wealth of useful public data, but most people never use it
because it lives across government portals, APIs, CSVs and other technical
formats. Open Data MCP is the bridge between that data and the AI assistants
people already use every day.

You don't need to be a developer or understand an API. Ask a normal question in
a conversation, even from your phone, and get an answer based on trusted Irish
sources like data.gov.ie, Smart Dublin, the CSO and Met Éireann.

It's one remote MCP endpoint, so it works with any MCP-compatible client
(Claude, ChatGPT and others), and any of them can use it.

```
https://open-data-mcp.siddhanthnb.workers.dev/mcp
```

## An AI-first data layer for developers

Open Data MCP is a **transport layer** for Irish public data. It doesn't
analyse or reshape anything. It gives AI agents one consistent, typed way to
discover datasets and pull rows from many publishers, so you skip the portal
hunting, the per-API client code and the CSV wrangling.

Point your coding assistant or agent at the endpoint and build against real
data in the same conversation.

**Searching for datasets**

- "Search data.gov.ie for datasets about air quality and list their formats."
- "Which CSO tables cover housing? Describe the dimensions of the first one."
- "Find Smart Dublin datasets on cycling and show which have a queryable CSV."

**Fetching data from a dataset**

- "Query the CSO population table for Dublin and Ireland, 2023 to 2025."
- "Pull the first 100 rows of that Smart Dublin CSV and write a typed loader."
- "Get Marine Institute buoy readings inside this bounding box for last week."
- "Give me the direct download link for that dataset's JSON."

## Why use it

- **Official sources.** Data comes straight from the CSO, Met Éireann, the
  Marine Institute, data.gov.ie, Smart Dublin and more. Authority is labelled,
  and sources are never silently merged.
- **Five simple tools.** The same tools work for every source, so your AI
  learns them once.
- **Built to be safe.** Read-only, OAuth sign-in, per-user and global rate
  limits, bounded responses, and cursor-based pagination.
- **Fast and stateless.** Runs on Cloudflare Workers, with sources
  defined in plain YAML.

## Connect

Add it as a remote (Streamable HTTP) MCP server. You sign in with GitHub the
first time.

**Claude Code**

```bash
claude mcp add --transport http open-data https://open-data-mcp.siddhanthnb.workers.dev/mcp
```

**Claude.ai / Claude Desktop:** Settings, Connectors, Add custom connector,
and paste the URL above.

**ChatGPT and other clients:** add the URL as a custom MCP connector or remote
server. Any MCP client that supports remote HTTP servers will work.

## Sources

| Source | What you get |
| --- | --- |
| `cso_pxstat` | Central Statistics Office tables (population, economy, housing) |
| `met_eireann` | Official Irish weather forecasts |
| `open_meteo_ie` | Model-based point forecasts (non-authoritative) |
| `marine_institute` | Ocean and buoy data via ERDDAP |
| `data_gov_ie` | National open data catalogue |
| `smart_dublin` | Dublin city datasets |
| `seai` | Sustainable Energy Authority of Ireland catalogue |
| `tfi_nta` | Public transport feed metadata (links only) |
| `open_data_ni` | Northern Ireland, UK catalogue (kept separate on purpose) |

**Coming soon:** `geohive` (geospatial), `opw` (river levels), `eirgrid`
(electricity generation and flows) and `epa` (bathing waters) are in the works
and will show up in future releases.

Each provider YAML may set `enabled: false` to omit that source. When the field
is absent, the source is enabled.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_sources` | See available sources, capabilities and rate limits |
| `search_data_by_source` | Find datasets in one source |
| `describe_data_by_id` | Inspect a dataset, its access points and query options |
| `query_data_by_id` | Fetch rows with filters, fields, spatial and time selectors |
| `get_data_link_by_id` | Get a browser-openable link to a raw file |

Use `source + data_id` for one data object and `access_id` for one of its
query or download access points. Raw files are links, not streamed through MCP.
The server does no joins, analytics or recommendations, so what you see is what
the publisher released.

## Local development

Requires Node.js 22+.

```bash
npm install
cp .env.example .env
npm run dev
```

MCP endpoint:
`https://open-data-mcp.siddhanthnb.workers.dev/mcp`

Authentication is selected in `config/server.yml`. See
[`docs/authentication.md`](docs/authentication.md).

## Checks

```bash
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

## Deploy

```bash
npm run deploy
```

Publishing a `v*` Git tag runs checks and deploys that tagged commit through
GitHub Actions. Configure the repository secrets
`OPEN_DATA_MCP_CLOUDFLARE_DEPLOY_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` first.

Runtime: Cloudflare Workers, TypeScript, stateless Streamable HTTP at `/mcp`,
and YAML-configured provider adapters.

## Logs

Cloudflare Workers Logs stores flat OpenTelemetry-correlated console lines.
Each non-health request gets a fresh trace ID and returns the same ID as
`X-Request-ID`. Production defaults to `INFO`; set
`OPEN_DATA_MCP_LOG_LEVEL=debug` locally to include outbound HTTP and Redis spans.
No trace exporter or tracing backend is configured. `/ping` is untraced.
