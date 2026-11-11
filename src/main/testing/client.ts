// Client boot test (SPEC 11.2, D-10), following headlesshq/mc-runtime-test: HeadlessMC launches
// the pack's client on a hidden Xvfb display (never the user's screen, PERF-6) with the
// mc-runtime-test mod, which creates a world, waits for the player's chunk, and quits.
// Auth (SPEC 8.9, D-30): the user's own Microsoft account, logged in once through HeadlessMC
// itself; HeadlessMC keeps the token in its folder and packsmith never reads it. No offline mode.
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, copyFile, cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Http } from "../net/http";
import type { Loader } from "@shared/schema";
import { AppError } from "../errors";
import type { BootMarks } from "./process";

// Pinned: the native Linux build needs no Java of its own (HeadlessMC's jar needs Java 25).
export const HMC_VERSION = "3.0.0-RC8";
const HMC_SHA256 = "62bbcd85344470bc1c11e08be4eda33ce06aeff2ed2931c87964640d5a733ece";
const HMC_URL = `https://github.com/headlesshq/headlessmc/releases/download/${HMC_VERSION}/headlessmc-launcher-linux-x64`;
const GITHUB_HOSTS = ["github.com", "api.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];

// mc-runtime-test's own lines: its first in-game tick (the game reached its main loop) and its
// success line (a world loaded, the player's chunk too, 100 ticks passed).
export const CLIENT_MARKS: BootMarks = {
  boots: /\b(Waiting for player to load|Screen not yet null|Waiting for overlay to disappear)\b/,
  world: /\bSuccessfully finished\.$/,
};

const Release = z.object({ assets: z.array(z.object({ name: z.string(), digest: z.string().nullable().optional(), browser_download_url: z.string(), size: z.number() })) });
const exists = (p: string) => access(p).then(() => true, () => false);
const run = promisify(execFile);

export class ClientHarness {
  constructor(private readonly dataDir: string, private readonly http: Http) {}

  get filesLocation() { return join(this.dataDir, "headlessmc"); }
  get binary() { return join(this.dataDir, "tools", "headlessmc", HMC_VERSION, "headlessmc-launcher-linux-x64"); }

  // Settings HeadlessMC gets on every call: its files in packsmith's folder, a shared game
  // cache, plain console output.
  private flags(gameDir?: string): string[] {
    return [
      "-Dhmc.jline.enabled=false", "-Dhmc.updater.enabled=false", "-Dhmc.launcher.crash-report-watcher=true",
      `-Dhmc.files.mc=${join(this.filesLocation, "minecraft")}`,
      ...(gameDir ? [`-Dhmc.files.game=${gameDir}`, "-Dhmc.files.game-for-each-version=false"] : []),
    ];
  }
  env(): NodeJS.ProcessEnv { return { ...process.env, HMC_FILES_LOCATION: this.filesLocation }; }

  hasBinary(): Promise<boolean> { return exists(this.binary); }

  async ensureBinary(): Promise<string> {
    if (await exists(this.binary)) return this.binary;
    await fetchSha256(this.http, HMC_URL, HMC_SHA256, this.binary, 200 * 1024 * 1024, "HeadlessMC");
    await chmod(this.binary, 0o755);
    return this.binary;
  }

  // The command the user runs once to log in (shown in the UI; packsmith never runs it for them).
  loginCommand(): string {
    return `HMC_FILES_LOCATION=${this.filesLocation} ${this.binary} -Dhmc.jline.enabled=false account login`;
  }

  // Is an account logged in? Reads only HeadlessMC's account list output, never the token.
  async loggedIn(): Promise<boolean> {
    if (!(await exists(this.binary))) return false;
    try {
      const { stdout } = await run(this.binary, [...this.flags(), "account", "list"], { env: this.env(), timeout: 60_000 });
      return hasAccount(stdout);
    } catch {
      return false;
    }
  }

  // The mc-runtime-test mod for this Minecraft version and loader, SHA-256 from its release.
  async testMod(mc: string, loader: Exclude<Loader, "vanilla">): Promise<string> {
    const name = `mc-runtime-test-${mc}-${loader}-latest.jar`;
    const dest = join(this.dataDir, "cache", "mc-runtime-test", name);
    if (await exists(dest)) return dest;
    const rel = Release.safeParse(await this.http.json(`https://api.github.com/repos/headlesshq/mc-runtime-test-mod/releases/tags/${encodeURIComponent(mc)}-latest`, { allowHosts: GITHUB_HOSTS, headers: { "user-agent": "packsmith", accept: "application/vnd.github+json" } }).catch(() => null));
    const asset = rel.success ? rel.data.assets.find((a) => a.name === name) : undefined;
    if (!asset?.digest?.startsWith("sha256:")) throw new AppError("no-test-mod", `There's no client test mod for ${loader} ${mc}, so the client can't be tested.`);
    await fetchSha256(this.http, asset.browser_download_url, asset.digest.slice(7), dest, asset.size + 1024, "the client test mod");
    return dest;
  }

  // The scratch game folder: the pack's client mods and configs, the test mod, quiet options.
  async prepare(gameDir: string, packGameDir: string, modRelpaths: string[], packRoot: string, testMod: string): Promise<void> {
    await mkdir(gameDir, { recursive: true });
    for (const sub of ["mods", "config", "saves", "crash-reports"]) await rm(join(gameDir, sub), { recursive: true, force: true });
    await mkdir(join(gameDir, "mods"));
    for (const rel of modRelpaths) await copyFile(join(packRoot, rel), join(gameDir, "mods", rel.split("/").pop()!));
    await copyFile(testMod, join(gameDir, "mods", testMod.split("/").pop()!));
    if (await exists(join(packGameDir, "config"))) await cp(join(packGameDir, "config"), join(gameDir, "config"), { recursive: true });
    // No sound, no first-run screens, keep running without focus.
    await writeFile(join(gameDir, "options.txt"), ["onboardAccessibility:false", "pauseOnLostFocus:false", "soundCategory_master:0.0", "renderDistance:4", "simulationDistance:5", "fullscreen:false", ""].join("\n"));
  }

  // xvfb-run gives the game its own hidden display; without it the client test is skipped.
  async xvfb(): Promise<string | null> {
    for (const p of ["/usr/bin/xvfb-run", "/usr/local/bin/xvfb-run"]) if (await exists(p)) return p;
    return null;
  }

  // The pack's exact loader build, installed once (`launch fabric 1.21.1` alone would take
  // whatever build HeadlessMC picks). Returns the arguments `launch` takes for it: the same
  // `<loader> <mc> <build>` as `version install`; installed profile names are refused by launch.
  async profile(loader: Exclude<Loader, "vanilla">, mc: string, loaderVersion: string, signal?: AbortSignal): Promise<string[]> {
    const target = [loader, mc, hmcBuild(loader, mc, loaderVersion)];
    const before = await this.versionList();
    const have = profileName(before, loader, mc, loaderVersion);
    if (have) return target;
    try {
      await run(this.binary, [...this.flags(), "version", "install", ...target], { env: this.env(), timeout: 10 * 60_000, signal, maxBuffer: 16 * 1024 * 1024 });
    } catch {
      // Judged by the list below: an install that printed errors but worked still counts.
    }
    const after = await this.versionList();
    // Found by name, else the one profile this install added.
    const added = names(after).filter((n) => !names(before).includes(n));
    const name = profileName(after, loader, mc, loaderVersion) ?? (added.length === 1 ? added[0]! : null);
    if (!name) throw new AppError("client-install", `HeadlessMC couldn't install ${loader} ${loaderVersion} for Minecraft ${mc}, so the game wasn't tested.`);
    return target;
  }

  private async versionList(): Promise<string> {
    return run(this.binary, [...this.flags(), "version", "list"], { env: this.env(), timeout: 60_000 }).then((r) => r.stdout, () => "");
  }

  launchCommand(xvfb: string, gameDir: string, profile: string[]): { command: string; args: string[] } {
    return {
      command: xvfb,
      args: ["-a", "-s", "-screen 0 1280x720x24", this.binary, ...this.flags(gameDir), "launch", "--jvm", "-Xmx3G -Djava.awt.headless=true", ...profile],
    };
  }

  async pruneLogs(dir: string): Promise<void> {
    const logs = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith("client-")).sort();
    for (const old of logs.slice(0, -5)) await rm(join(dir, old), { force: true });
  }
}

// `account list` prints a table: "name uuid type provider", then one row per account, or a
// row of dashes when there is none (seen with 3.0.0-RC8).
export function hasAccount(listing: string): boolean {
  const rows = listing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = rows.findIndex((l) => /^name\s+uuid\b/i.test(l));
  return header >= 0 && rows.slice(header + 1).some((l) => !l.startsWith("-"));
}

// `version list` prints "name parent type" and one row per installed version; Fabric's are
// named fabric-loader-<v>-<mc> (seen with 3.0.0-RC8), Forge's and NeoForge's carry their build.
const names = (listing: string) => listing.split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0] ?? "").filter((n) => n && n !== "name" && !n.startsWith("-"));

export function profileName(listing: string, loader: Exclude<Loader, "vanilla">, mc: string, loaderVersion: string): string | null {
  const all = names(listing);
  if (loader === "fabric") return all.find((n) => n === `fabric-loader-${loaderVersion}-${mc}`) ?? null;
  const word = loader === "neoforge" ? /neoforge|neoforged/i : /forge/i;
  // NeoForge's 1.20.1 builds are named like Forge's; their build number still tells them apart.
  return all.find((n) => n.includes(loaderVersion) && (word.test(n) || (loader === "neoforge" && mc === "1.20.1" && /forge/i.test(n))) && !(loader === "forge" && /neoforge/i.test(n))) ?? null;
}

// The build id HeadlessMC's `version install` takes (its `version list -r` shows them): Fabric's
// and Forge's full loader version; NeoForge's last number after the Minecraft part
// (21.1.209 on 1.21.1 is build 209), except the 1.20.1 builds named like Forge's (47.1.106).
export function hmcBuild(loader: Exclude<Loader, "vanilla">, mc: string, loaderVersion: string): string {
  if (loader !== "neoforge" || mc === "1.20.1" || !mc.startsWith("1.")) return loaderVersion;
  const [major = "", minor = "0"] = mc.slice(2).split(".");
  const prefix = `${major}.${minor}.`;
  return loaderVersion.startsWith(prefix) ? loaderVersion.slice(prefix.length) : loaderVersion;
}

async function fetchSha256(http: Http, url: string, sha256: string, dest: string, maxBytes: number, what: string): Promise<void> {
  await mkdir(join(dest, ".."), { recursive: true });
  const part = `${dest}.part`;
  await rm(part, { force: true });
  const res = await http.request(url, { allowHosts: GITHUB_HOSTS, maxBytes, timeoutMs: 10 * 60_000, headers: { "user-agent": "packsmith" } });
  if (res.status !== 200) { res.body.resume(); throw new AppError("download-failed", `Downloading ${what} failed (status ${res.status}).`); }
  const h = createHash("sha256");
  await pipeline(res.body, new Transform({ transform(c: Buffer, _e, cb) { h.update(c); cb(null, c); } }), createWriteStream(part, { flags: "wx" }));
  if (h.digest("hex") !== sha256.toLowerCase()) { await rm(part, { force: true }); throw new AppError("hash-mismatch", `${what} didn't match its published checksum, so packsmith discarded it.`); }
  await rename(part, dest);
}
