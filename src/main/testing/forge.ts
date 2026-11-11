// Forge and NeoForge test servers (M-8, SPEC 11.2): the loader's own installer, checked against
// the SHA-256 (else SHA-1) its maven publishes next to it, run once with `--installServer` in
// packsmith's scratch server folder. The installer fetches Mojang's server jar and the loader's
// libraries itself. Later boots reuse the install while the loader version stays the same.
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Http } from "../net/http";
import { AppError } from "../errors";
import { runBoot, type BootMarks } from "./process";

export type ForgeLoader = "forge" | "neoforge";

const HOSTS = { forge: ["maven.minecraftforge.net"], neoforge: ["maven.neoforged.net"] } as const;
const NAME = { forge: "Forge", neoforge: "NeoForge" } as const;
const exists = (p: string) => access(p).then(() => true, () => false);

// The maven artifact of a loader build. NeoForge's 1.20.1 builds (47.1.x) were still
// published under the old Forge name.
export function installerArtifact(loader: ForgeLoader, mc: string, version: string): { url: string; group: string; full: string } {
  if (loader === "forge") {
    const full = `${mc}-${version}`;
    return { url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`, group: "net/minecraftforge/forge", full };
  }
  if (mc === "1.20.1") {
    const full = `1.20.1-${version}`;
    return { url: `https://maven.neoforged.net/releases/net/neoforged/forge/${full}/forge-${full}-installer.jar`, group: "net/neoforged/forge", full };
  }
  return { url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`, group: "net/neoforged/neoforge", full: version };
}

// The installer jar, cached in <data>/cache/<loader>/ once its checksum matched.
export async function forgeInstaller(http: Http, cacheDir: string, loader: ForgeLoader, mc: string, version: string): Promise<string> {
  const { url } = installerArtifact(loader, mc, version);
  const dest = join(cacheDir, loader, url.split("/").pop()!);
  if (await exists(dest)) return dest;
  const allowHosts = HOSTS[loader];
  const sum = await checksum(http, url, allowHosts);
  if (!sum) throw new AppError("no-checksum", `${NAME[loader]} publishes no checksum for its ${version} installer, so packsmith won't run it.`);
  const res = await http.request(url, { allowHosts, maxBytes: 64 * 1024 * 1024, timeoutMs: 5 * 60_000 });
  const chunks: Buffer[] = [];
  for await (const c of res.body) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  if (res.status !== 200) throw new AppError("download-failed", `${NAME[loader]}'s installer didn't download (status ${res.status}).`);
  if (createHash(sum.algo).update(body).digest("hex") !== sum.hex) {
    throw new AppError("hash-mismatch", `${NAME[loader]}'s installer didn't match its published checksum, so packsmith discarded it.`);
  }
  await mkdir(join(dest, ".."), { recursive: true });
  await writeFile(`${dest}.part`, body);
  await rename(`${dest}.part`, dest);
  return dest;
}

async function checksum(http: Http, url: string, allowHosts: readonly string[]): Promise<{ algo: "sha256" | "sha1"; hex: string } | null> {
  for (const algo of ["sha256", "sha1"] as const) {
    const res = await http.request(`${url}.${algo}`, { allowHosts, maxBytes: 1024 }).catch(() => null);
    if (!res) continue;
    const chunks: Buffer[] = [];
    for await (const c of res.body) chunks.push(c as Buffer);
    const hex = Buffer.concat(chunks).toString("utf8").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (res.status === 200 && new RegExp(`^[0-9a-f]{${algo === "sha256" ? 64 : 40}}$`).test(hex)) return { algo, hex };
  }
  return null;
}

const INSTALLED = ".packsmith-installed";
const INSTALL_DONE: BootMarks = { boots: /^(?!)/, world: /^(?!)/ };

// Runs the installer in `dir` unless this exact build is already installed there.
export async function installServer(java: string, installer: string, dir: string, logPath: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; tail: string[]; log: string }> {
  const stamp = installer.split("/").pop()!;
  if ((await readFile(join(dir, INSTALLED), "utf8").catch(() => "")) === stamp) return { ok: true };
  await rm(join(dir, INSTALLED), { force: true });
  await mkdir(dir, { recursive: true });
  const run = await runBoot({ command: java, args: ["-jar", installer, "--installServer", "."], cwd: dir, logPath, timeoutMs: 10 * 60_000, marks: INSTALL_DONE, signal });
  if (run.exitCode !== 0 || run.stopped || run.timedOut) return { ok: false, tail: run.tail.slice(-20), log: run.log };
  await writeFile(join(dir, INSTALLED), stamp);
  return { ok: true };
}

// How to start an installed server: 1.17+ installers write `unix_args.txt` (used as a Java @file);
// older ones leave a runnable `forge-<mc>-<v>.jar`.
export async function serverArgs(dir: string, loader: ForgeLoader, mc: string, version: string): Promise<string[]> {
  const { group, full } = installerArtifact(loader, mc, version);
  const argsFile = `libraries/${group}/${full}/unix_args.txt`;
  if (await exists(join(dir, argsFile))) {
    const jvm = (await exists(join(dir, "user_jvm_args.txt"))) ? ["@user_jvm_args.txt"] : [];
    return [...jvm, `@${argsFile}`, "nogui"];
  }
  const jar = (await readdir(dir)).find((n) => n.endsWith(".jar") && n.includes(full) && !n.includes("installer"));
  if (!jar) throw new AppError("install-incomplete", `${NAME[loader]}'s installer finished but left no way to start the server.`);
  return ["-jar", jar, "nogui"];
}
