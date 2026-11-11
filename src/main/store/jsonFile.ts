import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { AppError } from "../errors";

// Read a JSON file and parse it with its schema. A missing file yields `fallback`; a file that
// exists but fails to parse is an error, never silently replaced (it may hold the user's data).
export async function readJson<S extends z.ZodType>(path: string, schema: S, fallback: z.input<S>): Promise<z.output<S>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return schema.parse(fallback);
    throw err;
  }
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new AppError("corrupt-file", `${path} is not in the expected format, so packsmith left it untouched.`, { cause: parsed.error });
  return parsed.data;
}

// Atomic write: temp file in the same directory, fsync, rename. A crash leaves either the old
// file or the new one, never half of each.
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(data, null, 2) + "\n");
}

export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fh = await open(tmp, "wx");
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
