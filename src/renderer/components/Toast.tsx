import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

// Bottom-right notice. Without an action it leaves after 6 s; with one ("Removed Jade. Undo")
// it stays until used or closed, so nobody loses the undo by reading slowly.
export function Toast({ children, action, onClose }: { children: ReactNode; action?: ReactNode; onClose: () => void }) {
  useEffect(() => {
    if (action) return;
    const t = setTimeout(onClose, 6000);
    return () => clearTimeout(t);
  }, [action, onClose]);
  return (
    <div role="status" className="fixed right-4 bottom-4 z-50 flex max-w-110 items-center gap-3 rounded-md border border-border bg-surface-2 py-2 pr-2 pl-3.5 text-sm shadow-pop">
      <span className="min-w-0 flex-1">{children}</span>
      {action}
      <button type="button" aria-label="Close" onClick={onClose} className="rounded-sm p-1 text-muted hover:text-text"><X className="size-4" /></button>
    </div>
  );
}
