import { describe, expect, it } from "vitest";
import { guardedRequest, isBlockedAddress, safeLookup, validateUrl } from "../src/main/net/guard";

describe("HTTP guard (spec 8.5, AC-11)", () => {
  it.each([
    ["127.0.0.1", true], ["10.1.2.3", true], ["172.16.0.1", true], ["172.31.255.255", true], ["192.168.1.1", true],
    ["169.254.169.254", true], ["100.64.0.1", true], ["0.0.0.0", true], ["224.0.0.1", true], ["255.255.255.255", true],
    ["::1", true], ["::", true], ["fe80::1", true], ["fd00::1", true], ["::ffff:127.0.0.1", true], ["::ffff:10.0.0.1", true],
    ["not-an-ip", true],
    ["104.18.10.10", false], ["172.32.0.1", false], ["8.8.8.8", false], ["2606:4700::6810:850a", false], ["::ffff:8.8.8.8", false],
  ])("isBlockedAddress(%s) = %s", (addr, blocked) => {
    expect(isBlockedAddress(addr)).toBe(blocked);
  });

  it("allows https to an allowlisted host", () => {
    expect(validateUrl("https://api.modrinth.com/v2/search", ["api.modrinth.com"]).hostname).toBe("api.modrinth.com");
  });
  it.each([
    ["http://api.modrinth.com/", "Only HTTPS"],
    ["https://user:pw@api.modrinth.com/", "credentials"],
    ["https://evil.example/", "doesn't connect"],
    ["https://127.0.0.1/", "doesn't connect"],
    ["file:///etc/passwd", "Only HTTPS"],
    ["not a url", "Not a valid address"],
  ])("refuses %s", (url, msg) => {
    expect(() => validateUrl(url, ["api.modrinth.com"])).toThrow(msg);
  });
  it.each(["https://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/latest/meta-data", "https://localhost/", "https://a.localhost/"])(
    "refuses local or metadata target %s without an allowlist", (url) => {
      expect(() => validateUrl(url)).toThrow(/Refused/);
    });

  it("refuses a hostname that resolves to a local address, at lookup time", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => safeLookup("localhost", { all: true }, (e) => resolve(e)));
    expect(err?.code).toBe("EBLOCKED");
  });

  it("never opens a connection to a blocked literal", async () => {
    await expect(guardedRequest("https://10.0.0.1/")).rejects.toMatchObject({ code: "blocked-url" });
  });

  it("a request whose run was stopped never starts, and says stopped", async () => {
    await expect(guardedRequest("https://example.com/", { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "stopped" });
  });
});
