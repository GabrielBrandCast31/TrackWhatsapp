import type { ReactNode } from 'react'
import { useState } from 'react'

export function Card({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900">
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-ink-800 px-5 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-tight text-ink-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  )
}

type ButtonProps = {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  size?: 'sm' | 'md'
  type?: 'button' | 'submit'
}

export function Button({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  size = 'md',
  type = 'button',
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40'
  const sizes = { sm: 'px-2.5 py-1 text-xs', md: 'px-3.5 py-2 text-sm' }
  const variants = {
    primary: 'bg-wa-500 text-ink-950 hover:bg-wa-600',
    ghost: 'border border-ink-700 bg-ink-850 text-ink-100 hover:border-ink-500 hover:bg-ink-800',
    danger: 'border border-red-900/60 bg-red-950/40 text-red-300 hover:bg-red-950/70',
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${sizes[size]} ${variants[variant]}`}>
      {children}
    </button>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-ink-500">{hint}</span>}
    </label>
  )
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-wa-500 focus:outline-none"
    />
  )
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 focus:border-wa-500 focus:outline-none"
    />
  )
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className="w-full resize-y rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm leading-relaxed text-ink-100 placeholder:text-ink-500 focus:border-wa-500 focus:outline-none"
    />
  )
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-sm text-ink-100"
    >
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-wa-500' : 'bg-ink-700'
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </span>
      {label}
    </button>
  )
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'info'
}) {
  const tones = {
    neutral: 'border-ink-700 bg-ink-850 text-ink-300',
    good: 'border-wa-500/40 bg-wa-900/50 text-wa-500',
    bad: 'border-red-900/60 bg-red-950/40 text-red-300',
    warn: 'border-amber-900/60 bg-amber-950/40 text-amber-300',
    info: 'border-sky-900/60 bg-sky-950/40 text-sky-300',
  }
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[11px] leading-tight ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

export function Json({ value, max = 320 }: { value: unknown; max?: number }) {
  return (
    <pre
      className="overflow-auto rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-ink-300"
      style={{ maxHeight: max }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

export function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      size="sm"
      onClick={() => {
        navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }}
    >
      {done ? 'copiado' : 'copiar'}
    </Button>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-800 px-4 py-10 text-center text-sm text-ink-500">
      {children}
    </div>
  )
}

export function Banner({ tone, children }: { tone: 'good' | 'bad' | 'warn'; children: ReactNode }) {
  const tones = {
    good: 'border-wa-500/30 bg-wa-900/30 text-wa-500',
    bad: 'border-red-900/50 bg-red-950/30 text-red-300',
    warn: 'border-amber-900/50 bg-amber-950/30 text-amber-200',
  }
  return <div className={`rounded-lg border px-3.5 py-2.5 text-xs leading-relaxed ${tones[tone]}`}>{children}</div>
}

export function when(date: string) {
  return new Date(date).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' })
}
