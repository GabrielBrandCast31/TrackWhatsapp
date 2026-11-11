// Peças de UI do editor de formulário, compartilhadas entre as seções.
import type { ReactNode } from "react";
import { HelpCircle } from "./icons";

export const INPUT = "w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm outline-none"
  + " transition-colors placeholder:text-ink-600 focus:border-wa-500/70"
  + " focus:ring-2 focus:ring-wa-500/20";

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-wa-500" : "bg-white/15"}`}>
      <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

export function HelpDot({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <HelpCircle className="size-3.5 cursor-help text-ink-500" />
      <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden w-56 -translate-x-1/2 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-2 text-[11px] leading-relaxed text-ink-100 shadow-xl group-hover:block">
        {text}
      </span>
    </span>
  );
}

/** Linha com rótulo + explicação à esquerda e o controle à direita. */
export function SettingRow({ label, hint, help, required, children }: {
  label: string; hint?: string; help?: string; required?: boolean; children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-ink-800 bg-ink-950/50 px-4 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          {label}{required && <span className="text-red-300">*</span>}
          {help && <HelpDot text={help} />}
        </p>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-ink-400">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Campo empilhado (rótulo em cima, input embaixo). */
export function Field({ label, hint, required, children }: {
  label: string; hint?: string; required?: boolean; children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-950/50 px-4 py-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        {label}{required && <span className="text-red-300">*</span>}
      </p>
      {hint && <p className="mb-2 mt-0.5 text-xs leading-relaxed text-ink-400">{hint}</p>}
      <div className={hint ? "" : "mt-2"}>{children}</div>
    </div>
  );
}

