import { useEffect, useRef, useState } from 'react'

import { authApi, session } from './api'
import { useAuth } from './authContext'
import { IconChevronDown, IconKey, IconLogout } from './icons'
import { Banner, Button, Field, Input } from './ui'

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
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-950/80 px-6 backdrop-blur-sm"
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

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Quem está logado, no canto do cabeçalho: avatar com menu de conta. */
export default function AccountBar() {
  const { user, isAdmin, logout } = useAuth()
  const [dialog, setDialog] = useState(false)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  // clique fora ou Esc fecham o menu — senão ele fica pendurado na tela
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!user) return null
  const display = user.name || user.username

  return (
    <>
      <div className="relative" ref={box}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`flex items-center gap-2 rounded-full border py-1 pl-1 pr-2 transition-colors ${
            open ? 'border-ink-700 bg-ink-850' : 'border-transparent hover:border-ink-800 hover:bg-ink-850/60'
          }`}
        >
          <span className="relative">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-wa-500 to-wa-600 text-[11px] font-bold text-ink-950">
              {initials(display)}
            </span>
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-900 bg-wa-500" />
          </span>
          <IconChevronDown className={`h-4 w-4 text-ink-500 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-ink-800 bg-ink-900 shadow-2xl"
          >
            <div className="border-b border-ink-800 px-4 py-3">
              <p className="truncate text-sm font-medium text-ink-100">{display}</p>
              <p className="truncate text-[11px] text-ink-500">{user.username}</p>
              {isAdmin && (
                <span className="mt-2 inline-flex items-center rounded-md border border-sky-900/60 bg-sky-950/40 px-1.5 py-0.5 font-mono text-[10px] text-sky-300">
                  admin
                </span>
              )}
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                setDialog(true)
              }}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-ink-300 transition-colors hover:bg-ink-850 hover:text-ink-100"
            >
              <IconKey className="h-4 w-4" />
              Trocar senha
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={logout}
              className="flex w-full items-center gap-2.5 border-t border-ink-800 px-4 py-2.5 text-sm text-red-300 transition-colors hover:bg-red-950/30"
            >
              <IconLogout className="h-4 w-4" />
              Sair
            </button>
          </div>
        )}
      </div>
      {dialog && <PasswordDialog onClose={() => setDialog(false)} />}
    </>
  )
}
