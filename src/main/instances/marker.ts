import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { InstanceMarker } from "@shared/schema";
import { writeJsonAtomic } from "../store/jsonFile";

// Every instance packsmith creates carries this file (spec INS-2). It is how packsmith tells its
// own instances from everyone else's; another tool's marker is never ours.
export const MARKER_FILE = ".packsmith-instance.json";

export async function writeMarker(root: string, marker: InstanceMarker): Promise<void> {
  await writeJsonAtomic(join(root, MARKER_FILE), InstanceMarker.parse(marker));
}

export async function readMarker(root: string): Promise<InstanceMarker | null> {
  try {
    const parsed = InstanceMarker.safeParse(JSON.parse(await readFile(join(root, MARKER_FILE), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
