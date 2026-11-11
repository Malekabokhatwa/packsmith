// M-11 HTTP guard (spec 8.5): the single HTTP client for every app-originated request.
// - HTTPS only; optional host allowlist per call site
// - every resolved address is checked at connect time (no DNS-rebinding gap), and IP-literal
//   hosts are checked before connecting: loopback, private, link-local, CGNAT, multicast,
//   reserved and cloud-metadata ranges are refused
// - redirects are followed manually and each target is re-validated
// - response size cap and an overall timeout
import { request, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Readable } from "node:stream";
import { AppError } from "../errors";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96],
] as const) blocked.addSubnet(net, prefix, "ipv6");

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return blocked.check(mapped[1], "ipv4");
    return blocked.check(address, "ipv6");
  }
  return true; // not an IP at all: refuse
}

export interface GuardOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  allowHosts?: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal; // the caller's Stop: aborts the request at once, also before the answer starts
}

// One signal for a request: the caller's Stop or the time limit, whichever comes first.
// `stopped()` tells the two apart, so a Stop is never reported as "took too long".
export function requestSignal(opts: GuardOptions, defaultTimeoutMs: number): { signal: AbortSignal; stopped: () => boolean } {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? defaultTimeoutMs);
  const caller = opts.signal;
  return { signal: caller ? AbortSignal.any([timeout, caller]) : timeout, stopped: () => caller?.aborted ?? false };
}
export const stoppedError = () => new AppError("stopped", "Stopped.");

export interface GuardedResponse {
  status: number;
  headers: IncomingMessage["headers"];
  url: string;
  body: Readable;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function validateUrl(raw: string, allowHosts?: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("blocked-url", `Not a valid address: ${raw}`);
  }
  if (url.protocol !== "https:") throw new AppError("blocked-url", `Only HTTPS addresses are allowed (${url.host}).`);
  if (url.username || url.password) throw new AppError("blocked-url", "Addresses with credentials are not allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (allowHosts && !allowHosts.includes(host)) throw new AppError("blocked-url", `packsmith doesn't connect to ${host} here.`);
  if (isIP(host) && isBlockedAddress(host)) throw new AppError("blocked-url", `Refused a private or local address (${host}).`);
  if (host === "localhost" || host.endsWith(".localhost")) throw new AppError("blocked-url", "Refused a local address.");
  return url;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

export function safeLookup(hostname: string, options: { family?: number; all?: boolean; hints?: number }, cb: LookupCb): void {
  dnsLookup(hostname, { all: true, family: options.family ?? 0, hints: options.hints }, (err, addresses) => {
    if (err) return cb(err, "");
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad || addresses.length === 0) {
      const e: NodeJS.ErrnoException = new AppError("blocked-url", `Refused ${hostname}: it resolves to a private or local address.`);
      e.code = "EBLOCKED";
      return cb(e, "");
    }
    if (options.all) return cb(null, addresses);
    const first = addresses[0]!;
    return cb(null, first.address, first.family);
  });
}

function once(url: URL, opts: GuardOptions, signal: AbortSignal, stopped: () => boolean): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (stopped()) return reject(stoppedError());
    const reqOpts: RequestOptions = {
      method: opts.method ?? "GET",
      headers: opts.headers,
      lookup: safeLookup as unknown as RequestOptions["lookup"],
      signal,
    };
    const req = request(url, reqOpts, resolve);
    req.on("error", (err) => {
      if (err instanceof AppError) return reject(err);
      if (stopped()) return reject(stoppedError());
      if (signal.aborted) return reject(new AppError("network", `${url.host} took too long to answer.`, { cause: err }));
      // Some socket errors carry an empty message (seen: "Couldn't reach cdn.modrinth.com:"); use the code then.
      const why = (err as Error).message || (err as NodeJS.ErrnoException).code || "no answer";
      reject(new AppError("network", `Couldn't reach ${url.host}: ${why}.`, { cause: err }));
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

// Size-capped passthrough: errors the stream once more than maxBytes have flowed through.
function capped(src: IncomingMessage, maxBytes: number, host: string): Readable {
  let seen = 0;
  const declared = Number(src.headers["content-length"] ?? "0");
  if (declared > maxBytes) {
    src.destroy();
    throw new AppError("too-large", `${host} sent a response larger than the ${Math.round(maxBytes / 1048576)} MB limit.`);
  }
  return Readable.from(
    (async function* () {
      for await (const chunk of src) {
        seen += (chunk as Buffer).length;
        if (seen > maxBytes) {
          src.destroy();
          throw new AppError("too-large", `${host} sent more than the ${Math.round(maxBytes / 1048576)} MB limit.`);
        }
        yield chunk as Buffer;
      }
    })(),
  );
}

export async function guardedRequest(rawUrl: string, opts: GuardOptions = {}): Promise<GuardedResponse> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const { signal, stopped } = requestSignal(opts, 30_000);
  let url = validateUrl(rawUrl, opts.allowHosts);
  for (let hop = 0; ; hop++) {
    const res = await once(url, opts, signal, stopped);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw new AppError("network", `Too many redirects from ${url.host}.`);
      url = validateUrl(new URL(res.headers.location, url).toString(), opts.allowHosts);
      continue;
    }
    return { status, headers: res.headers, url: url.toString(), body: capped(res, opts.maxBytes ?? DEFAULT_MAX_BYTES, url.host) };
  }
}

export async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function guardedJson(rawUrl: string, opts: GuardOptions = {}): Promise<unknown> {
  const res = await guardedRequest(rawUrl, { ...opts, headers: { accept: "application/json", ...opts.headers } });
  let buf: Buffer;
  try {
    buf = await readAll(res.body);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("network", `Lost the connection to ${new URL(res.url).host}: ${(err as Error).message}`, { cause: err });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new AppError(res.status === 404 ? "not-found" : "http", `${new URL(res.url).host} answered ${res.status}.`, { cause: buf.toString("utf8").slice(0, 500) });
  }
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (err) {
    throw new AppError("http", `${new URL(res.url).host} sent a response packsmith couldn't read.`, { cause: err });
  }
}
