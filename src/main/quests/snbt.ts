// SNBT values as FTB Quests reads and writes them: compounds, lists (entries separated by commas
// or newlines), typed arrays [I; ...], quoted or bare strings, numbers with b/s/l/f/d suffixes,
// true/false. parse() gives plain JS values; stringify() writes FTB's style (tabs, one entry per
// line). Numbers that need a suffix are written from Num.
export class Num {
  constructor(readonly value: number, readonly suffix: "" | "b" | "s" | "l" | "f" | "d" = "") {}
}
export type SnbtValue = string | number | boolean | Num | SnbtValue[] | { [k: string]: SnbtValue };

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?[bslfdBSLFD]?$/;

export function parseSnbt(text: string): unknown {
  let i = 0;
  const line = () => text.slice(0, i).split("\n").length;
  const fail = (what: string): never => { throw new Error(`SNBT line ${line()}: ${what}`); };
  const ws = () => { while (i < text.length && /\s/.test(text[i]!)) i++; };
  const sep = () => { ws(); while (text[i] === ",") { i++; ws(); } };
  const quoted = (): string => {
    const q = text[i++]!;
    let out = "";
    while (i < text.length && text[i] !== q) {
      if (text[i] === "\\") {
        const c = text[++i];
        out += c === "n" ? "\n" : c === "t" ? "\t" : (c ?? "");
        i++;
      } else out += text[i++];
    }
    if (text[i] !== q) fail("a quoted string never ends");
    i++;
    return out;
  };
  const bare = (): string => {
    const start = i;
    while (i < text.length && /[A-Za-z0-9._+\-]/.test(text[i]!)) i++;
    if (i === start) fail(`unexpected "${text[i] ?? "end of file"}"`);
    return text.slice(start, i);
  };
  const value = (): unknown => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++; sep();
      const obj: Record<string, unknown> = {};
      while (text[i] !== "}") {
        if (i >= text.length) fail("a { is never closed");
        const key = text[i] === '"' || text[i] === "'" ? quoted() : bare();
        ws();
        if (text[i] !== ":") fail("expected : after a key");
        i++;
        obj[key] = value();
        sep();
      }
      i++;
      return obj;
    }
    if (c === "[") {
      i++; ws();
      if (/^[BIL];/.test(text.slice(i, i + 2))) i += 2;
      sep();
      const arr: unknown[] = [];
      while (text[i] !== "]") {
        if (i >= text.length) fail("a [ is never closed");
        arr.push(value());
        sep();
      }
      i++;
      return arr;
    }
    if (c === '"' || c === "'") return quoted();
    const word = bare();
    if (word === "true") return true;
    if (word === "false") return false;
    if (NUMBER.test(word)) return Number.parseFloat(word.replace(/[bslfdBSLFD]$/, ""));
    return word;
  };
  const v = value();
  ws();
  if (i < text.length) fail(`unexpected "${text[i]}" after the end of the data`);
  return v;
}

const BARE_KEY = /^[A-Za-z0-9._+\-]+$/;

function str(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function stringifySnbt(v: SnbtValue, indent = 0): string {
  const pad = "\t".repeat(indent);
  if (v instanceof Num) return `${Number.isInteger(v.value) && (v.suffix === "d" || v.suffix === "f") ? v.value.toFixed(1) : v.value}${v.suffix}`;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") return str(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[ ]";
    if (v.every((x) => typeof x !== "object" || x instanceof Num)) return `[${v.map((x) => stringifySnbt(x)).join(", ")}]`;
    return `[\n${v.map((x) => `${pad}\t${stringifySnbt(x, indent + 1)}`).join("\n")}\n${pad}]`;
  }
  const keys = Object.keys(v).sort();
  if (keys.length === 0) return "{ }";
  return `{\n${keys.map((k) => `${pad}\t${BARE_KEY.test(k) ? k : str(k)}: ${stringifySnbt(v[k]!, indent + 1)}`).join("\n")}\n${pad}}`;
}
