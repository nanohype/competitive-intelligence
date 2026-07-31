import { beforeEach, describe, expect, it, vi } from "vitest";

// The guard's contract is "resolve once, then gate on the resolved address",
// and that cannot be exercised without controlling resolution — a hostname whose
// DNS answer is internal is the attack this file exists to stop, and it is
// invisible if the resolver is real. `node:dns/promises` is a platform builtin
// rather than a vendor SDK, so this does not fall under the don't-mock-the-SDK
// rule. It also takes the public-host cases off live DNS, which they should
// never have depended on.
const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup }));

const { guardUrl, UrlGuardError } = await import("./url-guard.js");

/** example.com. Public, so the guard should let it through. */
const PUBLIC_V4 = "93.184.216.34";

beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue({ address: PUBLIC_V4, family: 4 });
});

describe("guardUrl", () => {
  it("accepts http and https URLs to public hosts", async () => {
    await expect(guardUrl("https://example.com/path")).resolves.toBeInstanceOf(URL);
    await expect(guardUrl("http://example.com")).resolves.toBeInstanceOf(URL);
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com",
    "gopher://example.com",
    "javascript:alert(1)",
  ])("rejects non-http(s) scheme %s", async (url) => {
    await expect(guardUrl(url)).rejects.toThrow(UrlGuardError);
  });

  it("rejects a hostless URL even when its scheme is explicitly allowed", async () => {
    // Only reachable through a custom allow-list. Opting a scheme in must not
    // also opt out of the host checks — `file:` has no host to gate on, so the
    // guard has nothing left to protect and must refuse rather than proceed.
    await expect(guardUrl("file:///etc/passwd", { allowedSchemes: ["file:"] })).rejects.toThrow(
      /missing host/,
    );
  });

  it.each([
    "http://127.0.0.1",
    "http://127.55.55.1/api",
    "http://10.0.0.1",
    "http://172.16.0.5",
    "http://172.31.255.1",
    "http://192.168.1.1",
    "http://169.254.169.254/latest/meta-data/", // AWS metadata
    "http://0.0.0.0",
  ])("rejects IPv4 private/loopback/metadata literal %s", async (url) => {
    await expect(guardUrl(url)).rejects.toThrow(/blocked address/);
  });

  it.each(["http://[::1]/", "http://[::]/", "http://[fe80::1]/", "http://[fd12:3456:789a::1]/"])(
    "rejects IPv6 loopback / unspecified / link-local / ULA literal %s",
    async (url) => {
      await expect(guardUrl(url)).rejects.toThrow(/blocked address/);
    },
  );

  it.each([
    "http://[::ffff:127.0.0.1]/", // mapped loopback
    "http://[::ffff:169.254.169.254]/latest/meta-data/", // mapped AWS metadata
    "http://[::ffff:10.0.0.1]/", // mapped RFC1918
    "http://[::ffff:192.168.1.1]/", // mapped RFC1918
  ])("rejects IPv4-mapped IPv6 that embeds a blocked address %s", async (url) => {
    await expect(guardUrl(url)).rejects.toThrow(/blocked address/);
  });

  it("still accepts an IPv4-mapped IPv6 wrapping a public address", async () => {
    // ::ffff:93.184.216.34 (example.com) — mapped, but public, so allowed.
    await expect(guardUrl("http://[::ffff:93.184.216.34]/")).resolves.toBeInstanceOf(URL);
  });

  it("rejects malformed URLs", async () => {
    await expect(guardUrl("not a url")).rejects.toThrow(/malformed URL/);
  });

  describe("gating on the resolved address", () => {
    it("rejects an ordinary hostname whose DNS answer is internal", async () => {
      // The whole point of resolving before fetching. Nothing about the URL
      // looks wrong; the answer is the cloud metadata endpoint.
      lookup.mockResolvedValue({ address: "169.254.169.254", family: 4 });
      await expect(guardUrl("https://totally-normal.example/")).rejects.toThrow(
        /blocked address 169\.254\.169\.254/,
      );
    });

    it("rejects a resolver answer in dotted IPv4-mapped form", async () => {
      // `new URL()` normalizes a bracketed literal to the hex-quad spelling, so
      // the dotted form can only arrive from a resolver — the one source we do
      // not control, and therefore the one that has to be decoded rather than
      // pattern-matched.
      lookup.mockResolvedValue({ address: "::ffff:127.0.0.1", family: 6 });
      await expect(guardUrl("https://rebind.example/")).rejects.toThrow(/blocked address/);
    });

    it("treats an undecodable mapped tail as unmapped rather than as blocked", async () => {
      // Not a real address, but it decides which way the decoder fails. Guessing
      // "blocked" here would let a malformed answer take down crawling of a
      // legitimate host; the address is still gated by the plain IPv6 rules
      // below it.
      lookup.mockResolvedValue({ address: "::ffff:1.2.3.999", family: 6 });
      await expect(guardUrl("https://odd.example/")).resolves.toBeInstanceOf(URL);
    });

    it.each([
      ["too many hex groups", "::ffff:1:2:3"],
      ["a non-hex group", "::ffff:zzzz:1"],
    ])("treats %s in a mapped tail as unmapped", async (_label, address) => {
      lookup.mockResolvedValue({ address, family: 6 });
      await expect(guardUrl("https://odd.example/")).resolves.toBeInstanceOf(URL);
    });
  });
});
