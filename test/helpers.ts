import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import type { Http } from "../src/main/net/http";
import type { GuardOptions } from "../src/main/net/guard";

export const tempDir = (p = "packsmith-test-") => mkdtemp(join(tmpdir(), p));

export async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(__dirname, "fixtures/modrinth", name), "utf8"));
}

export function hashes(buf: Buffer) {
  return { sha1: createHash("sha1").update(buf).digest("hex"), sha512: createHash("sha512").update(buf).digest("hex") };
}

// Fake network: routes by URL prefix, records every call (URL + options) for assertions.
export function fakeHttp(routes: { json?: Record<string, unknown | ((url: string, o?: GuardOptions) => unknown)>; files?: Record<string, Buffer | number> }) {
  const calls: Array<{ url: string; opts?: GuardOptions }> = [];
  const http: Http = {
    async json(url, opts) {
      calls.push({ url, opts });
      const key = Object.keys(routes.json ?? {}).find((k) => url.startsWith(k));
      if (!key) throw Object.assign(new Error(`no fake route for ${url}`), { code: "network" });
      const v = routes.json![key];
      return typeof v === "function" ? (v as (u: string, o?: GuardOptions) => unknown)(url, opts) : structuredClone(v);
    },
    async request(url, opts) {
      calls.push({ url, opts });
      const f = routes.files?.[url];
      if (f === undefined) throw new Error(`no fake file for ${url}`);
      if (typeof f === "number") return { status: f, headers: {}, url, body: Readable.from([]) };
      return { status: 200, headers: {}, url, body: Readable.from([f]) };
    },
  };
  return { http, calls };
}
