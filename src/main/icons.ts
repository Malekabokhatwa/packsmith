// Project icons reach the renderer through the HTTP guard too (spec 8.5: all app-originated
// HTTP goes through one destination-checked client). The renderer asks for
// psicon://icon/?u=<cdn url>; main fetches it from cdn.modrinth.com only, caps it at 2 MB,
// and caches it in memory. CSP allows no other remote images.
import { protocol } from "electron";
import { guardedRequest, readAll } from "./net/guard";
import { MODRINTH_CDN_HOSTS, USER_AGENT } from "./sources/modrinth";
import { AppError } from "./errors";

export const ICON_SCHEME = "psicon";
const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif|svg\+xml)$/;

export function registerIconScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: ICON_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } }]);
}

export function handleIcons(): void {
  const cache = new Map<string, { type: string; body: Buffer }>();
  protocol.handle(ICON_SCHEME, async (req) => {
    const target = new URL(req.url).searchParams.get("u") ?? "";
    const hit = cache.get(target);
    if (hit) return new Response(new Uint8Array(hit.body), { headers: { "content-type": hit.type } });
    const fetchIcon = async () => {
      const res = await guardedRequest(target, { allowHosts: MODRINTH_CDN_HOSTS, maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000, headers: { "user-agent": USER_AGENT } });
      return { res, body: await readAll(res.body) };
    };
    try {
      // One retry for a dropped connection; refusals (bad host, too large) are not retried.
      const { res, body } = await fetchIcon().catch((err: unknown) => {
        if (err instanceof AppError && err.code !== "network") throw err;
        return fetchIcon();
      });
      const type = String(res.headers["content-type"] ?? "").split(";")[0]!.trim();
      if (res.status !== 200 || !IMAGE_TYPES.test(type)) {
        console.warn(`[icons] refused ${target}: status ${res.status}, type ${JSON.stringify(type)}`);
        return new Response(null, { status: 404 });
      }
      // SVG could carry script; it is served as an image (never a document), and img tags don't run it.
      if (cache.size > 500) cache.clear();
      cache.set(target, { type, body });
      return new Response(new Uint8Array(body), { headers: { "content-type": type } });
    } catch (err) {
      console.warn(`[icons] failed ${JSON.stringify(target)}: ${(err as Error).message}`);
      return new Response(null, { status: 404 });
    }
  });
}
