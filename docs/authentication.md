# Authentication

Authentication is selected by `auth.mode` in `config/server.yml`.

The checked-in configuration uses `oauth`.

## None

`none` leaves `/mcp` anonymous. Select it explicitly in `config/server.yml`.

## Bearer

`bearer` requires `Authorization: Bearer <token>` on `/mcp`. Set a random token of at least 32 characters locally as `OPEN_DATA_MCP_BEARER_TOKEN`, or in production with:

```sh
npx wrangler secret put OPEN_DATA_MCP_BEARER_TOKEN
```

This mode is for manually provisioned automation. It does not expose OAuth discovery and does not use HTTP Basic authentication.

## OAuth with GitHub identity

`oauth` makes this Worker the MCP authorization server. GitHub only signs the user in. The Worker issues its own resource-bound MCP access and refresh tokens through `@cloudflare/workers-oauth-provider`.

Before enabling it:

1. Create a GitHub OAuth App.
2. Set its callback URL to `<public_base_url>/oauth/callback`.
3. Set `oauth.public_base_url` in `config/server.yml` to the Worker's canonical HTTPS origin.
4. Create a KV namespace with `npx wrangler kv namespace create OAUTH_KV`.
5. Add its binding to `wrangler.jsonc`:

```json
"kv_namespaces": [
  {
    "binding": "OAUTH_KV",
    "id": "<KV_NAMESPACE_ID>"
  }
]
```

6. Add production secrets:

```sh
npx wrangler secret put OPEN_DATA_MCP_GITHUB_OAUTH_CLIENT_ID
npx wrangler secret put OPEN_DATA_MCP_GITHUB_OAUTH_CLIENT_SECRET
```

For local development, copy `.env.example` to `.env` and set real values there. The default `http://127.0.0.1:8787` public base URL is allowed only for local loopback development.

`github.timeout_ms` limits each GitHub token or user request, including reading and parsing its full response body. The default is 10 seconds.

OAuth routes:

- MCP resource: `/mcp`
- User authorization and consent: `/authorize`
- GitHub callback: `/oauth/callback`
- Token and revocation: `/oauth/token`
- Dynamic client registration: `/oauth/register`
- Protected-resource discovery: `/.well-known/oauth-protected-resource/mcp`
- Authorization-server discovery: `/.well-known/oauth-authorization-server`

OAuth state, consent transactions, client registrations, grants, and token records use `OAUTH_KV`. MCP requests remain stateless and do not use Durable Objects.
