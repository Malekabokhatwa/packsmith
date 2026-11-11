// M-8 test runner: proves a pack packsmith made, rung by rung (SPEC 11.2, 11.3).
// Rung 1 (Resolved): the resolver finds every required library already in the pack.
// Server branch: a dedicated server built from the pack's server-side content, booted in a scratch
// folder packsmith owns (<data>/testing/<id>/server, never inside the pack), following
// headlesshq/mc-server-test: start, watch the log for "Starting minecraft server" (Boots) and
// "Done (" (Loads a world), then stop. Needs the user's EULA acceptance (SPEC 8.8).
// Fabric servers start through Fabric's server launcher; Forge and NeoForge through their own
// installer's `--installServer` (forge.ts).
// Client branch: HeadlessMC with the user's own login on a hidden Xvfb screen (client.ts).
import { createServer } from "node:net";
import { access, copyFile, cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { z } from "zod";
import type { BranchReport, InstanceRecord, TestReport } from "@shared/schema";
import { TestReport as TestReportSchema } from "@shared/schema";
import type { Http } from "../net/http";
import type { Packs } from "../instances/manager";
import type { ModrinthClient } from "../sources/modrinth";
import type { SettingsStore } from "../settings";
import { checkInstalled } from "../resolver/fetch";
import { defaultLocations, serverJar, versionInfo } from "../mojang";
import { latestLoaderVersion } from "../loaders";
import { findJava, javaHomes } from "./java";
import { runBoot, SERVER_MARKS, type BootResult } from "./process";
import { ClientHarness, CLIENT_MARKS } from "./client";
import { forgeInstaller, installServer, serverArgs } from "./forge";
import { diagnose } from "../crash/diagnose";
import { withPackLimits } from "../crash/limits";
import { readJson, writeJsonAtomic } from "../store/jsonFile";
import { AppError } from "../errors";

export interface TesterDeps {
  dataDir: string;
  http: Http;
  packs: Packs;
  modrinth: ModrinthClient;
  settings: SettingsStore;
  prismRoot: () => Promise<string | null>;
  javaHomes?: () => Promise<string[]>;           // tests
  bootCommand?: (java: string, jar: string) => { command: string; args: string[] }; // tests
  client?: ClientHarness;                         // tests
  now?: () => Date;
}

export interface TestOptions { signal?: AbortSignal; onPhase?: (text: string) => void }

const FABRIC_META = "meta.fabricmc.net";
const NETWORK_ERROR = /\b(SocketTimeoutException|UnknownHostException|ConnectException|NoRouteToHostException|SSLHandshakeException)\b/;
const InstallerList = z.array(z.object({ version: z.string(), stable: z.boolean() }));

export class Tester {
  constructor(private readonly d: TesterDeps) {}

  private dir(id: string) { return join(this.d.dataDir, "testing", id); }

  async last(id: string): Promise<TestReport | null> {
    return readJson(join(this.dir(id), "report.json"), TestReportSchema.nullable(), null);
  }

  // The step each running test is on (pack id -> text), for the UI while it waits.
  private running = new Map<string, string>();

  progress(id: string): string | null { return this.running.get(id) ?? null; }

  // One test per pack at a time: they share the scratch server folder.
  async test(id: string, opts: TestOptions = {}): Promise<TestReport> {
    if (this.running.has(id)) throw new AppError("busy", "A boot test of this pack is already running.");
    this.running.set(id, "starting");
    const onPhase = (text: string) => { this.running.set(id, text); opts.onPhase?.(text); };
    try { return await this.testOnce(id, { ...opts, onPhase }); } finally { this.running.delete(id); }
  }

  private async testOnce(id: string, opts: TestOptions): Promise<TestReport> {
    const r = (await this.d.packs.list()).find((x) => x.id === id);
    if (!r) throw new AppError("unknown-pack", `No pack with id "${id}".`);
    // Own and adopted packs: a test only copies their files into packsmith's scratch folder.
    if (r.origin !== "own" && r.origin !== "adopted") throw new AppError("not-own", `"${r.name}" isn't a pack packsmith made or manages.`);
    const settings = await this.d.settings.get();
    if (!settings.eulaAcceptedAt) {
      throw new AppError("eula-needed", "Boot tests run a Minecraft server, which needs Mojang's EULA. The user has to accept it once in Settings; packsmith never accepts it for them.");
    }

    opts.onPhase?.("checking libraries");
    const content = await this.d.packs.scan(id);
    const mods = content.filter((c) => c.kind === "mod" && c.enabled);
    const resolved = await this.resolved(r, mods);

    opts.onPhase?.("booting a server");
    const server = await this.server(r, mods, resolved.ok, opts);
    // The client only when the server didn't already fail: a pack that can't boot a server
    // rarely boots a client, and the client test is the slow one.
    const client = server.status === "failed"
      ? { branch: "client" as const, status: "not-tested" as const, reached: resolved.ok ? 1 : 0, proof: [], tail: [], note: "Skipped: the server test failed first." }
      : (opts.onPhase?.("booting the game on a hidden screen"), await this.client(r, mods, resolved.ok, opts));
    // A version conflict: say what every jar in the pack allows, so a repair doesn't trade one
    // conflict for the next (crash/limits.ts).
    for (const b of [server, client]) if (b.diagnosis) b.diagnosis = await withPackLimits(b.diagnosis, r.loader, r.path);
    const report: TestReport = { instanceId: id, at: (this.d.now?.() ?? new Date()).toISOString(), resolved, branches: [server, client] };
    await writeJsonAtomic(join(this.dir(id), "report.json"), TestReportSchema.parse(report));
    return report;
  }

  // Rung 1: every enabled mod's required libraries are in the pack (by Modrinth metadata).
  private async resolved(r: InstanceRecord, mods: Awaited<ReturnType<Packs["scan"]>>): Promise<TestReport["resolved"]> {
    if (r.loader === "vanilla") return { ok: true, note: "No mod loader: nothing to resolve." };
    const matched = mods.flatMap((c) => (c.match.status === "modrinth" ? [{ projectId: c.match.projectId, versionId: c.match.versionId }] : []));
    const unmatched = mods.length - matched.length;
    if (!matched.length) return { ok: true, note: unmatched ? `${unmatched} file${unmatched === 1 ? "" : "s"} not on Modrinth, not checked.` : "No mods." };
    const check = await checkInstalled(this.d.modrinth, matched);
    const extra = unmatched ? ` ${unmatched} file${unmatched === 1 ? "" : "s"} not on Modrinth, not checked.` : "";
    const problems = [
      ...check.missing.map((m) => `${check.title(m.projectId)} is missing (needed by ${m.neededBy.map(check.title).join(", ")}).`),
      ...check.incompatible.map(([a, b]) => `${check.title(a)} can't run with ${check.title(b)}.`),
    ];
    if (problems.length) return { ok: false, note: `${problems.join(" ")}${extra}` };
    return { ok: true, note: `${matched.length} mod${matched.length === 1 ? "" : "s"}, every required library present.${extra}` };
  }

  private async server(r: InstanceRecord, mods: Awaited<ReturnType<Packs["scan"]>>, resolvedOk: boolean, opts: TestOptions): Promise<BranchReport> {
    const base = { branch: "server" as const, proof: [], tail: [] };
    const rung1 = resolvedOk ? 1 : 0;
    const serverMods = mods.filter((c) => c.match.status !== "modrinth" || c.match.serverSide !== "unsupported");
    if (r.loader === "vanilla") return { ...base, status: "n/a", reached: rung1, note: "No mods: shaders and resource packs are client-side." };
    if (mods.length > 0 && serverMods.length === 0) return { ...base, status: "n/a", reached: rung1, note: "Client-only pack: no mod runs on a server." };
    const info = await versionInfo(this.d.http, r.mcVersion);
    const major = info.javaVersion?.majorVersion ?? 21;
    const java = await findJava(major, await (this.d.javaHomes?.() ?? javaHomes(await this.d.prismRoot())));
    if (!java) return { ...base, status: "not-tested", reached: rung1, note: `No Java ${major} on this computer. Prism can install one (Settings > Java), or install OpenJDK ${major}.` };

    const dir = join(this.dir(r.id), "server");
    const stamp = (this.d.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    let cmd: { command: string; args: string[] };
    if (r.loader === "fabric") {
      const launcher = await this.fabricLauncher(r);
      const loc = defaultLocations(this.d.dataDir, await this.d.prismRoot());
      const jar = await serverJar(this.d.http, r.mcVersion, loc, info);
      await this.prepare(r, dir, serverMods.map((c) => c.relpath), jar);
      cmd = this.d.bootCommand?.(java.path, launcher) ?? { command: java.path, args: ["-Xms512M", "-Xmx2G", "-jar", launcher, "nogui"] };
    } else {
      const name = r.loader === "neoforge" ? "NeoForge" : "Forge";
      const version = r.loaderVersion ?? (await latestLoaderVersion(this.d.http, r.loader, r.mcVersion));
      if (!version) throw new AppError("no-loader", `${name} has no build for Minecraft ${r.mcVersion}.`);
      const installer = await forgeInstaller(this.d.http, join(this.d.dataDir, "cache"), r.loader, r.mcVersion, version);
      opts.onPhase?.(`installing the ${name} server (first test only)`);
      this.assertTestDir(dir);
      const installed = await installServer(java.path, installer, dir, join(this.dir(r.id), "logs", `install-${stamp}.log`), opts.signal);
      if (!installed.ok) {
        // The installer failing says nothing about the pack: not tested, with its own output.
        return { ...base, status: "not-tested", reached: rung1, tail: installed.tail, note: `${name}'s server installer failed, so the server wasn't tested.` };
      }
      await this.prepare(r, dir, serverMods.map((c) => c.relpath), null);
      opts.onPhase?.("booting a server");
      cmd = { command: java.path, args: ["-Xms512M", "-Xmx2G", ...(await serverArgs(dir, r.loader, r.mcVersion, version))] };
    }
    const boot = await runBoot({
      ...cmd, cwd: dir, logPath: join(this.dir(r.id), "logs", `server-${stamp}.log`),
      timeoutMs: 5 * 60_000, marks: SERVER_MARKS, stopInput: "stop\n", signal: opts.signal,
    });
    await this.pruneLogs(r.id);
    return branchFrom("server", boot, rung1);
  }

  private async client(r: InstanceRecord, mods: Awaited<ReturnType<Packs["scan"]>>, resolvedOk: boolean, opts: TestOptions): Promise<BranchReport> {
    const rung1 = resolvedOk ? 1 : 0;
    const notTested = (note: string): BranchReport => ({ branch: "client", status: "not-tested", reached: rung1, proof: [], tail: [], note });
    if (r.loader === "vanilla") return notTested("The client test needs a mod loader; this pack has none.");
    const h = this.d.client ?? new ClientHarness(this.d.dataDir, this.d.http);
    const xvfb = await h.xvfb();
    if (!xvfb) return notTested("Xvfb isn't installed, and packsmith never tests on your own screen.");
    // loggedIn() is false without HeadlessMC: it's fetched when the user logs in, not here.
    if (!(await h.loggedIn())) return notTested("Log in once with your Minecraft account (Settings > Boot tests) to test the game itself.");
    const testMod = await h.testMod(r.mcVersion, r.loader).catch((e: unknown) => (e instanceof AppError ? e : Promise.reject(e)));
    if (testMod instanceof AppError) return notTested(testMod.message);
    const gameDir = join(this.dir(r.id), "client");
    const clientMods = mods.filter((c) => c.match.status !== "modrinth" || c.match.clientSide !== "unsupported").map((c) => c.relpath);
    await h.prepare(gameDir, join(r.path, "minecraft"), clientMods, r.path, testMod);
    const stamp = (this.d.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const loaderVersion = r.loaderVersion ?? (await latestLoaderVersion(this.d.http, r.loader, r.mcVersion));
    if (!loaderVersion) return notTested(`No ${r.loader} build is known for Minecraft ${r.mcVersion}.`);
    const profile = await h.profile(r.loader, r.mcVersion, loaderVersion, opts.signal).catch((e: unknown) => (e instanceof AppError ? e : Promise.reject(e)));
    if (profile instanceof AppError) return notTested(profile.message);
    const boot = await runBoot({
      ...h.launchCommand(xvfb, gameDir, profile), cwd: gameDir, env: h.env(),
      logPath: join(this.dir(r.id), "logs", `client-${stamp}.log`),
      timeoutMs: 15 * 60_000, marks: CLIENT_MARKS, signal: opts.signal, graceMs: 20_000,
    });
    await h.pruneLogs(join(this.dir(r.id), "logs"));
    // A client that crashed writes a crash report: diagnose it together with the log.
    const crashes = (await readdir(join(gameDir, "crash-reports")).catch(() => [] as string[])).sort();
    if (crashes.length && boot.reached !== "world") boot.log += `\n${await readFile(join(gameDir, "crash-reports", crashes.at(-1)!), "utf8").catch(() => "")}`;
    return branchFrom("client", boot, rung1);
  }

  // The scratch server: the pack's server-side mods and configs, a fresh world each run.
  private assertTestDir(dir: string): void {
    const inside = relative(join(this.d.dataDir, "testing"), dir);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new AppError("bad-path", "Refused to prepare a test server outside packsmith's testing folder.");
  }

  // `jar` is Mojang's server jar for Fabric's launcher; Forge and NeoForge installed their own.
  private async prepare(r: InstanceRecord, dir: string, modRelpaths: string[], jar: string | null): Promise<void> {
    this.assertTestDir(dir);
    await mkdir(dir, { recursive: true });
    for (const sub of ["mods", "config", "world"]) await rm(join(dir, sub), { recursive: true, force: true });
    await mkdir(join(dir, "mods"));
    for (const rel of modRelpaths) await copyFile(join(r.path, rel), join(dir, "mods", rel.split("/").pop()!));
    const config = join(r.path, "minecraft", "config");
    if (await access(config).then(() => true, () => false)) await cp(config, join(dir, "config"), { recursive: true });
    await writeFile(join(dir, "eula.txt"), "# Accepted by the user in packsmith's Settings (SPEC 8.8).\neula=true\n");
    if (jar) await writeFile(join(dir, "fabric-server-launcher.properties"), `serverJar=${jar}\n`);
    const port = await freePort();
    await writeFile(join(dir, "server.properties"), [
      "server-ip=127.0.0.1", `server-port=${port}`, "view-distance=4", "simulation-distance=4",
      "spawn-protection=0", "level-name=world", "enable-query=false", "enable-rcon=false", "sync-chunk-writes=false", "",
    ].join("\n"));
  }

  private async fabricLauncher(r: InstanceRecord): Promise<string> {
    const loaderVersion = r.loaderVersion ?? (await latestLoaderVersion(this.d.http, "fabric", r.mcVersion));
    if (!loaderVersion) throw new AppError("no-loader", `Fabric has no loader for Minecraft ${r.mcVersion}.`);
    const list = InstallerList.safeParse(await this.d.http.json(`https://${FABRIC_META}/v2/versions/installer`, { allowHosts: [FABRIC_META] }));
    if (!list.success) throw new AppError("fabric-format", "Fabric's version service sent something packsmith doesn't understand.");
    const installer = (list.data.find((i) => i.stable) ?? list.data[0])?.version;
    if (!installer) throw new AppError("fabric-format", "Fabric lists no server launcher.");
    const dest = join(this.d.dataDir, "cache", "fabric", `server-${r.mcVersion}-${loaderVersion}-${installer}.jar`);
    if (await access(dest).then(() => true, () => false)) return dest;
    await mkdir(join(dest, ".."), { recursive: true });
    // Fabric publishes no checksum for this jar; it comes over HTTPS from Fabric's own service
    // through the guard, and must at least be a jar.
    const url = `https://${FABRIC_META}/v2/versions/loader/${encodeURIComponent(r.mcVersion)}/${encodeURIComponent(loaderVersion)}/${encodeURIComponent(installer)}/server/jar`;
    const res = await this.d.http.request(url, { allowHosts: [FABRIC_META], maxBytes: 8 * 1024 * 1024 });
    const chunks: Buffer[] = [];
    for await (const c of res.body) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    if (res.status !== 200 || body.subarray(0, 2).toString("latin1") !== "PK") throw new AppError("download-failed", `Fabric's server launcher didn't download (status ${res.status}).`);
    await writeFile(`${dest}.part`, body);
    await rm(dest, { force: true });
    await rename(`${dest}.part`, dest);
    return dest;
  }

  private async pruneLogs(id: string): Promise<void> {
    const dir = join(this.dir(id), "logs");
    // The newest five of each kind (names sort by time within a kind; client logs are the
    // client harness's to prune).
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const kind of ["server-", "install-"]) {
      const logs = names.filter((n) => n.startsWith(kind) && n.endsWith(".log")).sort();
      for (const old of logs.slice(0, -5)) await rm(join(dir, old), { force: true });
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => res(typeof a === "object" && a ? a.port : 25565)); });
  });
}

// What one boot proved, as a ladder branch (pure; SPEC 11.3).
export function branchFrom(branch: "server" | "client", boot: BootResult, rung1: number): BranchReport {
  const common = { branch, logPath: boot.logPath, durationMs: boot.durationMs };
  const what = branch === "server" ? "server" : "game";
  if (boot.stopped) return { ...common, status: "not-tested", reached: rung1, proof: [], tail: [], note: "Stopped before the test finished." };
  // The ladder climbs from the bottom: without rung 1 nothing above it counts as proven, even
  // if the server came up (the log lines are still shown).
  if (boot.reached === "world" && rung1) {
    return { ...common, status: "proven", reached: 3, proof: boot.proof, tail: [], note: `The ${what} started and loaded a world in ${Math.round(boot.durationMs / 1000)} s.` };
  }
  if (boot.reached === "world") {
    return { ...common, status: "failed", reached: 0, failedAt: 1, proof: boot.proof, tail: [], note: `The ${what} loaded a world, but a required library is missing by Modrinth's data.` };
  }
  // A download that failed before the game started (Fabric's launcher fetching its libraries,
  // seen live) says nothing about the pack: not tested, never a failed rung (11.3).
  const diagnosis = diagnose(boot.log);
  if (boot.reached === "none" && !boot.timedOut && diagnosis.kind === "unknown" && NETWORK_ERROR.test(boot.log)) {
    return { ...common, status: "not-tested", reached: rung1, proof: [], tail: boot.tail.slice(-20), note: `A download failed while the ${what} was starting (network), so the pack wasn't tested. Try again.` };
  }
  const failedAt = boot.reached === "boots" ? 3 : 2;
  const why = boot.timedOut ? `The ${what} didn't finish loading in time.` : failedAt === 3 ? `The ${what} started but stopped before the world loaded.` : `The ${what} stopped before it started.`;
  return {
    ...common, status: "failed", reached: rung1 ? failedAt - 1 : 0, failedAt, proof: boot.proof, tail: boot.tail.slice(-20),
    note: why, diagnosis,
  };
}
