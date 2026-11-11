// The evidence ladder (design signature, SPEC 11.3): per branch, the rungs a boot test actually
// proved. Verdigris = proven by a test, danger = the rung that was tried and failed, outline = not
// reached. Never shows a rung as proven that the report doesn't prove.
import { useState } from "react";
import { RUNG_LABELS, type BranchReport, type TestReport } from "@shared/schema";

const BRANCH_NAME = { server: "Server", client: "Client" } as const;

export function headline(r: TestReport): { text: string; tone: "verified" | "danger" | "muted" } {
  const failed = r.branches.find((b) => b.status === "failed");
  if (failed) return { text: `Stopped at: ${BRANCH_NAME[failed.branch].toLowerCase()} ${RUNG_LABELS[failed.failedAt ?? failed.reached + 1]?.toLowerCase()}`, tone: "danger" };
  const best = [...r.branches].filter((b) => b.status === "proven").sort((a, b) => b.reached - a.reached)[0];
  if (best && best.reached > 1) {
    // Name every branch that got there: a client that loads a world is the stronger claim.
    const top = r.branches.filter((b) => b.status === "proven" && b.reached === best.reached).map((b) => b.branch).join(" and ");
    return { text: `Proven up to: ${RUNG_LABELS[best.reached]} (${top})`, tone: "verified" };
  }
  return { text: "Not proven yet", tone: "muted" };
}

function Rung({ n, b }: { n: number; b: BranchReport }) {
  const proven = n <= b.reached;
  const failed = b.status === "failed" && b.failedAt === n;
  const state = proven ? "proven" : failed ? "failed" : "not reached";
  return (
    <li className="flex items-center gap-2.5" aria-label={`${BRANCH_NAME[b.branch]}: ${RUNG_LABELS[n]}, ${state}`}>
      <span aria-hidden className={`size-3.5 shrink-0 rounded-xs border ${proven ? "border-verified bg-verified" : failed ? "border-danger" : "border-input"}`} />
      <span className={`text-sm ${proven ? "text-text" : failed ? "text-danger" : "text-subtle"}`}>{RUNG_LABELS[n]}{failed ? ": failed" : ""}</span>
    </li>
  );
}

function Branch({ b }: { b: BranchReport }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="m-0 text-xs font-medium text-muted">{BRANCH_NAME[b.branch]}</h4>
      {b.status === "n/a" || b.status === "not-tested" ? (
        <>
          {b.reached >= 1 && <ol className="m-0 flex list-none flex-col gap-2 p-0"><Rung n={1} b={b} /></ol>}
          <p className="m-0 text-xs text-subtle italic">{b.status === "n/a" ? "n/a" : "Not tested"}: {b.note}</p>
        </>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">{[1, 2, 3].map((n) => <Rung key={n} n={n} b={b} />)}</ol>
      )}
    </div>
  );
}

export function EvidenceLadder({ report, title = "Evidence" }: { report: TestReport; title?: string }) {
  const [open, setOpen] = useState(false);
  const h = headline(report);
  const failed = report.branches.find((b) => b.status === "failed");
  const proof = report.branches.flatMap((b) => (b.status === "proven" ? b.proof : []));
  const lines = failed ? [...(failed.diagnosis?.evidence.map((e) => e.text) ?? []), ...(failed.diagnosis?.evidence.length ? [] : failed.tail)].slice(-8) : proof;
  return (
    <section aria-label={`${title}: ${h.text}`} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="m-0 text-xs font-medium text-muted">{title}</h3>
        <p className={`m-0 text-sm font-semibold ${h.tone === "verified" ? "text-text" : h.tone === "danger" ? "text-danger" : "text-muted"}`}>{h.text}</p>
      </div>
      <div className="grid grid-cols-2 gap-4">{report.branches.map((b) => <Branch key={b.branch} b={b} />)}</div>
      <p className="m-0 text-xs text-subtle">Resolved: {report.resolved.note}</p>
      {failed?.diagnosis && failed.diagnosis.suggested.length > 0 && <p className="m-0 text-sm">{failed.note} {failed.diagnosis.suggested.join(" ")}</p>}
      {failed && !failed.diagnosis?.suggested.length && <p className="m-0 text-sm">{failed.note}</p>}
      {lines.length > 0 && (
        <div>
          <button type="button" className="text-xs text-muted underline-offset-2 hover:text-text hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"} the log lines{failed ? "" : " that prove it"}
          </button>
          {open && <pre className={`m-0 mt-2 overflow-x-auto rounded-sm border border-border bg-bg p-2.5 font-mono text-mono-sm whitespace-pre ${failed ? "text-danger" : "text-verified"}`}>{lines.join("\n")}</pre>}
        </div>
      )}
    </section>
  );
}
