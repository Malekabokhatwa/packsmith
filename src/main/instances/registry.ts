import { join } from "node:path";
import { PacksFile, type InstanceRecord } from "@shared/schema";
import { readJson, writeJsonAtomic } from "../store/jsonFile";
import { AppError } from "../errors";

// packs.json: the instances packsmith knows about (spec 4.4). Writes are serialised so two
// quick actions can't interleave a read-modify-write.
export class Registry {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly dataDir: string) {}
  private get file() { return join(this.dataDir, "packs.json"); }

  async all(): Promise<InstanceRecord[]> {
    return (await readJson(this.file, PacksFile, {})).instances;
  }

  async get(id: string): Promise<InstanceRecord> {
    const r = (await this.all()).find((x) => x.id === id);
    if (!r) throw new AppError("unknown-pack", "That pack isn't in packsmith's list any more.");
    return r;
  }

  mutate<T>(fn: (list: InstanceRecord[]) => T | Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const data = await readJson(this.file, PacksFile, {});
      const out = await fn(data.instances);
      await writeJsonAtomic(this.file, PacksFile.parse(data));
      return out;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
