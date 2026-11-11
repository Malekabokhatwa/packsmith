// Read-only zip access for jars (mod jars, Minecraft's client jar): list entry names and read one
// entry, without extracting anything to disk (so no Zip Slip, spec 8.11). Reads the central
// directory only; stored and deflated entries; no zip64 (jars stay far below its limits).
import { open, type FileHandle } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { AppError } from "../errors";

interface Entry { method: number; compressed: number; size: number; offset: number }

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export class ZipReader {
  private constructor(private readonly fh: FileHandle, private readonly entries: Map<string, Entry>) {}

  static async open(path: string): Promise<ZipReader> {
    const fh = await open(path, "r");
    try {
      const { size } = await fh.stat();
      // End of central directory: 22 bytes + up to 64 KB of comment, at the end of the file.
      const tail = Math.min(size, 22 + 65_535);
      const buf = Buffer.alloc(tail);
      await fh.read(buf, 0, tail, size - tail);
      let eocd = -1;
      for (let i = tail - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
      if (eocd < 0) throw new AppError("bad-zip", `${path} isn't a zip or jar file.`);
      const count = buf.readUInt16LE(eocd + 10);
      const cdSize = buf.readUInt32LE(eocd + 12);
      const cdOffset = buf.readUInt32LE(eocd + 16);
      if (count === 0xffff || cdOffset === 0xffffffff) throw new AppError("bad-zip", `${path} is a zip64 archive, which packsmith doesn't read.`);
      const cd = Buffer.alloc(cdSize);
      await fh.read(cd, 0, cdSize, cdOffset);
      const entries = new Map<string, Entry>();
      for (let p = 0, n = 0; n < count; n++) {
        if (cd.readUInt32LE(p) !== 0x02014b50) throw new AppError("bad-zip", `${path} has a damaged file list.`);
        const method = cd.readUInt16LE(p + 10);
        const compressed = cd.readUInt32LE(p + 20);
        const sizeU = cd.readUInt32LE(p + 24);
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        const offset = cd.readUInt32LE(p + 42);
        const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
        entries.set(name, { method, compressed, size: sizeU, offset });
        p += 46 + nameLen + extraLen + commentLen;
      }
      return new ZipReader(fh, entries);
    } catch (err) {
      await fh.close();
      throw err;
    }
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  async read(name: string): Promise<Buffer | null> {
    const e = this.entries.get(name);
    if (!e) return null;
    if (e.size > MAX_ENTRY_BYTES) throw new AppError("too-large", `${name} is too large to read.`);
    const head = Buffer.alloc(30);
    await this.fh.read(head, 0, 30, e.offset);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new AppError("bad-zip", `The entry ${name} is damaged.`);
    const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const data = Buffer.alloc(e.compressed);
    await this.fh.read(data, 0, e.compressed, start);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
    throw new AppError("bad-zip", `${name} uses a compression packsmith doesn't read.`);
  }

  async text(name: string): Promise<string | null> {
    return (await this.read(name))?.toString("utf8") ?? null;
  }

  close(): Promise<void> {
    return this.fh.close();
  }
}

export async function withZip<T>(path: string, fn: (z: ZipReader) => Promise<T>): Promise<T> {
  const z = await ZipReader.open(path);
  try {
    return await fn(z);
  } finally {
    await z.close();
  }
}
