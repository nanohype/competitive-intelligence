# MCP OAuth — WorkOS AuthKit resource server

The MCP surface (`/mcp` on `MCP_PORT`) can run as an OAuth 2.1 **resource
server**, delegating all authorization to **WorkOS AuthKit** as the authorization
server. Turning it on makes the surface addable as a **Claude custom connector**
— from an individual's claude.ai / Claude Desktop today, and enterprise
customers later — because Claude's cloud can complete a standards-based OAuth
flow against it.

This is opt-in. With `MCP_AUTH=none` (the default) the port stays open, guarded
by the mcp-tunnel + NetworkPolicy alone, exactly as it ships. Nothing below
applies until you set `MCP_AUTH=workos`.

## What the app does (resource-server half)

The app implements only the resource-server contract; WorkOS is the
authorization server (issues tokens, runs the consent screen, registers
clients). Concretely, when `MCP_AUTH=workos`:

- **Protected Resource Metadata (RFC 9728)** is served, unauthenticated, at
  `/.well-known/oauth-protected-resource` and the path-specific
  `/.well-known/oauth-protected-resource/mcp`:

  ```json
  {
    "resource": "https://<public-host>/mcp",
    "authorization_servers": ["https://<tenant>.authkit.app"],
    "bearer_methods_supported": ["header"]
  }
  ```

- **Bearer enforcement on `/mcp`.** Every request needs
  `Authorization: Bearer <token>`. On failure the response carries the RFC 9728
  §5.1 pointer so the client can discover the authorization server:

  | Condition | Status | `WWW-Authenticate` |
  |---|---|---|
  | Missing token | 401 | `Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"` |
  | Malformed `Authorization` header | 400 | `Bearer error="invalid_request", resource_metadata="…"` |
  | Bad signature / issuer / expired / **wrong audience** | 401 | `Bearer error="invalid_token", resource_metadata="…"` |
  | Missing required scope | 403 | `Bearer error="insufficient_scope", scope="…", resource_metadata="…"` |

- **Token validation** (via [`jose`](https://github.com/panva/jose)): signature
  against the WorkOS JWKS (`<issuer>/oauth2/jwks`), `iss` = the AuthKit issuer,
  `exp`/`nbf`, and critically **`aud` = this server's canonical URI**
  (`MCP_PUBLIC_URL`). This is the RFC 8707 binding: a token minted for a
  *different* MCP server is rejected even if it is otherwise perfectly valid.
  The token is never forwarded to Bedrock — Bedrock uses its own IRSA credential.

`jose` is used rather than the WorkOS SDK because its `jwtVerify` checks
`iss` + `aud` + `exp` in one call with a native audience assertion — exactly (and
only) what a resource server owes. The verifier is injectable, so tests drive the
real verification path against a local key set instead of live WorkOS.

## Environment

Set on the pod (chart `values.env`) or in `.env` locally:

| Env | Required | Meaning |
|---|---|---|
| `MCP_AUTH` | — | `none` (default) or `workos` |
| `WORKOS_AUTHKIT_ISSUER` | when `workos` | AuthKit issuer, e.g. `https://your-app.authkit.app` |
| `MCP_PUBLIC_URL` | when `workos` | This server's canonical public `/mcp` URL — the token audience. Must match the URL Claude connects to, exactly. |
| `MCP_AUTH_SCOPES` | optional | Space/comma-delimited scopes every request must present |

Config fails fast at boot if `MCP_AUTH=workos` and either the issuer or the
public URL is missing.

## WorkOS dashboard steps

1. In the WorkOS dashboard, note your **AuthKit domain** — this is
   `WORKOS_AUTHKIT_ISSUER` (`https://<tenant>.authkit.app` or your custom
   AuthKit domain).
2. Go to **Connect → Configuration** and enable MCP client authentication:
   - **Client ID Metadata Document (CIMD)** — the current MCP standard; enable it.
   - **Dynamic Client Registration (DCR)** — enable for backwards compatibility
     with older MCP clients (Claude uses DCR today).
3. In the same area, register your MCP server's public URL as a **Resource
   Indicator** — the exact value you set as `MCP_PUBLIC_URL`
   (`https://<public-host>/mcp`). WorkOS then issues access tokens with `aud`
   equal to that resource. (If no resource indicator is registered, WorkOS falls
   back to a default `aud` and ignores the client's `resource` parameter — so the
   audience check would never bind. Register it.)
4. Choose the **scopes** you want to require (optional). Mirror them in
   `MCP_AUTH_SCOPES` so the resource server enforces them too.

## Add the connector in Claude

1. In claude.ai or Claude Desktop: **Settings → Connectors** (or **Customize →
   Connectors**) → **Add custom connector** (**+**).
2. Paste the MCP URL — the public `https://<public-host>/mcp` (same value as
   `MCP_PUBLIC_URL`).
3. Claude fetches the Protected Resource Metadata, discovers the WorkOS
   authorization server, **auto-registers via DCR**, and opens the WorkOS consent
   screen. The OAuth callback is `https://claude.ai/api/mcp/auth_callback`.
4. Approve. Claude stores the access token and sends it as
   `Authorization: Bearer <token>` on every tool call.

The connector calls originate from **Anthropic's cloud**, so the MCP URL must be
publicly reachable over HTTPS — see the self-tunnel runbook below.

## Self-tunnel runbook (personal path)

For a personal connector against a local or `kx` MCP service, expose it to the
public internet over HTTPS. Claude's cloud must reach it; a `localhost` URL will
not work.

### Option A — cloudflared (named tunnel, stable hostname)

```sh
# One-time: authenticate and create a named tunnel
cloudflared tunnel login
cloudflared tunnel create ci-mcp

# Route a hostname you control (Cloudflare-managed DNS) to the tunnel
cloudflared tunnel route dns ci-mcp ci-mcp.example.com

# Run it, pointing at the MCP service:
#   - local dev:      http://localhost:3001
#   - kx port-forward: kubectl -n tenants-protohype port-forward svc/competitive-intelligence 3001:3001
cloudflared tunnel run --url http://localhost:3001 ci-mcp
```

Then set `MCP_PUBLIC_URL=https://ci-mcp.example.com/mcp` (must include `/mcp`)
and register the same URL as the WorkOS Resource Indicator. Add
`https://ci-mcp.example.com/mcp` as the connector URL in Claude.

### Option B — ngrok (quick, ephemeral hostname)

```sh
ngrok http 3001
# → forwards https://<random>.ngrok-free.app to :3001
```

Use `https://<random>.ngrok-free.app/mcp` as both `MCP_PUBLIC_URL` and the WorkOS
Resource Indicator. Because the audience is bound to this exact URL, re-register
it whenever the ngrok hostname changes (or use a reserved domain).

> The in-cluster production path does not use a self-tunnel: the `mcp-tunnel`
> addon (outbound-only `cloudflared`, hostname routing) already fronts the MCP
> service and is the single ingress. There, `MCP_PUBLIC_URL` is the tunnel's
> public hostname + `/mcp`.
