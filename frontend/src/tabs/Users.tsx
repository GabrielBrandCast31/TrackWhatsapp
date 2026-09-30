import { useCallback, useEffect, useState } from 'react'

import { authApi, evolutionApi, type AuthUser, type EvoInstance } from '../api'
import { useAuth } from '../authContext'
import { Badge, Banner, Button, Card, Empty, Field, Input, Select, TrashButton, when } from '../ui'

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrador — vê todas as linhas, inclusive prospecção, Cloud API e este cadastro',
  user: 'Operação — só as linhas (clientes) marcadas abaixo: CRM, jornadas, atendimento e formulários',
}

const BLANK = { username: '', name: '', password: '', role: 'user', number_ids: [] as number[] }

/** Linhas que o usuário enxerga. Admin vê todas — o seletor some pra ele. */
function LinePicker({
  lines,
  value,
  onChange,
  disabled,
}: {
  lines: EvoInstance[]
  value: number[]
  onChange: (ids: number[]) => void
  disabled?: boolean
}) {
  if (lines.length === 0) return <p className="text-[11px] text-ink-500">Nenhuma linha cadastrada ainda.</p>
  return (
    <div className="flex flex-wrap gap-1.5">
      {lines.map((l) => {
        const on = value.includes(l.id)
        return (
          <button
            key={l.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(on ? value.filter((v) => v !== l.id) : [...value, l.id])}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-50 ${
              on ? 'border-wa-500 bg-wa-900/60 text-wa-500' : 'border-ink-700 text-ink-400 hover:border-ink-500 hover:text-ink-100'
            }`}
          >
            {on ? '✓ ' : ''}
            {l.label}
          </button>
        )
      })}
    </div>
  )
}

/** Cadastro de quem entra no painel. Só admin chega aqui (o backend confere de novo). */
export default function Users() {
  const { user: me } = useAuth()
  const [rows, setRows] = useState<AuthUser[]>([])
  const [form, setForm] = useState({ ...BLANK })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [resetting, setResetting] = useState<number | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [lines, setLines] = useState<EvoInstance[]>([])

  useEffect(() => {
    evolutionApi.list().then(setLines).catch(() => setLines([]))
  }, [])

  const load = useCallback(async () => {
    try {
      setRows(await authApi.users())
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    setErr(null)
    setMsg(null)
    try {
      await fn()
      setMsg(ok)
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const create = () =>
    run(async () => {
      await authApi.createUser({
        username: form.username.trim(),
        password: form.password,
        name: form.name.trim() || undefined,
        role: form.role,
        number_ids: form.role === 'admin' ? [] : form.number_ids,
      })
      setForm({ ...BLANK, number_ids: [] })
    }, 'Usuário criado.')

  const saveReset = (id: number) =>
    run(async () => {
      await authApi.patchUser(id, { password: newPassword })
      setResetting(null)
      setNewPassword('')
    }, 'Senha redefinida. A pessoa entra com a nova na próxima vez.')

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card title="Usuários" subtitle={`${rows.length} com acesso ao painel`}>
        {err && <div className="mb-4"><Banner tone="bad">{err}</Banner></div>}
        {msg && <div className="mb-4"><Banner tone="good">{msg}</Banner></div>}

        {rows.length === 0 ? (
          <Empty>Nenhum usuário cadastrado.</Empty>
        ) : (
          <ul className="divide-y divide-ink-800">
            {rows.map((u) => (
              <li key={u.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm text-ink-100">
                      {u.name || u.username}
                      {u.id === me?.id && <span className="text-[11px] text-ink-500">(você)</span>}
                      {!u.active && <Badge tone="warn">inativo</Badge>}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-500">
                      {u.username} · criado {when(u.created_at)} ·{' '}
                      {u.last_login_at ? `último acesso ${when(u.last_login_at)}` : 'nunca entrou'}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="w-32">
                      <Select
                        value={u.role}
                        disabled={busy}
                        onChange={(e) =>
                          void run(() => authApi.patchUser(u.id, { role: e.target.value }), 'Perfil atualizado.')
                        }
                      >
                        <option value="user">operação</option>
                        <option value="admin">admin</option>
                      </Select>
                    </div>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void run(() => authApi.patchUser(u.id, { active: !u.active }), u.active ? 'Acesso desativado.' : 'Acesso reativado.')}
                    >
                      {u.active ? 'desativar' : 'ativar'}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setResetting(resetting === u.id ? null : u.id)
                        setNewPassword('')
                      }}
                    >
                      redefinir senha
                    </Button>
                    {u.id !== me?.id && (
                      <TrashButton
                        onClick={() => {
                          if (confirm(`Apagar o acesso de ${u.username}?`)) {
                            void run(() => authApi.deleteUser(u.id), 'Usuário apagado.')
                          }
                        }}
                      />
                    )}
                  </div>
                </div>

                {u.role !== 'admin' && (
                  <div className="mt-2.5">
                    <p className="mb-1 text-[10.5px] uppercase tracking-wide text-ink-500">
                      Linhas que vê {(u.number_ids ?? []).length === 0 && <span className="text-amber-300">— nenhuma ainda</span>}
                    </p>
                    <LinePicker
                      lines={lines}
                      value={u.number_ids ?? []}
                      disabled={busy}
                      onChange={(ids) => void run(() => authApi.patchUser(u.id, { number_ids: ids }), 'Linhas atualizadas.')}
                    />
                  </div>
                )}

                {resetting === u.id && (
                  <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-ink-800 bg-ink-850 p-3">
                    <div className="min-w-56 flex-1">
                      <Field label={`Nova senha de ${u.username}`} hint="Mínimo de 8 caracteres. Combine com a pessoa e peça pra ela trocar depois.">
                        <Input
                          autoFocus
                          type="text"
                          value={newPassword}
                          autoComplete="off"
                          onChange={(e) => setNewPassword(e.target.value)}
                        />
                      </Field>
                    </div>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy || newPassword.length < 8}
                      onClick={() => void saveReset(u.id)}
                    >
                      salvar
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Novo usuário" subtitle="O acesso vale na hora, sem convite por e-mail.">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <Field label="Usuário" hint="Sem espaço nem acento — é o que ele digita no login.">
            <Input
              value={form.username}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </Field>
          <Field label="Nome" hint="Opcional, só pra saber de quem é a conta.">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Senha" hint="Mínimo de 8 caracteres.">
            <Input
              type="text"
              value={form.password}
              autoComplete="new-password"
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
          <Field label="Perfil" hint={ROLE_LABEL[form.role]}>
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">operação</option>
              <option value="admin">admin</option>
            </Select>
          </Field>
          {form.role !== 'admin' && (
            <Field label="Linhas (clientes) que ele vê" hint="Ele só enxerga as conversas, jornadas e formulários dessas linhas.">
              <LinePicker lines={lines} value={form.number_ids} onChange={(ids) => setForm({ ...form, number_ids: ids })} />
            </Field>
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={busy || form.username.trim().length < 3 || form.password.length < 8}
          >
            {busy ? 'criando…' : 'Criar usuário'}
          </Button>
        </form>
      </Card>
    </div>
  )
}
