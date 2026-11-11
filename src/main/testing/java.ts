// Finds a Java runtime for a Minecraft version (Mojang's version JSON names the major version:
// 1.21 needs 21). packsmith bundles no Java (architecture "runtime"): it uses Prism's runtimes or
// the system's, read from each runtime's `release` file. Never downloads one.
import { readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface JavaRuntime { path: string; major: number; version: string }

export async function javaHomes(prismRoot: string | null): Promise<string[]> {
  const parents = [...(prismRoot ? [join(prismRoot, "java")] : []), join(homedir(), ".local/share/PrismLauncher/java"), "/usr/lib/jvm"];
  const out: string[] = [];
  for (const p of parents) for (const n of await readdir(p).catch(() => [] as string[])) out.push(join(p, n));
  return [...new Set(out)];
}

export async function readRuntime(home: string): Promise<JavaRuntime | null> {
  const release = await readFile(join(home, "release"), "utf8").catch(() => null);
  const m = release?.match(/^JAVA_VERSION="([^"]+)"/m);
  if (!m) return null;
  const path = join(home, "bin", "java");
  if (!(await access(path).then(() => true, () => false))) return null;
  const v = m[1]!;
  const major = Number(v.startsWith("1.") ? v.split(".")[1] : v.split(/[.+-]/)[0]);
  return Number.isFinite(major) ? { path, major, version: v } : null;
}

// The runtime whose major version is the one Minecraft asks for; else the closest newer one
// (Minecraft runs on newer Java within limits, but an exact match is what the launchers use).
export async function findJava(major: number, homes: string[]): Promise<JavaRuntime | null> {
  const found = (await Promise.all(homes.map(readRuntime))).filter((r): r is JavaRuntime => r !== null);
  return found.find((r) => r.major === major) ?? found.filter((r) => r.major > major).sort((a, b) => a.major - b.major)[0] ?? null;
}
