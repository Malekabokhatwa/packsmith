// Plan card (flow F02): what the agent wants to build, resolved before it is
// shown, so the file count and size are real and every library says who needs it. The two
// buttons answer it: "Forge it" builds exactly this; "Change the plan" lets the user say what.
import type { Plan } from "@shared/agent";
import { ProjectIcon } from "./ProjectIcon";
import { Button } from "./Button";
import { bytes, loaderName, plural } from "../lib/format";

const TAG: Record<Plan["mods"][number]["why"], string> = { requested: "Pick", dependency: "Library", already: "In the pack" };

function why(m: Plan["mods"][number]): string {
  if (m.why === "requested") return m.reason ?? "Picked for this pack.";
  return m.neededBy.length ? `Needed by ${m.neededBy.join(", ")}.` : "Already in the pack.";
}

export function PlanCard({ plan, onForge, onChange }: { plan: Plan; onForge?: () => void; onChange?: () => void }) {
  return (
    <section aria-label={`Plan: ${plan.name}`} className="mb-3 rounded-lg border border-border bg-surface px-5 pt-4 pb-3">
      <h3 className="m-0 truncate text-lg font-semibold" title={plan.name}>{plan.name}</h3>
      <p className="m-0 mb-2 text-sm text-muted">{loaderName(plan.loader)} · Minecraft {plan.mcVersion}</p>
      <ul className="m-0 list-none p-0">
        {plan.mods.map((m) => (
          <li key={m.projectId} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-t border-border py-2.5 first:border-t-0">
            <ProjectIcon url={m.iconUrl} title={m.title} />
            <div className="min-w-0">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-medium" title={m.title}>{m.title}</span>
                <span className="shrink-0 font-mono text-mono-sm text-subtle">{m.versionNumber}</span>
              </div>
              <div className="truncate text-sm text-muted" title={why(m)}>{why(m)}</div>
            </div>
            <span className="rounded-xs border border-border px-1.5 text-xs text-muted">{TAG[m.why]}</span>
          </li>
        ))}
      </ul>
      {plan.unknowns.length > 0 && (
        <ul className="m-0 mt-1 mb-1 list-none border-l-3 border-warning p-0 pl-3 text-sm text-muted">
          {plan.unknowns.map((u) => <li key={u}>{u}</li>)}
        </ul>
      )}
      <div className="mt-2 flex items-center gap-2 border-t border-border pt-3">
        <span className="flex-1 text-sm text-subtle">{plural(plan.files, "file")} to download · {bytes(plan.bytes)}</span>
        {onChange && <Button onClick={onChange}>Change the plan</Button>}
        {onForge && <Button variant="primary" onClick={onForge}>Forge it</Button>}
      </div>
    </section>
  );
}
