// Version limits a Fabric pack puts on one mod, read from the jars themselves (M-9).
// A boot only reports the first `breaks` it trips over, and Modrinth's metadata doesn't carry
// Fabric's version ranges, so a model fixing a conflict one boot at a time can loop: live
// 2026-11-10 it downgraded Xaero's Minimap for Xaero's Maps x Waystones (needs <26.2.0) straight
// into Xaero's World Map's limit (needs >=26.4.0). Every installed jar's fabric.mod.json says all
// of this up front: intersect the ranges and say which versions work, or that none do.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { withZip } from "../archive/zip";
import type { Diagnosis } from "./diagnose";

export interface FabricMod { id: string; name: string; version: string; depends: Record<string, unknown>; breaks: Record<string, unknown> }

export async function readFabricMods(jarPaths: string[]): Promise<FabricMod[]> {
  const out: FabricMod[] = [];
  for (const path of jarPaths) {
    const json = await withZip(path, (z) => z.text("fabric.mod.json")).catch(() => null);
    if (!json) continue;
    try {
      const m = JSON.parse(json) as Partial<Record<keyof FabricMod, unknown>>;
      if (typeof m.id !== "string") continue;
      out.push({
        id: m.id, name: typeof m.name === "string" ? m.name : m.id, version: typeof m.version === "string" ? m.version : "?",
        depends: obj(m.depends), breaks: obj(m.breaks),
      });
    } catch { /* not valid JSON: the boot log will say so */ }
  }
  return out;
}
// The enabled mods of a pack (`<root>/minecraft/mods/*.jar`; disabled ones end in .jar.disabled).
export async function packFabricMods(instanceRoot: string): Promise<FabricMod[]> {
  const dir = join(instanceRoot, "minecraft", "mods");
  const names = await readdir(dir).catch(() => [] as string[]);
  return readFabricMods(names.filter((n) => n.endsWith(".jar")).sort().map((n) => join(dir, n)));
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// ---- versions and ranges ----

// Fabric versions are semver-like ("26.2.0", "2.12.1+1.21.1-fabric"): build metadata after "+" is
// ignored, a pre-release ("-beta.1") sorts before its release.
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => { const [core = "", pre] = v.split("+")[0]!.split(/-(.*)/s); return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre }; };
  const x = split(a), y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

interface Bound { v: string; incl: boolean }
interface Interval { lo?: Bound; hi?: Bound } // missing = unbounded
type Range = Interval[]; // a union; [] = no version at all

const ALL: Range = [{}];

// One Fabric predicate string: space-separated comparators, all of which must hold. Returns null
// for forms this doesn't model (~, ^, x-wildcards): then nothing is claimed.
function parseAnd(s: string): Range | null {
  let iv: Interval = {};
  for (const part of s.trim().split(/\s+/)) {
    if (part === "*" || part === "") continue;
    const m = part.match(/^(>=|<=|>|<|=)?(\d[\w.+-]*)$/);
    if (!m || /(^|\.)[xX*](\.|$)/.test(m[2]!)) return null;
    const v = m[2]!;
    const op = m[1] ?? "=";
    const lo = op === ">=" || op === "=" ? { v, incl: true } : op === ">" ? { v, incl: false } : undefined;
    const hi = op === "<=" || op === "=" ? { v, incl: true } : op === "<" ? { v, incl: false } : undefined;
    iv = intersectInterval(iv, { lo, hi }) ?? { lo: { v, incl: false }, hi: { v, incl: false } };
  }
  return isEmpty(iv) ? [] : [iv];
}

// A predicate value: a string, or an array of strings (any one may hold).
export function parsePredicate(p: unknown): Range | null {
  const list = typeof p === "string" ? [p] : Array.isArray(p) && p.every((x) => typeof x === "string") ? (p as string[]) : null;
  if (!list) return null;
  const parts = list.map(parseAnd);
  return parts.some((r) => r === null) ? null : normalise(parts.flat() as Interval[]);
}

function isEmpty(iv: Interval): boolean {
  if (!iv.lo || !iv.hi) return false;
  const c = compareVersions(iv.lo.v, iv.hi.v);
  return c > 0 || (c === 0 && !(iv.lo.incl && iv.hi.incl));
}

function intersectInterval(a: Interval, b: Interval): Interval | null {
  const lo = !a.lo ? b.lo : !b.lo ? a.lo : pick(a.lo, b.lo, 1);
  const hi = !a.hi ? b.hi : !b.hi ? a.hi : pick(a.hi, b.hi, -1);
  const iv = { lo, hi };
  return isEmpty(iv) ? null : iv;
}
// The tighter of two bounds: the higher lower bound (dir 1) or the lower upper bound (dir -1).
function pick(x: Bound, y: Bound, dir: 1 | -1): Bound {
  const c = compareVersions(x.v, y.v) * dir;
  return c > 0 ? x : c < 0 ? y : { v: x.v, incl: x.incl && y.incl };
}

export function intersect(a: Range, b: Range): Range {
  return normalise(a.flatMap((x) => b.flatMap((y) => { const i = intersectInterval(x, y); return i ? [i] : []; })));
}

export function complement(r: Range): Range {
  let out: Range = ALL;
  for (const iv of r) {
    const not: Range = [];
    if (iv.lo) not.push({ hi: { v: iv.lo.v, incl: !iv.lo.incl } });
    if (iv.hi) not.push({ lo: { v: iv.hi.v, incl: !iv.hi.incl } });
    out = intersect(out, not);
  }
  return out;
}

const normalise = (r: Range): Range => r.filter((iv) => !isEmpty(iv));

export function rangeText(r: Range): string {
  if (!r.length) return "no version";
  return r.map((iv) => {
    if (!iv.lo && !iv.hi) return "any version";
    if (iv.lo && iv.hi && iv.lo.incl && iv.hi.incl && compareVersions(iv.lo.v, iv.hi.v) === 0) return `exactly ${iv.lo.v}`;
    const lo = iv.lo ? `${iv.lo.v}${iv.lo.incl ? " or later" : " (exclusive) or later"}` : "";
    const hi = iv.hi ? `${iv.hi.incl ? "up to" : "below"} ${iv.hi.v}` : "";
    return [lo, hi].filter(Boolean).join(" and ");
  }).join(", or ");
}

// ---- what the pack demands of one mod ----

export interface Limit { by: FabricMod; kind: "depends" | "breaks"; predicate: string; allowed: Range }
export interface Limits { target: string; targetName: string; installed?: string; limits: Limit[]; allowed: Range; complete: boolean }

export function limitsOn(mods: FabricMod[], target: string): Limits {
  const limits: Limit[] = [];
  let complete = true;
  for (const m of mods) {
    if (m.id === target) continue;
    for (const kind of ["depends", "breaks"] as const) {
      const p = m[kind][target];
      if (p === undefined) continue;
      const r = parsePredicate(p);
      if (!r) { complete = false; continue; }
      limits.push({ by: m, kind, predicate: Array.isArray(p) ? p.join(" || ") : String(p), allowed: kind === "depends" ? r : complement(r) });
    }
  }
  const self = mods.find((m) => m.id === target);
  return { target, targetName: self?.name ?? target, installed: self?.version, limits, allowed: limits.reduce((acc, l) => intersect(acc, l.allowed), ALL), complete };
}

// Adds what the pack's jars say about the conflicting mods' versions to a diagnosis (a new copy).
// Only for version conflicts, only when some installed mod limits the culprit's version.
const needsLimits = (d: Diagnosis): boolean => d.kind === "incompatible_mods" || d.kind === "version_mismatch";

// The same for a pack on disk: only Fabric packs, and only reads the jars for a version conflict.
export async function withPackLimits(d: Diagnosis, loader: string, instanceRoot: string): Promise<Diagnosis> {
  return loader === "fabric" && needsLimits(d) ? withVersionLimits(d, await packFabricMods(instanceRoot)) : d;
}

export function withVersionLimits(d: Diagnosis, mods: FabricMod[]): Diagnosis {
  if (!needsLimits(d)) return d;
  const targets = [...new Set(d.culprits.filter((c) => c.role === "conflict" || c.role === "wrong_version").map((c) => c.modId))];
  const lines: string[] = [];
  for (const t of targets) {
    if (t === "minecraft" || t === "java" || t === "fabricloader") continue;
    const l = limitsOn(mods, t);
    // One limit from one mod is what the boot log already said; add something only when the
    // limits come from two or more mods, or rule out every version.
    if (new Set(l.limits.map((x) => x.by)).size < 2 && l.allowed.length) continue;
    const byMod = new Map<FabricMod, Range>();
    for (const x of l.limits) byMod.set(x.by, intersect(byMod.get(x.by) ?? ALL, x.allowed));
    const who = [...byMod].map(([m, r]) => `${m.name} ${m.version} accepts ${rangeText(r)}`).join("; ");
    if (!l.allowed.length) {
      lines.push(`No version of ${l.targetName} works with every mod in this pack (${who}), so changing ${l.targetName}'s version can't fix this: remove one of those mods, or change the version of one of them.`);
    } else if (l.complete) {
      lines.push(`Every mod in this pack accepts ${l.targetName} ${rangeText(l.allowed)}${l.installed ? ` (installed: ${l.installed})` : ""} (${who}).`);
    }
  }
  return lines.length ? { ...d, suggested: [...lines, ...d.suggested] } : d;
}
