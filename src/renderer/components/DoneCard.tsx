// The Done card (S04, components.md "Done"): what the run proved, what it didn't, and what to do
// next with the pack. Shown under an answer whose latest boot test failed nothing.
import { useEffect, useState } from "react";
import { FolderOpen, Rocket } from "lucide-react";
import type { InstanceRecord, TestReport } from "@shared/schema";
import { call, errorMessage } from "../lib/api";
import { Button } from "./Button";
import { Banner } from "./Banner";
import { EvidenceLadder } from "./EvidenceLadder";
import { ExportMenu, exportSummary } from "./ExportMenu";

// Everything a test didn't prove, in words (SPEC 11.3: never imply a rung that wasn't reached).
export function notChecked(report: TestReport): string[] {
  const out = report.branches.flatMap((b) => {
    const side = b.branch === "server" ? "Server" : "The game itself";
    if (b.status === "n/a") return [`${side}: ${b.note ?? "doesn't apply to this pack"}`];
    if (b.status === "not-tested") return [`${side}: ${b.note ?? "not tested"}`];
    return [];
  });
  return [...out, "Playing it: recipes, quests and balance aren't tested by a boot."];
}

export function DoneCard({ report }: { report: TestReport }) {
  const [pack, setPack] = useState<InstanceRecord | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "warning" | "danger"; text: string } | null>(null);
  useEffect(() => { void call("packs:list").then((all) => setPack(all.find((p) => p.id === report.instanceId) ?? null)).catch(() => setPack(null)); }, [report.instanceId]);
  const name = pack?.name ?? "The pack";
  async function openInPrism() {
    setNotice(null);
    try {
      const r = await call("packs:openInPrism", { id: report.instanceId });
      setNotice({ tone: "info", text: r.mode === "show" ? "Opened in Prism Launcher." : "Prism Launcher is asking to import the pack. Confirm there, then press Launch." });
    } catch (e) { setNotice({ tone: "danger", text: errorMessage(e) }); }
  }
  return (
    <section aria-label={`${name} is ready`} className="mt-1 mb-3 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <h3 className="m-0 text-base font-semibold">{name} is ready</h3>
      <EvidenceLadder report={report} />
      <div>
        <p className="m-0 text-xs font-medium text-muted">Not checked</p>
        <ul className="m-0 mt-1 flex list-disc flex-col gap-0.5 ps-5 text-sm text-subtle">
          {notChecked(report).map((t) => <li key={t}>{t}</li>)}
        </ul>
      </div>
      {pack && (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={<Rocket className="size-4" aria-hidden />} onClick={() => void openInPrism()}>Open in Prism</Button>
          <Button icon={<FolderOpen className="size-4" aria-hidden />} onClick={() => void call("packs:openFolder", { id: pack.id }).catch((e) => setNotice({ tone: "danger", text: errorMessage(e) }))}>Show files</Button>
          <ExportMenu packId={pack.id} onDone={(r) => setNotice(exportSummary(r))} onError={(text) => setNotice({ tone: "danger", text })} />
        </div>
      )}
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
    </section>
  );
}
