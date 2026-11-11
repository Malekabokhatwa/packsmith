// A 28x16 on/off switch (components.md "Switch"). A real button with role="switch", so it is
// keyboard reachable and announces its state.
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-(--duration-fast) disabled:opacity-40 ${checked ? "bg-accent" : "bg-input"}`}>
      <span aria-hidden className={`absolute top-0.5 left-0.5 size-3 rounded-full bg-text transition-transform duration-(--duration-fast) ${checked ? "translate-x-3" : ""}`} />
    </button>
  );
}
