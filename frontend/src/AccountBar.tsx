import { useState } from 'react'

import { authApi, session } from './api'
import { useAuth } from './authContext'
import { Badge, Banner, Button, Field, Input } from './ui'

/** Trocar a própria senha. Vale pra qualquer perfil — quem não é admin não tem
 *  outro lugar pra fazer isso. O backend devolve tokens novos porque a troca
 *  derruba todas as sessões antigas, inclusive esta aba. */
function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const mismatch = form.confirm.length > 0 && form.next !== form.confirm
  const ready = form.current && form.next.length >= 8 && !mismatch

  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      const pair = await authApi.changePassword(form.current, form.next)
      session.save(pair)
      setDone(true)
      setTimeout(onClose, 1200)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 px-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        className="w-full max-w-sm space-y-4 rounded-xl border border-ink-800 bg-ink-900 p-6"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-ink-100">Trocar senha</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            As outras sessões suas caem na hora — inclusive a de quem tenha copiado seu token.
          </p>
        </div>

        <Field label="Senha atual">
          <Input
            autoFocus
            type="password"
            autoComplete="current-password"
            value={form.current}
            onChange={(e) => setForm({ ...form, current: e.target.value })}
          />
        </Field>
        <Field label="Nova senha" hint="Mínimo de 8 caracteres.">
          <Input
            type="password"
            autoComplete="new-password"
            value={form.next}
            onChange={(e) => setForm({ ...form, next: e.target.value })}
          />
        </Field>
        <Field label="Repita a nova senha">
          <Input
            type="password"
            autoComplete="new-password"
            value={form.confirm}
            onChange={(e) => setForm({ ...form, confirm: e.target.value })}
          />
        </Field>

        {mismatch && <Banner tone="warn">As duas senhas novas não são iguais.</Banner>}
        {err && <Banner tone="bad">{err}</Banner>}
        {done && <Banner tone="good">Senha trocada.</Banner>}

        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>
            cancelar
          </Button>
          <Button size="sm" type="submit" variant="primary" disabled={busy || !ready || done}>
            {busy ? 'salvando…' : 'Trocar senha'}
          </Button>
        </div>
      </form>
    </div>
  )
}

/** Quem está logado, no canto do cabeçalho. */
export default function AccountBar() {
  const { user, isAdmin, logout } = useAuth()
  const [dialog, setDialog] = useState(false)
  if (!user) return null

  return (
    <>
      <div className="flex items-center gap-2.5">
        <div className="text-right leading-tight">
          <p className="text-xs font-medium text-ink-100">{user.name || user.username}</p>
          <p className="text-[11px] text-ink-500">{user.username}</p>
        </div>
        {isAdmin && <Badge tone="info">admin</Badge>}
        <Button size="sm" onClick={() => setDialog(true)}>
          senha
        </Button>
        <Button size="sm" onClick={logout}>
          sair
        </Button>
      </div>
      {dialog && <PasswordDialog onClose={() => setDialog(false)} />}
    </>
  )
}
