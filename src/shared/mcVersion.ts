// Minecraft version ordering. Release names went from 1.x ("1.21.11") to year-based ("26.1",
// "26.2.1"), so string order is wrong ("26.2" < "1.21" as text). Compare parsed keys instead.
function key(v: string): number[] {
  const parts = v.split(".").map((p) => Number.parseInt(p, 10) || 0);
  // 1.x releases sort before every year-based release.
  return parts[0] === 1 ? [0, parts[1] ?? 0, parts[2] ?? 0] : [1, parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function compareMcVersions(a: string, b: string): number {
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Newest first, without duplicates.
export function newestFirst(versions: Iterable<string>): string[] {
  return [...new Set(versions)].sort((a, b) => compareMcVersions(b, a));
}
