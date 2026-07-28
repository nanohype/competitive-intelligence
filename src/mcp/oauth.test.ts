import { type CryptoKey, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createOAuthProtection,
  createWorkosVerifier,
  type OAuthProtection,
  parseScopes,
  protectedResourceMetadata,
} from "./oauth.js";

// The verifier is exercised over the REAL jose verification path — a local RSA
// key set signs the tokens and backs the verifier, so signature + issuer + `aud`
// (RFC 8707) are all enforced by jose itself. No live WorkOS is touched and the
// WorkOS SDK is never module-mocked: the injected key material is the only seam.

const ISSUER = "https://ci-tenant.authkit.app";
const RESOURCE = "https://ci.example.com/mcp";
const OTHER_RESOURCE = "https://someone-else.example.com/mcp";

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair("RS256"));
});

/** Mint a token as WorkOS would — signed by the test key, with the given claims. */
async function mintToken(
  claims: {
    aud?: string;
    iss?: string;
    scope?: string;
    expiresIn?: string | number;
    notBefore?: string;
  } = {},
): Promise<string> {
  let jwt = new SignJWT({ ...(claims.scope ? { scope: claims.scope } : {}) })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject("user_123")
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? RESOURCE)
    .setIssuedAt();
  jwt = jwt.setExpirationTime(claims.expiresIn ?? "5m");
  if (claims.notBefore) jwt = jwt.setNotBefore(claims.notBefore);
  return jwt.sign(privateKey);
}

/** Protection backed by the local key set — production would use the WorkOS JWKS. */
function makeProtection(requiredScopes?: string[]): OAuthProtection {
  const verify = createWorkosVerifier({ issuer: ISSUER, audience: RESOURCE, jwks: publicKey });
  return createOAuthProtection({ issuer: ISSUER, resource: RESOURCE, requiredScopes }, verify);
}

describe("protectedResourceMetadata", () => {
  it("advertises this resource and the WorkOS issuer as the authorization server", () => {
    const meta = protectedResourceMetadata({ issuer: ISSUER, resource: RESOURCE });
    expect(meta.resource).toBe(RESOURCE);
    expect(meta.authorization_servers).toEqual([ISSUER]);
    expect(meta.bearer_methods_supported).toEqual(["header"]);
    expect(meta.scopes_supported).toBeUndefined();
  });

  it("includes scopes_supported only when scopes are required", () => {
    const meta = protectedResourceMetadata({
      issuer: ISSUER,
      resource: RESOURCE,
      requiredScopes: ["intel:read"],
    });
    expect(meta.scopes_supported).toEqual(["intel:read"]);
  });
});

describe("metadata routing (RFC 9728)", () => {
  const oauth = () => makeProtection();

  it("serves the bare and path-specific well-known locations", () => {
    const p = oauth();
    expect(p.isMetadataRequest("/.well-known/oauth-protected-resource")).toBe(true);
    expect(p.isMetadataRequest("/.well-known/oauth-protected-resource/mcp")).toBe(true);
    expect(p.isMetadataRequest("/mcp")).toBe(false);
  });

  it("advertises the path-specific metadata URL in the challenge", () => {
    expect(oauth().metadataUrl).toBe(
      "https://ci.example.com/.well-known/oauth-protected-resource/mcp",
    );
  });
});

describe("authorize — rejection paths", () => {
  it("401 + resource_metadata challenge when the bearer token is missing", async () => {
    const decision = await makeProtection().authorize(undefined);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.status).toBe(401);
    expect(decision.wwwAuthenticate).toContain("Bearer");
    expect(decision.wwwAuthenticate).toContain(
      'resource_metadata="https://ci.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("400 invalid_request when the Authorization header is malformed", async () => {
    const decision = await makeProtection().authorize("Basic abc123");
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.status).toBe(400);
    expect(decision.body.error).toBe("invalid_request");
    expect(decision.wwwAuthenticate).toContain('error="invalid_request"');
  });

  it("401 invalid_token when the signature does not verify", async () => {
    const decision = await makeProtection().authorize("Bearer not-a-real-jwt");
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.status).toBe(401);
    expect(decision.body.error).toBe("invalid_token");
    expect(decision.wwwAuthenticate).toContain('error="invalid_token"');
  });

  it("401 when the token is expired", async () => {
    const token = await mintToken({ expiresIn: Math.floor(Date.now() / 1000) - 60 });
    const decision = await makeProtection().authorize(`Bearer ${token}`);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.status).toBe(401);
    expect(decision.body.error_description).toBe("token expired");
  });

  it("401 when the issuer does not match", async () => {
    const token = await mintToken({ iss: "https://evil.authkit.app" });
    const decision = await makeProtection().authorize(`Bearer ${token}`);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.status).toBe(401);
  });

  // The load-bearing RFC 8707 security test: a perfectly valid, correctly-signed,
  // unexpired token minted for ANOTHER resource must be rejected here.
  it("401 when the audience is bound to a different resource (RFC 8707)", async () => {
    const token = await mintToken({ aud: OTHER_RESOURCE });
    const decision = await makeProtection().authorize(`Bearer ${token}`);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.status).toBe(401);
    expect(decision.body.error).toBe("invalid_token");
  });

  it("403 insufficient_scope when a required scope is absent", async () => {
    const token = await mintToken({ scope: "intel:read" });
    const decision = await makeProtection(["intel:read", "intel:write"]).authorize(
      `Bearer ${token}`,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.status).toBe(403);
    expect(decision.body.error).toBe("insufficient_scope");
    expect(decision.wwwAuthenticate).toContain('scope="intel:read intel:write"');
  });
});

describe("authorize — acceptance", () => {
  it("accepts a correctly-audienced, signed, unexpired token", async () => {
    const token = await mintToken();
    const decision = await makeProtection().authorize(`Bearer ${token}`);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.claims.sub).toBe("user_123");
    expect(decision.claims.aud).toBe(RESOURCE);
  });

  it("accepts when all required scopes are present", async () => {
    const token = await mintToken({ scope: "intel:read intel:write" });
    const decision = await makeProtection(["intel:read"]).authorize(`Bearer ${token}`);
    expect(decision.ok).toBe(true);
  });
});

describe("parseScopes", () => {
  it("returns undefined when the env var is unset or empty", () => {
    expect(parseScopes(undefined)).toBeUndefined();
    expect(parseScopes("")).toBeUndefined();
  });

  it("splits on spaces and on commas", () => {
    expect(parseScopes("intel:read intel:write")).toEqual(["intel:read", "intel:write"]);
    expect(parseScopes("intel:read,intel:write")).toEqual(["intel:read", "intel:write"]);
    expect(parseScopes("intel:read, intel:write")).toEqual(["intel:read", "intel:write"]);
  });

  it("returns undefined for a value that is only separators", () => {
    // Not `[]`. An empty required-scope array reads as "enforce scopes" while
    // checking against nothing, which is a stricter-looking config that
    // enforces less than the unset one.
    expect(parseScopes("  ,, ")).toBeUndefined();
  });
});
