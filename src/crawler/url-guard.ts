import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface UrlGuardOptions {
  readonly allowedSchemes?: readonly string[];
}

const DEFAULT_SCHEMES = ["http:", "https:"] as const;

export class UrlGuardError extends Error {
  constructor(
    public readonly reason: string,
    public readonly url: string,
  ) {
    super(`URL guard rejected ${url}: ${reason}`);
    this.name = "UrlGuardError";
  }
}

/**
 * SSRF guard: rejects URLs that would let an operator-supplied source
 * pivot into internal services (cloud metadata, RFC1918 subnets, loopback,
 * link-local). Run before every outbound `fetch` on operator-controlled
 * URLs. Hostname is resolved once here so the same address is what we
 * gate on, but DNS-rebinding remains a theoretical concern — the fetch
 * could still re-resolve. For competitive intel against external
 * marketing pages, that's an acceptable residual risk.
 */
export async function guardUrl(rawUrl: string, options: UrlGuardOptions = {}): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UrlGuardError("malformed URL", rawUrl);
  }

  const schemes = options.allowedSchemes ?? DEFAULT_SCHEMES;
  if (!schemes.includes(parsed.protocol)) {
    throw new UrlGuardError(`scheme ${parsed.protocol} not allowed`, rawUrl);
  }

  const host = parsed.hostname;
  if (!host) {
    throw new UrlGuardError("missing host", rawUrl);
  }

  // `URL.hostname` wraps IPv6 literals in brackets (`[::1]`); `isIP`
  // wants the bare address.
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  // If the host is already an IP literal, gate directly on it. Otherwise
  // resolve once and gate on the resolved address.
  const addresses = isIP(bareHost) ? [bareHost] : [(await lookup(bareHost)).address];
  for (const addr of addresses) {
    if (isBlockedAddress(addr)) {
      throw new UrlGuardError(`resolves to blocked address ${addr}`, rawUrl);
    }
  }

  return parsed;
}

function isBlockedAddress(addr: string): boolean {
  // IPv4 private + loopback + link-local + cloud metadata.
  if (isIP(addr) === 4) {
    const parts = addr.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // includes 169.254.169.254 AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }

  const lower = addr.toLowerCase();

  // IPv4-mapped IPv6 (::ffff:a.b.c.d). `new URL()` normalizes the dotted tail to
  // a hex-quad (::ffff:7f00:1, ::ffff:a9fe:a9fe), so decode both forms and
  // re-gate on the embedded IPv4 — otherwise mapped loopback / RFC1918 / cloud
  // metadata slips past the IPv4 checks above.
  if (lower.startsWith("::ffff:")) {
    const mapped = ipv4FromMapped(lower.slice("::ffff:".length));
    if (mapped && isBlockedAddress(mapped)) return true;
  }

  // IPv6: loopback, link-local (fe80::/10), unique-local (fc00::/7), unspecified.
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

/** Decode the tail of an IPv4-mapped IPv6 address to dotted IPv4, or null. */
function ipv4FromMapped(tail: string): string | null {
  // Dotted form (::ffff:1.2.3.4) — rare after URL normalization, but cheap to handle.
  if (tail.includes(".")) {
    return isIP(tail) === 4 ? tail : null;
  }
  // Hex-quad form (::ffff:7f00:1) — two 16-bit groups = the embedded 4 bytes.
  const groups = tail.split(":");
  if (groups.length !== 2) return null;
  const hi = Number.parseInt(groups[0], 16);
  const lo = Number.parseInt(groups[1], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}
