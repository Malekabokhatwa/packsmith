import { join } from "node:path";
import { Settings } from "@shared/schema";
import { readJson, writeJsonAtomic } from "./store/jsonFile";

export class SettingsStore {
  constructor(private readonly dataDir: string) {}
  private get file() { return join(this.dataDir, "settings.json"); }
  get(): Promise<Settings> { return readJson(this.file, Settings, {}); }
  async update(fn: (s: Settings) => Settings): Promise<Settings> {
    const next = Settings.parse(fn(await this.get()));
    await writeJsonAtomic(this.file, next);
    return next;
  }
}
