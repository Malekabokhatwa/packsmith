// M-6 config formats (CFG-2): every config write is parsed before it lands. A file that doesn't
// parse is refused with the line and the reason, never written "to see what happens".
import { parse as parseToml } from "smol-toml";
import JSON5 from "json5";
import { parseAllDocuments } from "yaml";

export type ConfigFormat = "properties" | "options" | "toml" | "json" | "json5" | "snbt" | "yaml" | "plain";
export type Check = { ok: true } | { ok: false; error: string };

export const MAX_CONFIG_BYTES = 512 * 1024;

// The format of a config file from its name. null = not a text config packsmith edits.
export function formatFor(relpath: string): ConfigFormat | null {
  const name = relpath.split("/").pop()!.toLowerCase();
  if (name === "options.txt" || name === "optionsof.txt") return "options"; // Minecraft's key:value
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "properties": return "properties";
    case "toml": return "toml";
    case "json": case "mcmeta": return "json";
    case "json5": return "json5";
    case "snbt": return "snbt";
    case "yaml": case "yml": return "yaml";
    case "txt": case "cfg": case "conf": case "ini": return "plain"; // no shared grammar: text only
    default: return null;
  }
}

const fail = (error: string): Check => ({ ok: false, error });

export function checkConfig(format: ConfigFormat, content: string): Check {
  if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) return fail("The file is larger than 512 KB, which is too big for a config.");
  if (content.includes("\u0000")) return fail("The text contains a NUL character, so it isn't a text config.");
  try {
    switch (format) {
      case "plain": return { ok: true };
      case "json": JSON.parse(content); return { ok: true };
      case "json5": JSON5.parse(content); return { ok: true };
      case "toml": parseToml(content); return { ok: true };
      case "yaml": {
        const err = parseAllDocuments(content).flatMap((d) => ("errors" in d ? d.errors : []))[0];
        return err ? fail(err.message) : { ok: true };
      }
      case "snbt": return checkSnbt(content);
      case "options": return checkLines(content, /^[A-Za-z0-9_.\-]+:/, "key:value");
      case "properties": return checkLines(content, /^[^=:\s][^=:]*([=:]|$)/, "key=value");
    }
  } catch (err) {
    return fail((err as Error).message.split("\n")[0]!);
  }
}

function checkLines(content: string, re: RegExp, shape: string): Check {
  const lines = content.split(/\r?\n/);
  let continued = false;
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    const wasContinued = continued;
    continued = shape === "key=value" && line.endsWith("\\");
    if (!line || wasContinued || line.startsWith("#") || line.startsWith("!")) continue;
    if (!re.test(line)) return fail(`Line ${i + 1} isn't ${shape}: "${line.slice(0, 60)}"`);
  }
  return { ok: true };
}

// SNBT as FTB Quests writes it: compounds {k: v}, lists [a, b] and typed arrays [I; 1, 2],
// quoted or bare strings, numbers with b/s/l/f/d suffixes. Entries may be separated by commas
// or by newlines (FTB's style). This checks structure; values are not typed against a schema.
export function checkSnbt(text: string): Check {
  let i = 0;
  const line = () => text.slice(0, i).split("\n").length;
  const err = (what: string): never => { throw new SnbtError(`Line ${line()}: ${what}`); };
  const ws = () => { while (i < text.length && /\s/.test(text[i]!)) i++; };
  const sep = () => { // commas and/or newlines between entries
    ws();
    while (text[i] === ",") { i++; ws(); }
  };
  const quoted = () => {
    const q = text[i++]!;
    while (i < text.length && text[i] !== q) { if (text[i] === "\\") i++; i++; }
    if (text[i] !== q) err("a quoted string never ends");
    i++;
  };
  const bare = () => {
    const start = i;
    while (i < text.length && /[A-Za-z0-9._+\-]/.test(text[i]!)) i++;
    if (i === start) err(`unexpected "${text[i] ?? "end of file"}"`);
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++; sep();
      while (text[i] !== "}") {
        if (i >= text.length) err("a { is never closed");
        if (text[i] === '"' || text[i] === "'") quoted(); else bare();
        ws();
        if (text[i] !== ":") err("expected : after a key");
        i++;
        value(); sep();
      }
      i++;
    } else if (c === "[") {
      i++; ws();
      if (/^[BIL];/.test(text.slice(i, i + 2))) i += 2;
      sep();
      while (text[i] !== "]") {
        if (i >= text.length) err("a [ is never closed");
        value(); sep();
      }
      i++;
    } else if (c === '"' || c === "'") quoted();
    else bare();
  };
  try {
    value();
    ws();
    if (i < text.length) err(`unexpected "${text[i]}" after the end of the data`);
    return { ok: true };
  } catch (e) {
    if (e instanceof SnbtError) return fail(e.message);
    throw e;
  }
}

class SnbtError extends Error {}
