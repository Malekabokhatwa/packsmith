import { describe, expect, it } from "vitest";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { KeyStore, type Crypto } from "../src/main/keys";
import { makeRedactor } from "../src/main/redact";
import { tempDir } from "./helpers";

const fakeCrypto = (backend: string, rotate = false): Crypto => ({
  isEncryptionAvailable: async () => backend !== "none",
  backend: () => backend,
  encrypt: async (p) => Buffer.from(p.split("").reverse().join("") + "#enc"),
  decrypt: async (c) => ({ result: c.toString().replace(/#enc$/, "").split("").reverse().join(""), shouldReEncrypt: rotate }),
});

describe("key storage (spec 8.1)", () => {
  it("stores only ciphertext when a real keyring backend exists", async () => {
    const dir = await tempDir();
    const ks = new KeyStore(dir, fakeCrypto("gnome_libsecret"));
    expect(await ks.set("gemini", "AIzaSECRETVALUE123")).toEqual({ persistent: true });
    const raw = await readFile(join(dir, "keys.json"), "utf8");
    expect(raw).not.toContain("AIzaSECRETVALUE123");
    expect(await new KeyStore(dir, fakeCrypto("gnome_libsecret")).get("gemini")).toBe("AIzaSECRETVALUE123");
    await ks.clear("gemini");
    expect(await ks.has("gemini")).toBe(false);
    await expect(access(join(dir, "keys.json"))).rejects.toThrow();
  });

  it("re-encrypts a stored key when the keyring says it rotated", async () => {
    const dir = await tempDir();
    await new KeyStore(dir, fakeCrypto("gnome_libsecret")).set("gemini", "AQ.SECRETVALUE123456");
    const before = await readFile(join(dir, "keys.json"), "utf8");
    const ks = new KeyStore(dir, fakeCrypto("gnome_libsecret", true));
    expect(await ks.get("gemini")).toBe("AQ.SECRETVALUE123456");
    expect(await readFile(join(dir, "keys.json"), "utf8")).toBe(before); // same fake cipher, rewritten in place
  });

  it.each(["basic_text", "none"])("keeps the key in memory only when the backend is %s", async (backend) => {
    const dir = await tempDir();
    const ks = new KeyStore(dir, fakeCrypto(backend));
    expect(await ks.set("gemini", "AIzaSECRETVALUE123")).toEqual({ persistent: false });
    expect(await ks.get("gemini")).toBe("AIzaSECRETVALUE123");
    await expect(access(join(dir, "keys.json"))).rejects.toThrow();
    expect(await new KeyStore(dir, fakeCrypto(backend)).get("gemini")).toBeNull();
  });
});

describe("redaction before the provider (spec 8.3)", () => {
  const r = makeRedactor(() => ["my-live-key-123456"], "/home/malek", "malek");
  it.each([
    ["/home/malek/.local/share/PrismLauncher/x.log", "~/.local/share/PrismLauncher/x.log"],
    ["key AIzaSyA1234567890abcdefghijklmnopqrstuv0 here", "key [key] here"],
    ["sk-ant-abcdefghijklmnopqrstuvwxyz", "[key]"],
    ["new key AQ.FakeKeyForTests0000000000000000000 here", "new key [key] here"],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "Authorization: Bearer [token]"],
    ["--accessToken eyJhbGciOi.payload.sig --version 1.21", "--accessToken [token] --version 1.21"],
    ["password=hunter2", "password=[redacted]"],
    ["uses my-live-key-123456!", "uses [key]!"],
    ["nothing secret in Sodium 0.6.13", "nothing secret in Sodium 0.6.13"],
  ])("%s", (input, out) => expect(r(input)).toBe(out));
});
