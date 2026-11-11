// Provider API keys (spec 8.1). Encrypted with Electron safeStorage, whose key lives in the OS
// secret service (GNOME Keyring / KWallet); only the ciphertext is written to keys.json. If no
// real keyring backend is available, keys are kept in memory for this session only and never
// written to disk. Keys never go to logs, the renderer, journals or exports.
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { z } from "zod";
import { writeJsonAtomic } from "./store/jsonFile";

// Electron 45's async safeStorage API (the sync one is deprecated).
export interface Crypto {
  isEncryptionAvailable(): Promise<boolean>;
  backend(): string; // e.g. "gnome_libsecret", "kwallet6", "basic_text"
  encrypt(plain: string): Promise<Buffer>;
  decrypt(cipher: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

const KeysFile = z.record(z.string(), z.string()); // provider id -> base64 ciphertext

export class KeyStore {
  private session = new Map<string, string>();
  constructor(private readonly dataDir: string, private readonly crypto: Crypto) {}
  private get file() { return join(this.dataDir, "keys.json"); }

  // A real keyring, not Chromium's "basic_text" fallback (a fixed, publicly known key).
  async persistent(): Promise<boolean> {
    return (await this.crypto.isEncryptionAvailable()) && this.crypto.backend() !== "basic_text" && this.crypto.backend() !== "unknown";
  }

  private async readFileKeys(): Promise<Record<string, string>> {
    try {
      const r = KeysFile.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      return r.success ? r.data : {};
    } catch {
      return {};
    }
  }

  async set(provider: string, key: string): Promise<{ persistent: boolean }> {
    if (!(await this.persistent())) {
      this.session.set(provider, key);
      return { persistent: false };
    }
    const all = await this.readFileKeys();
    all[provider] = (await this.crypto.encrypt(key)).toString("base64");
    await writeJsonAtomic(this.file, all);
    this.session.delete(provider);
    return { persistent: true };
  }

  async get(provider: string): Promise<string | null> {
    const s = this.session.get(provider);
    if (s) return s;
    if (!(await this.persistent())) return null;
    const c = (await this.readFileKeys())[provider];
    if (!c) return null;
    try {
      const { result, shouldReEncrypt } = await this.crypto.decrypt(Buffer.from(c, "base64"));
      if (shouldReEncrypt) await this.set(provider, result); // keyring rotated its key
      return result;
    } catch {
      return null; // keyring changed or locked: treat as not set
    }
  }

  async has(provider: string): Promise<boolean> {
    return (await this.get(provider)) !== null;
  }

  async clear(provider: string): Promise<void> {
    this.session.delete(provider);
    const all = await this.readFileKeys();
    if (provider in all) {
      delete all[provider];
      if (Object.keys(all).length) await writeJsonAtomic(this.file, all);
      else await rm(this.file, { force: true });
    }
  }
}
