import type { ButtonHTMLAttributes, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "bg-surface-2 text-text border border-border hover:border-input",
  ghost: "text-muted hover:text-text hover:bg-surface-2",
  danger: "text-danger border border-danger/40 hover:border-danger",
};
const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs font-semibold gap-1.5",
  md: "h-8.5 px-3.5 text-sm font-semibold gap-2",
  lg: "h-10.5 px-4.5 text-base font-semibold gap-2",
};

export function Button({ variant = "secondary", size = "md", loading = false, icon, children, className = "", disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm transition-colors duration-(--duration-fast) disabled:cursor-default disabled:opacity-40 ${VARIANT[variant]} ${SIZE[size]} ${className}`}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}
