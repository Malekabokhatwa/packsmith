import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore, newChatId } from "../src/main/chats/store";

describe("chat store (S12)", () => {
  it("renames (shortened like titles), keeps the old title for blank names, removes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "packsmith-chats-"));
    try {
      const s = new ChatStore(dir);
      const id = newChatId(), at = new Date().toISOString();
      await s.save({ schemaVersion: 1, id, title: "First", createdAt: at, updatedAt: at, selectors: { mc: "auto", loader: "auto", task: "auto" }, display: [], transcript: [] } as never);
      await s.rename(id, "  A   new\\nname  ");
      expect((await s.list())[0]!.title).toBe("A new\\nname");
      await s.rename(id, "   ");
      expect((await s.list())[0]!.title).toBe("A new\\nname");
      await s.rename(id, "x".repeat(80));
      expect((await s.list())[0]!.title).toHaveLength(48);
      await s.remove(id);
      expect(await s.list()).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
