# Open Data MCP

Read-only Irish public data through one remote MCP endpoint.

## Tools

- `list_sources`
- `search_data_by_source`
- `describe_data_by_id`
- `query_data_by_id`
- `get_data_link_by_id`

The tools are source-neutral. Use `source + data_id` for one data object and
`access_id` for one of its query or download access points. Query capabilities
and accepted selectors are returned by `describe_data_by_id`.

Raw files are exposed as browser-openable links. They are not streamed through
MCP. The server performs no joins, analytics, recommendations, or derived
insights.

## Sources

Republic of Ireland and Ireland-scoped sources:

- `data_gov_ie`, `smart_dublin`, `met_eireann`, `open_meteo_ie`
- `cso_pxstat`, `marine_institute`, `geohive`, `opw`, `epa`
- `tfi_nta`, `seai`, `eirgrid`

`open_data_ni` is explicitly Northern Ireland, UK. `open_meteo_ie` is
non-authoritative model output and is currently disabled until its deployed
shared rate limits are validated; Met Éireann is the authoritative Irish weather source.
Sources are never silently merged.

Each provider YAML may set `enabled: false` to omit that source. When the field
is absent, the source is enabled.

The Phase 2 source expansion is implemented in the current branch but is not
deployment-ready until the operational gates in
[`specs/004-deployment.md`](specs/004-deployment.md) are cleared.

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
