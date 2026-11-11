// The change journal (spec 4.3, CFG-2, G-5). Every change packsmith makes inside a pack runs
// through record(): the before-state of each file it may touch is copied to a backup and an
// "open" line is appended BEFORE anything changes; after the change a "committed" line records
// the after-hashes. A crash in between leaves an "open" entry that recover() rolls back at startup.
//
// Storage (DECISIONS D-22): <dataDir>/journal/<instanceId>/journal.jsonl (append-only, last line
// per entry id wins) and backups/<entryId>/<relpath>. Nothing is written inside the instance
// except the change itself, and every path goes through assertWritable.
//
// Rollback is checked before anything is touched (DECISIONS D-23): every file must still be
// exactly as the entry left it (else a later change would be lost) and every backup must still
// hash to the recorded before-state. Only then are files restored, each one atomically.
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { JournalEntry, type InstanceRecord, type JournalAction } from "@shared/schema";
import { assertWritable } from "./writable";
import { AppError } from "../errors";

export interface JournalMeta { action: JournalAction; reason: string; runId?: string }

export async function sha256File(path: string): Promise<string | null> {
  try {
    const st = await lstat(path);
    if (st.isDirectory()) throw new AppError("not-a-file", `${path} is a folder, not a file.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export class Journal {
  private locks = new Map<string, Promise<unknown>>();
  constructor(private readonly dataDir: string, private readonly now = () => new Date()) {}

  private dir(instanceId: string) { return join(this.dataDir, "journal", instanceId); }
  private file(instanceId: string) { return join(this.dir(instanceId), "journal.jsonl"); }
  private backupPath(instanceId: string, entryId: string, rel: string) { return join(this.dir(instanceId), "backups", entryId, rel); }

  // One change at a time per instance, so two actions can't interleave their writes.
  private serial<T>(instanceId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(instanceId) ?? Promise.resolve()).then(fn);
    this.locks.set(instanceId, run.catch(() => undefined));
    return run;
  }

  private async append(instanceId: string, entry: JournalEntry): Promise<void> {
    await mkdir(this.dir(instanceId), { recursive: true });
    const fh = await open(this.file(instanceId), "a");
    try {
      await fh.writeFile(JSON.stringify(JournalEntry.parse(entry)) + "\n", "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  // Current state of every entry, newest first. A torn last line (crash mid-append) is skipped.
  async list(r: InstanceRecord): Promise<JournalEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file(r.id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const byId = new Map<string, JournalEntry>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JournalEntry.safeParse(JSON.parse(line));
        if (e.success) byId.set(e.data.id, e.data);
      } catch { /* torn line */ }
    }
    return [...byId.values()].reverse();
  }

  // Run one journaled change. `relpaths` lists every file the change may create, change or remove;
  // `mutate` receives their checked absolute paths and must not write anywhere else.
  record<T>(r: InstanceRecord, meta: JournalMeta, relpaths: string[], mutate: (abs: Map<string, string>) => Promise<T>): Promise<{ entry: JournalEntry; result: T }> {
    return this.serial(r.id, async () => {
      const id = `j-${this.now().getTime().toString(36)}-${randomBytes(4).toString("hex")}`;
      const abs = new Map<string, string>();
      const files: JournalEntry["files"] = [];
      for (const rel of [...new Set(relpaths)]) {
        const p = await assertWritable(r, rel);
        abs.set(rel, p);
        const before = await sha256File(p);
        let backup: string | null = null;
        if (before !== null) {
          const dest = this.backupPath(r.id, id, rel);
          await mkdir(dirname(dest), { recursive: true });
          await copyFile(p, dest);
          backup = rel;
        }
        files.push({ relpath: rel, beforeSha256: before, afterSha256: null, backup });
      }
      const open: JournalEntry = { id, runId: meta.runId, at: this.now().toISOString(), state: "open", action: meta.action, reason: meta.reason, files };
      await this.append(r.id, open);

      let result: T;
      try {
        result = await mutate(abs);
      } catch (err) {
        // Put everything back the way it was. If even that fails the entry stays "open" and
        // startup recovery tries again.
        try {
          await this.restore(r, open, false);
          await this.append(r.id, { ...open, at: this.now().toISOString(), state: "rolled-back" });
        } catch (restoreErr) {
          console.error("journal: restore after a failed change failed", restoreErr);
        }
        throw err;
      }
      const after: JournalEntry = {
        ...open, at: this.now().toISOString(), state: "committed",
        files: await Promise.all(files.map(async (f) => ({ ...f, afterSha256: await sha256File(abs.get(f.relpath)!) }))),
      };
      await this.append(r.id, after);
      return { entry: after, result };
    });
  }

  rollback(r: InstanceRecord, entryId: string): Promise<JournalEntry> {
    return this.serial(r.id, async () => {
      const entry = (await this.list(r)).find((e) => e.id === entryId);
      if (!entry) throw new AppError("unknown-entry", "That change isn't in this pack's journal.");
      if (entry.state === "rolled-back") throw new AppError("already-undone", "That change was already undone.");
      if (entry.state === "open") throw new AppError("entry-open", "That change didn't finish; packsmith undoes it on the next start.");
      await this.restore(r, entry, true);
      const done: JournalEntry = { ...entry, at: this.now().toISOString(), state: "rolled-back" };
      await this.append(r.id, done);
      return done;
    });
  }

  // Startup recovery: roll back entries that were still open when packsmith stopped.
  recover(r: InstanceRecord): Promise<number> {
    return this.serial(r.id, async () => {
      let n = 0;
      for (const e of await this.list(r)) {
        if (e.state !== "open") continue;
        await this.restore(r, e, false);
        await this.append(r.id, { ...e, at: this.now().toISOString(), state: "rolled-back" });
        n++;
      }
      return n;
    });
  }

  // checkCurrent: the files must be exactly as the entry left them (a normal undo). An open
  // entry has no after-state, so recovery skips that check.
  private async restore(r: InstanceRecord, e: JournalEntry, checkCurrent: boolean): Promise<void> {
    const plan: Array<{ abs: string; backup: string | null }> = [];
    for (const f of e.files) {
      const abs = await assertWritable(r, f.relpath);
      if (checkCurrent && (await sha256File(abs)) !== f.afterSha256) {
        throw new AppError("rollback-conflict", `${f.relpath} changed after this step, so undoing it now would lose that later change. Undo the newer changes first.`);
      }
      const backup = f.backup ? this.backupPath(r.id, e.id, f.backup) : null;
      if (f.beforeSha256 !== null) {
        if (!backup || (await sha256File(backup)) !== f.beforeSha256) {
          throw new AppError("backup-damaged", `The saved copy of ${f.relpath} is missing or damaged, so packsmith can't undo this change.`);
        }
      }
      plan.push({ abs, backup });
    }
    for (const [i, f] of e.files.entries()) {
      const { abs, backup } = plan[i]!;
      if (f.beforeSha256 === null) {
        await rm(abs, { force: true });
        await rm(`${abs}.part`, { force: true }); // an interrupted download
      } else {
        // Copy next to the target, then rename over it: never a half-restored file. A symlink at
        // the target is replaced by the file, not written through (INS-5).
        const tmp = `${abs}.${randomBytes(4).toString("hex")}.restore`;
        await copyFile(backup!, tmp);
        await rename(tmp, abs);
      }
    }
  }
}
