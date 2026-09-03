import { useState } from 'react'

import { useAuth } from './authContext'
import { Banner, Button, Field, Input } from './ui'

/** Porta de entrada do painel. Sem sessão válida, é a única tela que existe. */
export default function Login() {
  const { login } = useAuth()
  const [form, setForm] = useState({ username: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      await login(form.username, form.password)
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
    // sucesso não desliga o busy: a tela inteira é trocada pelo painel
  }

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden px-6 py-12">
      {/* brilho verde atrás do card — a única cor forte da tela é a da marca */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-wa-500/10 blur-[120px]"
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            WhatsApp <span className="text-wa-500">Conversion Tracker</span>
          </h1>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
            Entre para ver as linhas, o rastreamento e as conversões.
          </p>
        </div>

        <form
          className="space-y-4 rounded-xl border border-ink-800 bg-ink-900 p-6"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Field label="Usuário">
            <Input
              autoFocus
              value={form.username}
              autoComplete="username"
              spellCheck={false}
              placeholder="seu.usuario"
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </Field>
          <Field label="Senha">
            <Input
              type="password"
              value={form.password}
              autoComplete="current-password"
              placeholder="••••••••"
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>

          {err && <Banner tone="bad">{err}</Banner>}

          <Button
            type="submit"
            variant="primary"
            full
            disabled={busy || !form.username || !form.password}
          >
            {busy ? 'entrando…' : 'Entrar'}
          </Button>
        </form>

        <p className="mt-5 text-center text-[11px] leading-relaxed text-ink-500">
          Esqueceu a senha? Peça a um administrador para redefinir em Admin → Usuários.
        </p>
      </div>
    </div>
  )
}
