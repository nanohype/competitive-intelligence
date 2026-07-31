import { type CryptoKey, createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
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

  it("403 when the token carries no scope claim at all", async () => {
    // Distinct from carrying the wrong scopes: a token with no `scope` and no
    // `scp` must read as granting nothing, never as unconstrained.
    const token = await mintToken();
    const decision = await makeProtection(["intel:read"]).authorize(`Bearer ${token}`);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.status).toBe(403);
    expect(decision.body.error).toBe("insufficient_scope");
  });

  it("401 with a signature-specific reason when the token is signed by an untrusted key", async () => {
    // Different from the malformed-token case above. This token is well-formed,
    // correctly-audienced and unexpired — it is only signed by a key this
    // resource does not trust, which is the forgery attempt rather than a
    // client bug, and jose reports it under its own error code.
    const attacker = await generateKeyPair("RS256");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user_123")
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(attacker.privateKey);

    const decision = await makeProtection().authorize(`Bearer ${token}`);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.status).toBe(401);
    expect(decision.body.error_description).toBe("token signature invalid");
  });

  it("reports a generic reason when the verifier throws something that is not an object", async () => {
    // Nothing in jose throws a bare primitive, but `describeVerifyError` reads
    // `code` off the thrown value and this is the arm that keeps a non-standard
    // throw from surfacing as an unhandled rejection or an "undefined" reason.
    const protection = createOAuthProtection({ issuer: ISSUER, resource: RESOURCE }, () => {
      throw "not an error object";
    });
    const decision = await protection.authorize("Bearer anything");
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.status).toBe(401);
    expect(decision.body.error_description).toBe("token verification failed");
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

  it("accepts scopes delivered as an `scp` array", async () => {
    // Authorization servers split on this: OAuth's `scope` is space-delimited,
    // while `scp` arrives as an array. Reading only the first would silently
    // treat every token from such a server as granting nothing.
    const token = await new SignJWT({ scp: ["intel:read", "intel:write"] })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user_123")
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const decision = await makeProtection(["intel:read"]).authorize(`Bearer ${token}`);
    expect(decision.ok).toBe(true);
  });

  it("ignores non-string entries in an `scp` array", async () => {
    const token = await new SignJWT({ scp: ["intel:read", 42, null] })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user_123")
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const decision = await makeProtection(["intel:read"]).authorize(`Bearer ${token}`);
    expect(decision.ok).toBe(true);
  });
});

describe("createWorkosVerifier without an injected key set", () => {
  it("derives the WorkOS JWKS URL, tolerating a trailing slash on the issuer", () => {
    // Production leaves `jwks` unset, so this is the only path that builds the
    // remote key set — and the only one where a trailing slash on the issuer
    // would produce a double-slashed JWKS URL. `createRemoteJWKSet` resolves
    // lazily, so constructing it touches no network.
    expect(() => createWorkosVerifier({ issuer: `${ISSUER}/`, audience: RESOURCE })).not.toThrow();
    expect(() => createWorkosVerifier({ issuer: ISSUER, audience: RESOURCE })).not.toThrow();
  });

  it("verifies against a JWKS resolver, not just direct key material", async () => {
    // Production resolves keys through a JWKS *function*; the tests above pass a
    // key object. Those are separate `jwtVerify` overloads and separate arms in
    // the verifier, so the arm production actually runs would otherwise never be
    // executed here. `createLocalJWKSet` is the same resolver shape as
    // `createRemoteJWKSet` with the network removed.
    const jwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256", use: "sig" }] });
    const verify = createWorkosVerifier({ issuer: ISSUER, audience: RESOURCE, jwks });
    const protection = createOAuthProtection({ issuer: ISSUER, resource: RESOURCE }, verify);

    const decision = await protection.authorize(`Bearer ${await mintToken()}`);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.claims.sub).toBe("user_123");
  });
});

describe("metadata for a resource served at the origin root", () => {
  it("uses the bare well-known path when the resource has no path segment", () => {
    // RFC 9728 §3.1 appends the resource path to the well-known prefix. With no
    // path there is nothing to append, and appending "/" anyway would advertise
    // a trailing-slash URL that does not match the route the server serves.
    const rootResource = "https://ci.example.com";
    const protection = createOAuthProtection(
      { issuer: ISSUER, resource: rootResource },
      createWorkosVerifier({ issuer: ISSUER, audience: rootResource, jwks: publicKey }),
    );
    expect(protection.isMetadataRequest("/.well-known/oauth-protected-resource")).toBe(true);
    expect(protection.metadataUrl).toBe(
      "https://ci.example.com/.well-known/oauth-protected-resource",
    );
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
