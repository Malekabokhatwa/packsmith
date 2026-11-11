// download_file core (spec 5.2): stream from cdn.modrinth.com only, hash SHA-1 and SHA-512 while
// streaming (PERF-7), write to a .part file, and rename into place only when both hashes match.
// A mismatch is a hard refusal, never a warning.
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, rename, rm, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { Http } from "./net/http";
import { MODRINTH_CDN_HOSTS, USER_AGENT } from "./sources/modrinth";
import { AppError } from "./errors";

export interface RemoteFile {
  url: string;
  filename: string;
  size: number;
  hashes: { sha1: string; sha512: string };
}

// A Modrinth file name becomes a path segment: no separators, no dot-files, no control chars.
export function safeFilename(name: string): string {
  if (!name || name.length > 255 || /[\/\\\0-\x1f\x7f]/.test(name) || name.startsWith(".") || name === "..") {
    throw new AppError("bad-filename", `Refused an unsafe file name from Modrinth: ${JSON.stringify(name)}`);
  }
  return name;
}

export async function downloadVerified(http: Http, file: RemoteFile, destAbs: string, onProgress?: (done: number, total: number) => void): Promise<void> {
  const part = `${destAbs}.part`;
  await rm(part, { force: true });
  const res = await http.request(file.url, {
    allowHosts: MODRINTH_CDN_HOSTS,
    headers: { "user-agent": USER_AGENT },
    maxBytes: file.size + 1024,
    timeoutMs: 10 * 60_000,
  });
  if (res.status !== 200) {
    res.body.resume();
    throw new AppError("download-failed", `Modrinth's file server answered ${res.status} for ${file.filename}.`);
  }
  const sha1 = createHash("sha1");
  const sha512 = createHash("sha512");
  let done = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sha1.update(chunk);
      sha512.update(chunk);
      done += chunk.length;
      onProgress?.(done, file.size);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(res.body, hasher, createWriteStream(part, { flags: "wx" }));
  } catch (err) {
    await rm(part, { force: true });
    throw err instanceof AppError ? err : new AppError("download-failed", `Downloading ${file.filename} failed: ${(err as Error).message}`, { cause: err });
  }
  const got1 = sha1.digest("hex");
  const got512 = sha512.digest("hex");
  if (got1 !== file.hashes.sha1.toLowerCase() || got512 !== file.hashes.sha512.toLowerCase()) {
    await rm(part, { force: true });
    throw new AppError("hash-mismatch", `${file.filename} didn't match the checksum Modrinth published, so packsmith refused to install it.`);
  }
  // INS-5: if the target is a symlink, replace the link itself rather than writing through it.
  try {
    if ((await lstat(destAbs)).isSymbolicLink()) await unlink(destAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await rename(part, destAbs);
}
