import { join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DisplayItem, Selectors, type ChatSummary, type ChatView } from "@shared/agent";
import { readJson, writeJsonAtomic } from "../store/jsonFile";
import { AppError } from "../errors";
import type { Message } from "../providers/types";

const StoredToolCall = z.object({ id: z.string(), name: z.string(), arguments: z.string(), extra: z.unknown().optional() });
const StoredMessage = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }),
  z.object({ role: z.literal("user"), content: z.string() }),
  z.object({ role: z.literal("assistant"), content: z.string(), toolCalls: z.array(StoredToolCall).optional() }),
  z.object({ role: z.literal("tool"), toolCallId: z.string(), name: z.string(), content: z.string() }),
]);
export const StoredChat = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  selectors: Selectors,
  display: z.array(DisplayItem),
  transcript: z.array(StoredMessage),
});
export type StoredChat = z.infer<typeof StoredChat> & { transcript: Message[] };

export function newChatId(): string {
  return `c-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= 48 ? t : `${t.slice(0, 47).trimEnd()}…`;
}

export class ChatStore {
  constructor(private readonly dataDir: string) {}
  private dir() { return join(this.dataDir, "chats"); }
  private file(id: string) {
    if (!/^c-[a-z0-9]+-[a-f0-9]+$/.test(id)) throw new AppError("bad-chat", "That chat id isn't valid.");
    return join(this.dir(), `${id}.json`);
  }

  async load(id: string): Promise<StoredChat> {
    const c = await readJson(this.file(id), StoredChat.nullable(), null);
    if (!c) throw new AppError("unknown-chat", "That chat doesn't exist any more.");
    return c as StoredChat;
  }

  save(c: StoredChat): Promise<void> {
    return writeJsonAtomic(this.file(c.id), StoredChat.parse(c));
  }

  async list(): Promise<ChatSummary[]> {
    const names = await readdir(this.dir()).catch(() => [] as string[]);
    const out: ChatSummary[] = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        const c = await this.load(n.slice(0, -5));
        out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt });
      } catch { /* skip unreadable files; never delete them */ }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  view(c: StoredChat): ChatView {
    return { id: c.id, title: c.title, updatedAt: c.updatedAt, selectors: c.selectors, display: c.display };
  }

  async rename(id: string, title: string): Promise<void> {
    const c = await this.load(id);
    c.title = titleFrom(title) || c.title;
    await this.save(c);
  }

  remove(id: string): Promise<void> {
    return rm(this.file(id), { force: true });
  }
}
