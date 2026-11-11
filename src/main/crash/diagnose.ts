// M-9 crash diagnosis, deterministic first (architecture F07): turn a boot log or crash report into
// a Diagnosis the agent can act on. Each signature reads lines the loaders and the JVM really
// print (fixtures in test/fixtures/crash/); nothing matched means kind "unknown" with the log's
// error lines as evidence, never a guess. Pure: no files, no network.
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { Diagnosis as DiagnosisSchema } from "@shared/schema";

export type Diagnosis = z.output<typeof DiagnosisSchema>;
type Culprit = Diagnosis["culprits"][number];
type Kind = Diagnosis["kind"];

interface Hit { kind: Kind; line: number; culprits: Culprit[]; suggested?: string }

const culprit = (modId: string, role: Culprit["role"], extra: Partial<Culprit> = {}): Culprit => ({ modId, role, neededBy: [], ...extra });

// One rule per signature: a line pattern and what it means. Order = priority when several match.
const RULES: Array<{ kind: Kind; re: RegExp; read: (m: RegExpMatchArray) => { culprits: Culprit[]; suggested?: string } }> = [
  // Fabric: "Mod 'Waystones' (waystones) 21.1.46 requires any version of fabric-api, which is missing!"
  { kind: "missing_dependency", re: /Mod '(.+?)' \(([\w.-]+)\) \S+ requires (?:any version|version (\S+)) of (?:mod )?'?([\w. -]+?)'?(?: \(([\w.-]+)\))?, which is missing!/,
    read: (m) => { const id = m[5] ?? m[4]!; return { culprits: [culprit(id, "missing", { neededBy: [m[2]!], wanted: m[3] })], suggested: `Add ${id}${m[3] ? ` ${m[3]}` : ""}: ${m[1]} needs it.` }; } },
  // Forge/NeoForge: "Mod ID: 'balm', Requested by: 'waystones', Expected range: '[21.0,)', Actual version: '[MISSING]'"
  { kind: "missing_dependency", re: /Mod ID: '([\w.-]+)', Requested by: '([\w.-]+)', Expected range: '([^']*)', Actual version: '\[MISSING\]'/,
    read: (m) => ({ culprits: [culprit(m[1]!, "missing", { neededBy: [m[2]!], wanted: m[3] })], suggested: `Add ${m[1]} (${m[3]}): ${m[2]} needs it.` }) },
  // Fabric: "Mod 'Lithium' (lithium) 0.11.4 requires version 1.20.1 of 'Minecraft' (minecraft), but only the wrong version is present: 1.21.1!"
  { kind: "version_mismatch", re: /Mod '(.+?)' \(([\w.-]+)\) \S+ requires (?:version|any version) (\S+)? ?of (?:mod )?'(.+?)' \(([\w.-]+)\), but only the wrong version is present: ([^!]+)!/,
    read: (m) => m[5] === "minecraft" || m[5] === "java" || m[5] === "fabricloader"
      ? { culprits: [culprit(m[2]!, "wrong_version", { wanted: `${m[4]} ${m[3] ?? ""}`.trim() })], suggested: `Replace ${m[1]} with a build for ${m[4]} ${m[6]}, or remove it.` }
      : { culprits: [culprit(m[5]!, "wrong_version", { neededBy: [m[2]!], wanted: m[3] })], suggested: `Change ${m[4]} to version ${m[3]} (found ${m[6]}): ${m[1]} needs it.` } },
  // Forge/NeoForge: "Mod ID: 'x', Requested by: 'y', Expected range: '[2,)', Actual version: '1.5'"
  { kind: "version_mismatch", re: /Mod ID: '([\w.-]+)', Requested by: '([\w.-]+)', Expected range: '([^']*)', Actual version: '([^'\]]+)'/,
    read: (m) => ({ culprits: [culprit(m[1]!, "wrong_version", { neededBy: [m[2]!], wanted: m[3] })], suggested: `Change ${m[1]} to a version in ${m[3]} (found ${m[4]}): ${m[2]} needs it.` }) },
  // Fabric: "Mod 'A' (a) 1.0 is incompatible with any version of mod 'B' (b), but a matching version is present: 2.0!"
  // and, for a range (real, client test 2026-11-03): "Mod 'Xaero's Maps x Waystones' (xmxw) 2.12.1+1.21.1-fabric is
  // incompatible with version 26.2.0 or later of mod 'Xaero's Minimap' (xaerominimap), yet a conflicting version is present: 26.6.0!"
  // and (real, server test 2026-11-10): "... is incompatible with any version before 26.4.0 of mod 'Xaero's Minimap' ..."
  { kind: "incompatible_mods", re: /Mod '(.+?)' \(([\w.-]+)\) \S+ is incompatible with (any version(?: (?:before|after) \S+)?|versions? .+?) of (?:mod )?'(.+?)' \(([\w.-]+)\)(?:.*?present: ([^!]+)!)?/,
    read: (m) => ({
      culprits: [culprit(m[2]!, "conflict"), culprit(m[5]!, "conflict", m[3] === "any version" ? {} : { wanted: `not ${m[3]}` })],
      suggested: m[3] === "any version"
        ? `${m[1]} and ${m[4]} can't run together: remove one of them.`
        : `${m[1]} can't run with ${m[4]} ${m[3]}${m[6] ? ` (found ${m[6]})` : ""}: use an older ${m[4]}, a newer ${m[1]} that supports it, or remove one.`,
    }) },
  { kind: "duplicate_mod", re: /(?:Found duplicate mods|Duplicate mods? found)[^\n]*?([\w.-]+)?$/i,
    read: (m) => ({ culprits: m[1] ? [culprit(m[1], "cause")] : [], suggested: "Remove the second copy of the mod." }) },
  // Mixin: "Mixin apply for mod sodium failed sodium.mixins.json:..." / "Mixin [x.mixins.json:...] from mod y"
  { kind: "mixin_failure", re: /Mixin (?:apply for mod ([\w.-]+) failed|\[[^\]]*\] from mod ([\w.-]+))/,
    read: (m) => ({ culprits: [culprit((m[1] ?? m[2])!, "cause")], suggested: `${m[1] ?? m[2]} failed to patch the game: update it, or remove it or the mod it clashes with.` }) },
  { kind: "mixin_failure", re: /(InvalidInjectionException|MixinTargetAlreadyLoadedException|MixinApplyError)/, read: () => ({ culprits: [] }) },
  // Wrong side: client classes on a dedicated server.
  { kind: "wrong_side", re: /(?:Attempted to load class (net\/minecraft\/client\/\S+) for invalid dist DEDICATED_SERVER|Cannot load class (net\.minecraft\.client\.\S+) in environment type SERVER)/,
    read: () => ({ culprits: [], suggested: "A client-only mod is on the server: leave it out of the server test." }) },
  // Java: "(class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0"
  { kind: "java_version", re: /class file version (\d+)\.\d+\), this version of the Java Runtime only recognizes class file versions up to (\d+)/,
    read: (m) => ({ culprits: [], suggested: `Run with Java ${Number(m[1]) - 44} or newer (this was Java ${Number(m[2]) - 44}).` }) },
  { kind: "out_of_memory", re: /java\.lang\.OutOfMemoryError(?:: (.*))?/, read: () => ({ culprits: [], suggested: "Give the game more memory, or remove heavy mods." }) },
  // Config files that don't parse: NeoForge/Forge (night-config) and Fabric mods using Gson/TOML.
  { kind: "config_parse", re: /(?:Failed loading config file|Failed to load config(?: file)?|Error loading config(?: file)?)[: ]+['"]?([\w./-]+\.(?:toml|json5?|cfg|properties|ya?ml|snbt))/i,
    read: (m) => { const name = m[1]!.split("/").pop()!; return { culprits: [culprit(name, "cause", { file: `minecraft/config/${name}` })], suggested: `Fix or remove config/${name}: it doesn't parse.` }; } },
];

const ERROR_LINE = /(\/ERROR\]|\/FATAL\]|Exception|Error:|Caused by:)/;

export function diagnose(log: string): Diagnosis {
  const lines = log.split(/\r?\n/);
  const hits: Hit[] = [];
  lines.forEach((text, i) => {
    for (const r of RULES) {
      const m = text.match(r.re);
      if (m) { hits.push({ kind: r.kind, line: i + 1, ...r.read(m) }); break; }
    }
  });
  if (!hits.length) {
    const ev = lines.flatMap((text, i) => (ERROR_LINE.test(text) ? [{ line: i + 1, text: text.slice(0, 300) }] : [])).slice(0, 12);
    return { kind: "unknown", confidence: "low", culprits: [], evidence: ev, suggested: [], signature: signatureOf("unknown", ev.map((e) => normalise(e.text))) };
  }
  const kind = hits[0]!.kind;
  const same = hits.filter((h) => h.kind === kind);
  // Merge culprits by mod id + role (two mods needing the same library become one culprit).
  const merged = new Map<string, Culprit>();
  for (const c of same.flatMap((h) => h.culprits)) {
    const key = `${c.role}:${c.modId}`;
    const prev = merged.get(key);
    if (prev) prev.neededBy = [...new Set([...prev.neededBy, ...c.neededBy])];
    else merged.set(key, { ...c, neededBy: [...c.neededBy] });
  }
  const culprits = [...merged.values()];
  const evidence = same.slice(0, 40).map((h) => ({ line: h.line, text: lines[h.line - 1]!.trim().slice(0, 300) }));
  return {
    kind,
    confidence: culprits.length ? "high" : "medium",
    culprits,
    evidence,
    suggested: [...new Set(same.flatMap((h) => (h.suggested ? [h.suggested] : [])))],
    signature: signatureOf(kind, culprits.map((c) => `${c.role}:${c.modId}`)),
  };
}

// Timestamps and thread names change between runs; the signature must not.
const normalise = (s: string) => s.replace(/^\[[^\]]*\] \[[^\]]*\]:?\s*/, "").replace(/\d+/g, "#");

function signatureOf(kind: string, parts: string[]): string {
  return createHash("sha1").update([kind, ...[...parts].sort()].join("\n")).digest("hex").slice(0, 16);
}
