// The ONE exception to the HTTP guard (SPEC 8.5): a local model server (Ollama, LM Studio) at an
// endpoint the user typed in Settings. Never guessed: packsmith only shows an example. Plain HTTP
// is allowed for exactly that origin and path, only on loopback or private LAN addresses (never
// link-local or cloud metadata), no redirects, with the same size and time caps. Everything else
// still goes through guard.ts.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { AppError } from "../errors";
import type { Http } from "./http";
import { requestSignal, stoppedError, type GuardOptions, type GuardedResponse } from "./guard";

const allowed = new BlockList(); // used as an allow list here
allowed.addSubnet("127.0.0.0", 8, "ipv4");
allowed.addSubnet("10.0.0.0", 8, "ipv4");
allowed.addSubnet("172.16.0.0", 12, "ipv4");
allowed.addSubnet("192.168.0.0", 16, "ipv4");
allowed.addAddress("::1", "ipv6");
allowed.addSubnet("fc00::", 7, "ipv6"); // unique local (LAN)

// Checks what the user typed: an http(s) URL on loopback or the LAN, given as an IP or localhost.
export function parseLocalEndpoint(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new AppError("bad-endpoint", "That isn't a valid address. Example: http://127.0.0.1:11434/v1"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new AppError("bad-endpoint", "Use an http:// or https:// address.");
  if (url.username || url.password || url.search || url.hash) throw new AppError("bad-endpoint", "Give just the address, without a login, ? or #.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = host === "localhost" || (isIP(host) === 4 && allowed.check(host, "ipv4")) || (isIP(host) === 6 && allowed.check(host, "ipv6"));
  if (!local) throw new AppError("bad-endpoint", "A local model must run on this computer or your home network (an address like 127.0.0.1 or 192.168.x.x).");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

// An Http that reaches only the configured endpoint. localhost is pinned to 127.0.0.1, so DNS
// can't send it anywhere else.
export function localEndpointHttp(endpoint: URL): Http {
  const base = `${endpoint.origin}${endpoint.pathname}`;
  const request = (raw: string, opts: GuardOptions = {}): Promise<GuardedResponse> => {
    if (raw !== base && !raw.startsWith(`${base}/`)) return Promise.reject(new AppError("blocked-url", "packsmith only talks to the local model address set in Settings."));
    const url = new URL(raw);
    const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    const { signal, stopped } = requestSignal(opts, 120_000);
    if (stopped()) return Promise.reject(stoppedError());
    const hostname = url.hostname === "localhost" ? "127.0.0.1" : url.hostname.replace(/^\[|\]$/g, "");
    return new Promise((resolve, reject) => {
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)({
        protocol: url.protocol, hostname, port: url.port, path: `${url.pathname}${url.search}`, method: opts.method ?? "GET", headers: opts.headers, signal,
      }, (res: IncomingMessage) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return reject(new AppError("blocked-url", "The local model server tried to redirect; packsmith doesn't follow that.")); }
        let seen = 0;
        const body = Readable.from((async function* () {
          for await (const chunk of res) {
            seen += (chunk as Buffer).length;
            if (seen > maxBytes) { res.destroy(); throw new AppError("too-large", "The local model server sent more than packsmith accepts."); }
            yield chunk as Buffer;
          }
        })());
        resolve({ status: res.statusCode ?? 0, headers: res.headers, url: raw, body });
      });
      req.on("error", (err) => reject(stopped() ? stoppedError() : signal.aborted
        ? new AppError("network", "The local model took too long to answer.", { cause: err })
        : new AppError("network", `Couldn't reach the local model at ${endpoint.host}: is it running? (${(err as Error).message})`, { cause: err })));
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  };
  return {
    request,
    json: async (raw, opts) => {
      const res = await request(raw, opts);
      const chunks: Buffer[] = [];
      for await (const c of res.body) chunks.push(c as Buffer);
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    },
  };
}
