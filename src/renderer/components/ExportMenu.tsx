// Export a pack (F08): .mrpack or a Prism instance folder. The save dialog runs in main; the
// result (what was referenced, what was left out, licences to check) goes to onDone.
import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Download } from "lucide-react";
import type { Out } from "@shared/ipc";
import { call, errorMessage } from "../lib/api";
import { Button } from "./Button";

export type ExportResult = NonNullable<Out<"packs:export">>;

export function exportSummary(r: ExportResult): { tone: "info" | "warning"; text: string } {
  const parts = [`Exported to ${r.path}.`];
  if (r.referenced) parts.push(`${r.referenced} file${r.referenced === 1 ? "" : "s"} from Modrinth${r.overrides ? `, ${r.overrides} config file${r.overrides === 1 ? "" : "s"}` : ""}.`);
  if (r.leftOut.length) parts.push(`Left out: ${r.leftOut.map((l) => `${l.relpath.split("/").pop()} (${l.why})`).join("; ")}.`);
  if (r.licenceFlags.length) parts.push(`Check before sharing: ${r.licenceFlags.join("; ")}. The list is in LICENSES.md.`);
  return { tone: r.leftOut.length || r.licenceFlags.length ? "warning" : "info", text: parts.join(" ") };
}

export function ExportMenu({ packId, onDone, onError }: { packId: string; onDone: (r: ExportResult) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  async function run(kind: "mrpack" | "folder") {
    setBusy(true);
    try {
      const r = await call("packs:export", { id: packId, kind });
      if (r) onDone(r);
    } catch (e) { onError(errorMessage(e)); } finally { setBusy(false); }
  }
  const item = "flex cursor-default select-none flex-col rounded-sm px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-2";
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button icon={<Download className="size-4" aria-hidden />} loading={busy} disabled={busy}>
          Export <ChevronDown className="size-3.5 text-muted" aria-hidden />
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={6} className="z-50 min-w-64 rounded-md border border-border bg-surface p-1 shadow-(--shadow-pop)">
          <Menu.Item className={item} onSelect={() => void run("mrpack")}>
            <span className="text-text">.mrpack file</span>
            <span className="text-xs text-subtle">For Prism, Modrinth App and other launchers</span>
          </Menu.Item>
          <Menu.Item className={item} onSelect={() => void run("folder")}>
            <span className="text-text">Instance folder</span>
            <span className="text-xs text-subtle">A Prism instance with every file</span>
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
