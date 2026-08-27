import { useEffect, useState } from 'react'

import { adminApi, adminToken } from '../api'
import { Badge, Banner, Button, Card, Field, Input } from '../ui'
import Connection from './Connection'
import Crm from './Crm'
import Destinations from './Destinations'
import Manual from './Manual'
import Numbers from './Numbers'
import Prospecting from './Prospecting'

/** Abas que saíram da tela principal e continuam inteiras aqui dentro. */
const ADMIN_TABS = [
  { id: 'prospecting', label: 'Prospecção' },
  { id: 'crm', label: 'CRM' },
  { id: 'numbers', label: 'Cloud API' },
  { id: 'cloud-connection', label: 'Conexão Cloud' },
  { id: 'destinations', label: 'Destinos' },
  { id: 'manual', label: 'Manual' },
] as const

type AdminTabId = (typeof ADMIN_TABS)[number]['id']

function Login({ onLogged }: { onLogged: (user: string) => void }) {
  const [form, setForm] = useState({ username: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      const res = await adminApi.login(form.username, form.password)
      adminToken.set(res.token)
      onLogged(res.user)
    } catch (e) {
      adminToken.set(null)
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <Card
        title="Área restrita"
        subtitle="Prospecção no mapa, CRM, abordagem ativa, Cloud API e destinos extras."
      >
        <form
          className="space-y-4"
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
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </Field>
          <Field label="Senha">
            <Input
              type="password"
              value={form.password}
              autoComplete="current-password"
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
          {err && <Banner tone="bad">{err}</Banner>}
          <Button type="submit" variant="primary" disabled={busy || !form.username || !form.password}>
            {busy ? 'entrando…' : 'Entrar'}
          </Button>
          <p className="text-[11px] leading-snug text-ink-500">
            A sessão vale enquanto esta aba do navegador estiver aberta.
          </p>
        </form>
      </Card>
    </div>
  )
}

export default function Admin({ onChanged }: { onChanged: () => void }) {
  const [user, setUser] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [tab, setTab] = useState<AdminTabId>('prospecting')

  useEffect(() => {
    if (!adminToken.get()) {
      setChecking(false)
      return
    }
    void adminApi
      .session()
      .then((s) => setUser(s.user))
      .catch(() => {
        adminToken.set(null)
        setUser(null)
      })
      .finally(() => setChecking(false))
  }, [])

  if (checking) return <p className="text-sm text-ink-500">verificando sessão…</p>
  if (!user) return <Login onLogged={setUser} />

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-800 bg-ink-900 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">admin</Badge>
          <span className="text-sm text-ink-100">{user}</span>
          <span className="text-[11px] text-ink-500">
            módulos completos: varredura no mapa, CRM, abordagem ativa, Cloud API e destinos extras.
          </span>
        </div>
        <Button
          size="sm"
          onClick={() => {
            adminToken.set(null)
            setUser(null)
          }}
        >
          sair
        </Button>
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-ink-800">
        {ADMIN_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-xs transition-colors ${
              tab === t.id ? 'border-wa-500 text-ink-100' : 'border-transparent text-ink-500 hover:text-ink-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'prospecting' && <Prospecting onChanged={onChanged} />}
      {tab === 'crm' && <Crm onChanged={onChanged} />}
      {tab === 'numbers' && <Numbers onChanged={onChanged} />}
      {tab === 'cloud-connection' && <Connection onChanged={onChanged} />}
      {tab === 'destinations' && <Destinations onChanged={onChanged} />}
      {tab === 'manual' && <Manual onNavigate={() => undefined} />}
    </div>
  )
}
