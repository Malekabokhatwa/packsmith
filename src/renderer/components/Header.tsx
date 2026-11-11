import type { ReactNode } from "react";

export function Header({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="flex h-(--header) shrink-0 items-center gap-3 border-b border-border px-5">
      <h1 className="m-0 text-base font-semibold">{title}</h1>
      {children}
    </header>
  );
}
