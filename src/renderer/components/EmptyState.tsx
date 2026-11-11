import type { ReactNode } from "react";

// One sentence, at most one action (components.md "Empty state").
export function EmptyState({ icon, text, action }: { icon: ReactNode; text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <div className="text-subtle" aria-hidden>{icon}</div>
      <p className="m-0 max-w-sm text-base">{text}</p>
      {action}
    </div>
  );
}
