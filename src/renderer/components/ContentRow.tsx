import { ArrowUpCircle, Trash2 } from "lucide-react";
import type { ContentItem } from "@shared/schema";
import { ProjectIcon } from "./ProjectIcon";
import { Switch } from "./Switch";
import { Button } from "./Button";
import { bytes } from "../lib/format";

const SIDE: Record<string, string> = { required: "Needed", optional: "Optional", unsupported: "Not used", unknown: "Unknown" };

function sideTag(client: string, server: string): string {
  if (client !== "unsupported" && server === "unsupported") return "Client";
  if (client === "unsupported" && server !== "unsupported") return "Server";
  if (client === "unknown" || server === "unknown") return "Side unknown";
  return "Client and server";
}

export interface RowActions {
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onUpdate: () => void;
  onRemove: () => void;
}

export function contentTitle(item: ContentItem): string {
  return item.match.status === "modrinth" ? item.match.title : item.relpath.split("/").pop()!.replace(/\.disabled$/, "");
}

// One installed file. Actions (INT-2) show on hover and on keyboard focus.
export function ContentRow({ item, actions }: { item: ContentItem; actions?: RowActions }) {
  const title = contentTitle(item);
  const controls = actions && (
    <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-(--duration-fast) group-hover:opacity-100 group-focus-within:opacity-100">
      {item.match.status === "modrinth" && item.match.update && (
        <Button size="sm" variant="secondary" icon={<ArrowUpCircle className="size-3.5" aria-hidden />} disabled={actions.busy}
          aria-label={`Update ${title} to ${item.match.update.versionNumber}`} onClick={actions.onUpdate}>Update</Button>
      )}
      <button type="button" aria-label={`Remove ${title}`} title={`Remove ${title}`} disabled={actions.busy} onClick={actions.onRemove}
        className="rounded-sm p-1.5 text-muted hover:bg-bg hover:text-danger disabled:opacity-40"><Trash2 className="size-4" /></button>
    </div>
  );
  const toggle = actions && (
    <Switch checked={item.enabled} disabled={actions.busy} label={`${item.enabled ? "Turn off" : "Turn on"} ${title}`} onChange={actions.onToggle} />
  );

  if (item.match.status === "unmatched") {
    const why = item.match.reason === "offline"
      ? "Couldn't check Modrinth just now. It may be offline."
      : "Not found on Modrinth. It may be a CurseForge or hand-added file.";
    return (
      <li className="group grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-3 rounded-md border border-dashed border-input px-3 py-2.5">
        <ProjectIcon title={title} dashed />
        <div className="min-w-0">
          <div className={`truncate font-medium ${item.enabled ? "" : "text-subtle"}`} title={title}>{title}</div>
          <div className="text-sm text-muted">{why}</div>
        </div>
        {controls ?? <span />}
        <span className="font-mono text-mono-sm text-subtle">{bytes(item.bytes)}</span>
        {toggle ?? <span />}
      </li>
    );
  }
  const m = item.match;
  return (
    <li className="group grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-3 rounded-md px-3 py-2.5 hover:bg-surface-2 focus-within:bg-surface-2">
      <ProjectIcon url={m.iconUrl} title={m.title} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={`truncate font-medium ${item.enabled ? "" : "text-subtle"}`} title={m.title}>{m.title}</span>
          <span className="shrink-0 font-mono text-mono-sm text-subtle">{m.versionNumber}</span>
          {!item.enabled && <span className="shrink-0 rounded-xs border border-border px-1.5 text-xs text-subtle">Off</span>}
          {m.update && <span className="size-1.5 shrink-0 self-center rounded-full bg-info" title={`Update to ${m.update.versionNumber} available`} aria-label="update available" />}
        </div>
        <div className="truncate text-sm text-muted" title={m.summary}>{m.summary}</div>
      </div>
      {controls ?? <span />}
      <span className="rounded-xs border border-border bg-surface-2 px-1.5 text-xs text-muted" title={`Client: ${SIDE[m.clientSide]} · Server: ${SIDE[m.serverSide]}`}>
        {sideTag(m.clientSide, m.serverSide)}
      </span>
      {toggle ?? <span />}
    </li>
  );
}
