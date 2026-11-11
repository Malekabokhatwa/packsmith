import type { ReactNode } from "react";

const TONE = { info: "border-info", warning: "border-warning", danger: "border-danger" } as const;

export function Banner({ tone = "info", children, action }: { tone?: keyof typeof TONE; children: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`flex items-center gap-3 rounded-r-sm border-l-3 bg-surface px-3.5 py-2.5 text-sm ${TONE[tone]}`}>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}
