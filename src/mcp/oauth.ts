import {
  type CryptoKey,
  createRemoteJWKSet,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";

/** The key material `jose.jwtVerify` accepts — a public key, a shared secret, or a JWKS resolver. */
type VerifyKey = CryptoKey | Uint8Array | JWTVerifyGetKey;

/**
 * OAuth 2.1 resource-server protection for the MCP surface.
 *
 * The MCP server is a *resource server* (RFC 9728 / MCP authorization spec,
 * 2025-06-18). The authorization server is WorkOS AuthKit — it lives entirely
 * in the WorkOS dashboard (DCR/CIMD, resource indicators, scopes), not in this
 * code. This module does the three things the resource-server half owes:
 *
 *   1. serves Protected Resource Metadata (RFC 9728) so a client can discover
 *      the authorization server for this resource;
 *   2. enforces a `Bearer` token on `/mcp`, answering with the RFC 9728 §5.1
 *      `WWW-Authenticate: Bearer resource_metadata="…"` challenge on failure;
 *   3. validates the token — signature (WorkOS JWKS), `iss`, `exp`/`nbf`, and
 *      critically the `aud` (RFC 8707): the token MUST be issued for *this*
 *      server's canonical URI, so a token minted for another resource is
 *      rejected even if it is otherwise valid.
 *
 * The token is never forwarded to Bedrock — Bedrock authenticates with its own
 * IRSA credential. This layer only decides whether the caller may reach the
 * tools.
 *
 * Deliberately self-contained (only depends on `jose` + the config it is handed)
 * so it can later be lifted into the shared `@nanohype/runtime` library and
 * reused by other tenants (incident-response et al.) without dragging app wiring
 * along.
 */

/** The RFC 9728 well-known prefix all protected-resource metadata hangs under. */
const WELL_KNOWN_PREFIX = "/.well-known/oauth-protected-resource";

export interface OAuthConfig {
  /**
   * The WorkOS AuthKit issuer, e.g. `https://your-app.authkit.app`. Both the
   * `iss` the token must carry and the base the JWKS (`<issuer>/oauth2/jwks`)
   * is fetched from.
   */
  issuer: string;
  /**
   * This MCP server's canonical resource URI — its public HTTPS URL including
   * the `/mcp` path (config `MCP_PUBLIC_URL`). This is the RFC 8707 resource
   * indicator and the value the token's `aud` must equal.
   */
  resource: string;
  /**
   * Scopes every request must present (default none). When set, a token missing
   * any of them is rejected with 403 `insufficient_scope`.
   */
  requiredScopes?: string[];
}

/**
 * Verifies a raw bearer token and returns its claims, or throws on any failure
 * (bad signature, wrong issuer, expired, wrong audience). The single injectable
 * seam: production wires the WorkOS JWKS verifier, tests wire a local key set —
 * no live WorkOS, no SDK module-mocking.
 */
export type VerifyToken = (token: string) => Promise<JWTPayload>;

/**
 * Build the WorkOS token verifier. Signature is checked against the AuthKit
 * JWKS, `iss` must equal the issuer, and `aud` must equal `audience` (the RFC
 * 8707 binding — this is the hard security check). `exp`/`nbf` are enforced by
 * `jwtVerify`.
 *
 * `jwks` is injectable: production leaves it unset and a remote key set is
 * resolved from `<issuer>/oauth2/jwks` (WorkOS's JWKS endpoint); tests pass a
 * local key set so the real jose verification path — audience binding included
 * — runs without touching the network. `jose` is used rather than the WorkOS
 * SDK because its `jwtVerify` checks `iss`+`aud`+`exp` in one call with a native
 * audience assertion, which is exactly (and only) what a resource server needs.
 */
export function createWorkosVerifier(opts: {
  issuer: string;
  audience: string;
  jwks?: VerifyKey;
}): VerifyToken {
  const keys = opts.jwks ?? createRemoteJWKSet(new URL(`${trimSlash(opts.issuer)}/oauth2/jwks`));
  const verifyOptions = { issuer: opts.issuer, audience: opts.audience };
  return async (token: string): Promise<JWTPayload> => {
    // Narrow the injected key: a JWKS resolver (function) vs. direct key material
    // — the two `jwtVerify` overloads each take one, and a union satisfies neither.
    const { payload } =
      typeof keys === "function"
        ? await jwtVerify(token, keys, verifyOptions)
        : await jwtVerify(token, keys, verifyOptions);
    return payload;
  };
}

/** The RFC 9728 Protected Resource Metadata document served for this resource. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported?: string[];
}

export function protectedResourceMetadata(config: OAuthConfig): ProtectedResourceMetadata {
  const metadata: ProtectedResourceMetadata = {
    resource: config.resource,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
  };
  if (config.requiredScopes && config.requiredScopes.length > 0) {
    metadata.scopes_supported = config.requiredScopes;
  }
  return metadata;
}

/**
 * Split the optional MCP_AUTH_SCOPES env (space- or comma-delimited) into the
 * `requiredScopes` list. An env var that is set but contains only separators
 * yields `undefined` rather than `[]`, so a stray value cannot quietly turn
 * scope enforcement into a check against an empty list.
 */
export function parseScopes(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const scopes = raw.split(/[\s,]+/).filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

/** The outcome of enforcing auth on a request. */
export type AuthDecision =
  | { ok: true; claims: JWTPayload }
  | {
      ok: false;
      status: 400 | 401 | 403;
      wwwAuthenticate: string;
      body: { error: string; error_description: string };
    };

export interface OAuthProtection {
  /** The Protected Resource Metadata document (also exposed for tests). */
  readonly metadata: ProtectedResourceMetadata;
  /**
   * The absolute metadata URL advertised in the `WWW-Authenticate` challenge —
   * the RFC 9728 path-specific location for a resource at `<base>/mcp`.
   */
  readonly metadataUrl: string;
  /**
   * True if `pathname` addresses the protected-resource metadata (the bare
   * well-known path or its path-specific form). Served without auth.
   */
  isMetadataRequest(pathname: string): boolean;
  /** Enforce a `Bearer` token. Resolves `{ ok: true }` when the caller may proceed. */
  authorize(authorizationHeader: string | undefined): Promise<AuthDecision>;
}

/**
 * Assemble the resource-server protection. `verify` is injected (production: the
 * WorkOS JWKS verifier; tests: a local-key verifier) — the module never reaches
 * WorkOS on its own, which is what keeps it unit-testable and portable.
 */
export function createOAuthProtection(
  config: OAuthConfig,
  verify: VerifyToken = createWorkosVerifier({ issuer: config.issuer, audience: config.resource }),
): OAuthProtection {
  const { origin, pathname } = new URL(config.resource);
  // RFC 9728 §3.1: for a resource at `<origin><path>`, the metadata lives at
  // `<origin>/.well-known/oauth-protected-resource<path>`. Serve both that and
  // the bare well-known path so a client discovering either way succeeds.
  const specificPath =
    pathname && pathname !== "/" ? `${WELL_KNOWN_PREFIX}${pathname}` : WELL_KNOWN_PREFIX;
  const metadataUrl = `${origin}${specificPath}`;
  const metadataPaths = new Set<string>([WELL_KNOWN_PREFIX, specificPath]);
  const requiredScopes = config.requiredScopes ?? [];
  const metadata = protectedResourceMetadata(config);

  const challenge = (params: Record<string, string>): string => {
    const parts = Object.entries({ ...params, resource_metadata: metadataUrl }).map(
      ([k, v]) => `${k}="${v.replace(/"/g, "")}"`,
    );
    return `Bearer ${parts.join(", ")}`;
  };

  return {
    metadata,
    metadataUrl,
    isMetadataRequest: (path) => metadataPaths.has(path),
    async authorize(authorizationHeader): Promise<AuthDecision> {
      if (!authorizationHeader) {
        // RFC 6750: bare challenge (no error code) when no credentials are sent,
        // but RFC 9728 §5.1 still requires the resource_metadata pointer.
        return {
          ok: false,
          status: 401,
          wwwAuthenticate: challenge({}),
          body: { error: "unauthorized", error_description: "missing bearer token" },
        };
      }

      const match = /^Bearer (.+)$/.exec(authorizationHeader.trim());
      if (!match?.[1].trim()) {
        // A present-but-unparseable Authorization header is a malformed request.
        return {
          ok: false,
          status: 400,
          wwwAuthenticate: challenge({ error: "invalid_request" }),
          body: {
            error: "invalid_request",
            error_description: 'Authorization header must be "Bearer <token>"',
          },
        };
      }

      let claims: JWTPayload;
      try {
        claims = await verify(match[1].trim());
      } catch (err) {
        return {
          ok: false,
          status: 401,
          wwwAuthenticate: challenge({ error: "invalid_token" }),
          body: { error: "invalid_token", error_description: describeVerifyError(err) },
        };
      }

      if (requiredScopes.length > 0) {
        const granted = grantedScopes(claims);
        const missing = requiredScopes.filter((s) => !granted.has(s));
        if (missing.length > 0) {
          return {
            ok: false,
            status: 403,
            wwwAuthenticate: challenge({
              error: "insufficient_scope",
              scope: requiredScopes.join(" "),
            }),
            body: {
              error: "insufficient_scope",
              error_description: `missing required scope(s): ${missing.join(", ")}`,
            },
          };
        }
      }

      return { ok: true, claims };
    },
  };
}

/** Collect the scopes a token grants — OAuth `scope` (space-delimited) or `scp` (array). */
function grantedScopes(claims: JWTPayload): Set<string> {
  const raw = claims.scope ?? claims.scp;
  if (typeof raw === "string") return new Set(raw.split(/\s+/).filter(Boolean));
  if (Array.isArray(raw)) return new Set(raw.filter((s): s is string => typeof s === "string"));
  return new Set();
}

/** A short, non-leaky reason for a rejected token (audience/issuer/expiry/signature). */
function describeVerifyError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code: unknown }).code);
    switch (code) {
      case "ERR_JWT_EXPIRED":
        return "token expired";
      case "ERR_JWT_CLAIM_VALIDATION_FAILED":
        // Wrong audience or issuer — RFC 8707 mismatch lands here.
        return "token claims invalid for this resource";
      case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      case "ERR_JWKS_NO_MATCHING_KEY":
        return "token signature invalid";
      default:
        return "token verification failed";
    }
  }
  return "token verification failed";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
