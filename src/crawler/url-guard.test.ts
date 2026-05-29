import { describe, expect, it } from "vitest";
import { guardUrl, UrlGuardError } from "./url-guard.js";

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

  it.each(["http://[::1]/", "http://[fe80::1]/", "http://[fd12:3456:789a::1]/"])(
    "rejects IPv6 loopback / link-local / ULA literal %s",
    async (url) => {
      await expect(guardUrl(url)).rejects.toThrow(/blocked address/);
    },
  );

  it("rejects malformed URLs", async () => {
    await expect(guardUrl("not a url")).rejects.toThrow(/malformed URL/);
  });
});
