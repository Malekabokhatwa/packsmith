// Minimal zip writer for exports (M-12): deflated entries, no zip64 (an export is mods' URLs and
// config files, far below 4 GB). Entry names are checked so the archive can't carry a path that
// escapes its folder when someone extracts it (SPEC 8.11, the writing side of Zip Slip).
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { crc32, deflateRawSync } from "node:zlib";
import { AppError } from "../errors";

interface Written { name: Buffer; crc: number; size: number; packed: number; method: number; offset: number }

export function safeEntryName(name: string): string {
  const n = name.replace(/\\/g, "/");
  if (!n || n.startsWith("/") || /^[a-z]:/i.test(n) || n.split("/").some((p) => p === ".." || p === "")) {
    throw new AppError("bad-entry", `Refused to write "${name}" into an archive.`);
  }
  return n;
}

export class ZipWriter {
  private readonly entries: Written[] = [];
  private offset = 0;
  private readonly out;
  private constructor(private readonly path: string) {
    this.out = createWriteStream(`${path}.part`, { flags: "w" });
  }

  static create(path: string): ZipWriter { return new ZipWriter(path); }

  private write(buf: Buffer): Promise<void> {
    this.offset += buf.length;
    return new Promise((res, rej) => this.out.write(buf, (e) => (e ? rej(e) : res())));
  }

  async add(entryName: string, data: Buffer): Promise<void> {
    const name = Buffer.from(safeEntryName(entryName), "utf8");
    const packedData = deflateRawSync(data);
    const stored = packedData.length >= data.length;
    const body = stored ? data : packedData;
    const e: Written = { name, crc: crc32(data), size: data.length, packed: body.length, method: stored ? 0 : 8, offset: this.offset };
    if (this.entries.length >= 0xffff || this.offset + body.length > 0xffffffff - 1024 * 1024) throw new AppError("too-big", "This export is too big for a zip packsmith can write.");
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(e.method, 8); h.writeUInt32LE(0x00210000, 10); // 1980-01-01, so exports are reproducible
    h.writeUInt32LE(e.crc, 14); h.writeUInt32LE(e.packed, 18); h.writeUInt32LE(e.size, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    await this.write(Buffer.concat([h, name, body]));
    this.entries.push(e);
  }

  async close(): Promise<void> {
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10); c.writeUInt32LE(0x00210000, 12);
      c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.packed, 20); c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.name.length, 28); c.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([c, e.name]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12); end.writeUInt32LE(start, 16);
    await this.write(end);
    await new Promise<void>((res, rej) => this.out.end((e?: Error | null) => (e ? rej(e) : res())));
    await rename(`${this.path}.part`, this.path);
  }

  async abort(): Promise<void> {
    await new Promise<void>((res) => this.out.end(() => res()));
    await rm(`${this.path}.part`, { force: true });
  }
}
