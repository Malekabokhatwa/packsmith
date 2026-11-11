// How a boot test reads to the agent: a compact, deterministic summary. A failure is a tool error
// whose text depends only on what failed (no timestamps, no paths), so the runtime's stagnation
// count (same error N times -> stop, SPEC 5.1) recognises the same crash coming back.
import { RUNG_LABELS, type BranchReport, type TestReport } from "@shared/schema";
import type { Diagnosis } from "../crash/diagnose";
import type { ModrinthClient } from "../sources/modrinth";

const stripStamp = (s: string) => s.replace(/^\[[^\]]*\] \[[^\]]*\]:?\s*/, "").trim().slice(0, 240);

export function rungText(b: BranchReport): string {
  if (b.status === "n/a") return `${b.branch}: not applicable (${b.note})`;
  if (b.status === "not-tested") return `${b.branch}: not tested (${b.note})`;
  const top = b.reached ? `up to "${RUNG_LABELS[b.reached]}"` : "nothing";
  return b.status === "proven" ? `${b.branch}: proven ${top}` : `${b.branch}: proven ${top}, failed at "${RUNG_LABELS[b.failedAt ?? b.reached + 1]}". ${b.note}`;
}

export function diagnosisText(d: Diagnosis): string {
  const who = d.culprits.map((c) => `${c.modId} (${c.role}${c.wanted ? `, wants ${c.wanted}` : ""}${c.neededBy.length ? `, needed by ${c.neededBy.join(", ")}` : ""}${c.projectId ? `, Modrinth project ${c.projectId}` : ""})`);
  return [
    `Diagnosis: ${d.kind} (${d.confidence} confidence).`,
    who.length ? `Culprits: ${who.join("; ")}.` : "",
    d.suggested.length ? `Suggested: ${d.suggested.join(" ")}` : "",
    d.evidence.length ? `Log: ${d.evidence.slice(0, 6).map((e) => stripStamp(e.text)).join(" | ")}` : "",
  ].filter(Boolean).join(" ");
}

// The failure message for launch_test, or null when nothing failed.
export function failureText(r: TestReport): string | null {
  const failed = r.branches.filter((b) => b.status === "failed");
  if (!failed.length) return null;
  const parts = [`Resolved: ${r.resolved.ok ? "yes" : "no"} (${r.resolved.note})`, ...r.branches.map(rungText)];
  for (const b of failed) {
    if (b.diagnosis) parts.push(diagnosisText(b.diagnosis));
    if (b.diagnosis?.kind === "unknown" && b.tail.length) parts.push(`Last log lines: ${b.tail.slice(-8).map(stripStamp).join(" | ")}`);
  }
  parts.push("Repair one thing at a time (download_file, remove_file, set_enabled, write_file), then run launch_test again.");
  return parts.join("\n");
}

// Add Modrinth project ids to missing and wrong-version culprits (mod ids are usually slugs).
export async function withProjects(d: Diagnosis, modrinth: ModrinthClient): Promise<Diagnosis> {
  const ids = [...new Set(d.culprits.filter((c) => c.role === "missing" || c.role === "wrong_version").map((c) => c.modId))].filter((id) => id !== "minecraft" && id !== "java");
  if (!ids.length) return d;
  const found = await modrinth.projects(ids).catch(() => []);
  const bySlug = new Map(found.map((p) => [p.slug, p.id]));
  return { ...d, culprits: d.culprits.map((c) => (bySlug.has(c.modId) ? { ...c, projectId: bySlug.get(c.modId) } : c)) };
}
