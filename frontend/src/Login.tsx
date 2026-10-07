import { useState } from 'react'

import { authApi } from './api'
import { useAuth } from './authContext'
import { IconFacebook, Logo } from './icons'
import { Banner, Button, Field, Input } from './ui'

/** Porta de entrada do painel. Sem sessão válida, é a única tela que existe. */
export default function Login() {
  const { login, facebookError } = useAuth()
  const [form, setForm] = useState({ username: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(facebookError)

  // sai pro Facebook; a volta cai no callback do backend e de lá no painel já logado
  const withFacebook = async () => {
    setBusy(true)
    setErr(null)
    try {
      window.location.href = (await authApi.facebookStart()).url
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

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
          <Logo className="mx-auto mb-4 h-12 w-12" />
          <h1 className="text-xl font-semibold tracking-tight">
            Jornada do <span className="text-wa-500">Lead</span>
          </h1>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
            Do anúncio ao site, do site ao WhatsApp, do WhatsApp ao lead.
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

          <div className="flex items-center gap-3 text-[11px] text-ink-500">
            <span className="h-px flex-1 bg-ink-800" />
            ou
            <span className="h-px flex-1 bg-ink-800" />
          </div>

          <Button full disabled={busy} onClick={() => void withFacebook()}>
            <IconFacebook className="h-4 w-4 text-[#1877F2]" />
            Entrar com Facebook
          </Button>
        </form>

        <p className="mt-5 text-center text-[11px] leading-relaxed text-ink-500">
          Esqueceu a senha? Peça a um administrador para redefinir em Admin → Usuários.
          <br />
          Para entrar com Facebook, vincule antes em Minha conta → Vincular Facebook.
        </p>
      </div>
    </div>
  )
}
