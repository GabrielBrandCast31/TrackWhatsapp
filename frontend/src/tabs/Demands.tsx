import { useCallback, useEffect, useMemo, useState } from 'react'

import { demandsApi, type Demand, type DemandInput, type DemandPriority, type DemandStatus } from '../api'
import { useAuth } from '../authContext'
import { IconClose } from '../icons'
import { useNumber } from '../numberContext'
import { Badge, Banner, Button, Empty, Field, Input, Select, Textarea, when } from '../ui'

const COLUMNS: { id: DemandStatus; label: string; empty: string }[] = [
  { id: 'aberta', label: 'A fazer', empty: 'Nada na fila.' },
  { id: 'andamento', label: 'Em andamento', empty: 'Ninguém trabalhando em nada agora.' },
  { id: 'concluida', label: 'Concluídas', empty: 'Nenhuma demanda concluída ainda.' },
]

const PRIORITIES: { id: DemandPriority; label: string; tone: 'neutral' | 'info' | 'warn' | 'bad' }[] = [
  { id: 'baixa', label: 'baixa', tone: 'neutral' },
  { id: 'media', label: 'média', tone: 'info' },
  { id: 'alta', label: 'alta', tone: 'warn' },
  { id: 'urgente', label: 'urgente', tone: 'bad' },
]
const PRIORITY_RANK: Record<DemandPriority, number> = { urgente: 0, alta: 1, media: 2, baixa: 3 }

/** Próximo passo de cada coluna — o botão rápido do cartão. */
const NEXT: Record<DemandStatus, { to: DemandStatus; label: string }> = {
  aberta: { to: 'andamento', label: 'Iniciar' },
  andamento: { to: 'concluida', label: 'Concluir' },
  concluida: { to: 'aberta', label: 'Reabrir' },
}

/** Quantas concluídas a coluna mostra antes do "ver todas". */
const DONE_PREVIEW = 15

/** Hoje no fuso de quem está olhando, no formato do prazo (AAAA-MM-DD). */
function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 2026-11-20 -> 20/11 (o ano só aparece quando não é o atual). */
function prettyDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return y === String(new Date().getFullYear()) ? `${d}/${m}` : `${d}/${m}/${y}`
}

function isLate(d: Demand, now: string) {
  return d.status !== 'concluida' && !!d.due_date && d.due_date < now
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' | 'warn' }) {
  const color =
    tone === 'good'
      ? 'text-wa-500'
      : tone === 'bad' && value > 0
        ? 'text-red-300'
        : tone === 'warn' && value > 0
          ? 'text-amber-300'
          : 'text-ink-100'
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900 px-3.5 py-2.5">
      <p className="truncate text-[10px] uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  )
}

function DemandCard({
  demand,
  now,
  onOpen,
  onMove,
}: {
  demand: Demand
  now: string
  onOpen: () => void
  onMove: (to: DemandStatus) => void
}) {
  const priority = PRIORITIES.find((p) => p.id === demand.priority) ?? PRIORITIES[1]
  const late = isLate(demand, now)
  const dueToday = demand.status !== 'concluida' && demand.due_date === now
  const next = NEXT[demand.status]
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(demand.id))
        e.dataTransfer.effectAllowed = 'move'
      }}
      className={`cursor-grab rounded-lg border bg-ink-950 p-3 transition-colors hover:border-ink-500 active:cursor-grabbing ${
        late ? 'border-red-900/60' : 'border-ink-800'
      }`}
    >
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <p
          className={`break-words text-sm font-medium leading-snug ${
            demand.status === 'concluida' ? 'text-ink-500 line-through' : 'text-ink-100'
          }`}
        >
          {demand.title}
        </p>
        <p className="mt-1 truncate text-[11px] text-ink-500">
          {[demand.number_label ?? 'Interna', demand.assignee_name ?? 'sem responsável'].join(' · ')}
        </p>
      </button>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Badge tone={priority.tone}>{priority.label}</Badge>
        {demand.status === 'concluida' && demand.completed_at ? (
          <Badge tone="good">feita {when(demand.completed_at).split(',')[0]}</Badge>
        ) : (
          demand.due_date && (
            <Badge tone={late ? 'bad' : dueToday ? 'warn' : 'neutral'}>
              {late ? 'atrasada · ' : dueToday ? 'hoje · ' : ''}
              {prettyDate(demand.due_date)}
            </Badge>
          )
        )}
        <span className="ml-auto">
          <Button size="sm" onClick={() => onMove(next.to)}>
            {next.label}
          </Button>
        </span>
      </div>
    </li>
  )
}

type Draft = DemandInput

function blank(assigneeId: number | null): Draft {
  return {
    title: '',
    description: null,
    wa_number_id: null,
    assignee_id: assigneeId,
    priority: 'media',
    status: 'aberta',
    due_date: null,
  }
}

function DemandModal({
  demand,
  users,
  defaultAssignee,
  onClose,
  onSaved,
  onRemoved,
}: {
  /** null = cadastro novo */
  demand: Demand | null
  users: { id: number; name: string }[]
  defaultAssignee: number | null
  onClose: () => void
  onSaved: (d: Demand) => void
  onRemoved: (id: number) => void
}) {
  const { numbers } = useNumber()
  const [draft, setDraft] = useState<Draft>(() =>
    demand
      ? {
          title: demand.title,
          description: demand.description,
          wa_number_id: demand.wa_number_id,
          assignee_id: demand.assignee_id,
          priority: demand.priority,
          status: demand.status,
          due_date: demand.due_date,
        }
      : blank(defaultAssignee),
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // demanda recebida de outra pessoa: só o status muda
  const locked = !!demand && !demand.can_edit
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  // o cliente/responsável atual pode não estar nas listas (linha de outro canal,
  // usuário desativado) — entra como opção pra não sumir do select ao editar
  const clientOptions = numbers.map((n) => ({ id: n.id, label: n.label }))
  if (demand?.wa_number_id != null && !clientOptions.some((o) => o.id === demand.wa_number_id)) {
    clientOptions.push({ id: demand.wa_number_id, label: demand.number_label ?? `#${demand.wa_number_id}` })
  }
  const userOptions = [...users]
  if (demand?.assignee_id != null && !userOptions.some((u) => u.id === demand.assignee_id)) {
    userOptions.push({ id: demand.assignee_id, name: demand.assignee_name ?? `#${demand.assignee_id}` })
  }

  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      const saved = !demand
        ? await demandsApi.create(draft)
        : await demandsApi.update(demand.id, locked ? { status: draft.status } : draft)
      onSaved(saved)
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!demand || !window.confirm(`Apagar a demanda "${demand.title}"? Não dá pra desfazer.`)) return
    setBusy(true)
    setErr(null)
    try {
      await demandsApi.remove(demand.id)
      onRemoved(demand.id)
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-3 backdrop-blur-sm md:p-6"
      onClick={onClose}
    >
      <form
        className="w-full max-w-xl rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="flex items-start justify-between gap-4 border-b border-ink-800 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink-100">{demand ? 'Demanda' : 'Nova demanda'}</h2>
            {demand && (
              <p className="mt-0.5 text-[11px] text-ink-500">
                criada por {demand.creator_name ?? 'usuário removido'} em {when(demand.created_at)}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-ink-800 text-ink-500 hover:text-ink-100"
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {err && <Banner tone="bad">{err}</Banner>}
          {locked && (
            <Banner tone="warn">Esta demanda foi atribuída a você: dá pra mudar o status, o resto é de quem criou.</Banner>
          )}

          <Field label="Título">
            <Input
              autoFocus={!demand}
              required
              maxLength={200}
              disabled={locked}
              placeholder="Ex.: Subir campanha de Black Friday"
              value={draft.title}
              onChange={(e) => set({ title: e.target.value })}
            />
          </Field>

          <Field label="Descrição">
            <Textarea
              rows={4}
              disabled={locked}
              placeholder="O que precisa ser feito, links, observações…"
              value={draft.description ?? ''}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cliente">
              <Select
                disabled={locked}
                value={draft.wa_number_id ?? ''}
                onChange={(e) => set({ wa_number_id: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">Interna — sem cliente</option>
                {clientOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Responsável">
              <Select
                disabled={locked}
                value={draft.assignee_id ?? ''}
                onChange={(e) => set({ assignee_id: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">Sem responsável</option>
                {userOptions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Prioridade">
              <Select
                disabled={locked}
                value={draft.priority}
                onChange={(e) => set({ priority: e.target.value as DemandPriority })}
              >
                {PRIORITIES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label[0].toUpperCase() + p.label.slice(1)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Prazo">
              <Input
                type="date"
                disabled={locked}
                value={draft.due_date ?? ''}
                onChange={(e) => set({ due_date: e.target.value || null })}
              />
            </Field>

            <Field label="Status">
              <Select value={draft.status} onChange={(e) => set({ status: e.target.value as DemandStatus })}>
                {COLUMNS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id === 'concluida' ? 'Concluída' : c.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-ink-800 px-5 py-4">
          {demand?.can_edit && (
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              Apagar
            </Button>
          )}
          <span className="ml-auto flex items-center gap-2">
            <Button onClick={onClose}>Cancelar</Button>
            <Button type="submit" variant="primary" disabled={busy || !draft.title.trim()}>
              {busy ? 'Salvando…' : demand ? 'Salvar' : 'Cadastrar'}
            </Button>
          </span>
        </div>
      </form>
    </div>
  )
}

/** Painel de demandas: o gestor cadastra, distribui e acompanha num quadro. */
export default function Demands() {
  const { user, isAdmin } = useAuth()
  const [rows, setRows] = useState<Demand[] | null>(null)
  const [users, setUsers] = useState<{ id: number; name: string }[]>([])
  const [err, setErr] = useState<string | null>(null)
  /** 'new' = cadastro; Demand = edição; null = fechado */
  const [editing, setEditing] = useState<Demand | 'new' | null>(null)
  const [search, setSearch] = useState('')
  const [client, setClient] = useState('all')
  const [assignee, setAssignee] = useState('all')
  const [priority, setPriority] = useState('all')
  const [dragOver, setDragOver] = useState<DemandStatus | null>(null)
  const [showAllDone, setShowAllDone] = useState(false)

  const load = useCallback(async () => {
    try {
      setRows(await demandsApi.list())
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
    void demandsApi
      .options()
      .then((o) => setUsers(o.users))
      .catch((e) => setErr((e as Error).message))
  }, [load])

  const now = today()
  const all = rows ?? []

  // filtros montados com o que existe no quadro — não oferece opção que daria vazio
  const clients = useMemo(() => {
    const map = new Map<number, string>()
    for (const d of all) if (d.wa_number_id != null) map.set(d.wa_number_id, d.number_label ?? `#${d.wa_number_id}`)
    return [...map].sort((a, b) => a[1].localeCompare(b[1]))
  }, [all])
  const assignees = useMemo(() => {
    const map = new Map<number, string>()
    for (const d of all) if (d.assignee_id != null) map.set(d.assignee_id, d.assignee_name ?? `#${d.assignee_id}`)
    return [...map].sort((a, b) => a[1].localeCompare(b[1]))
  }, [all])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return all.filter(
      (d) =>
        (client === 'all' || (client === 'none' ? d.wa_number_id == null : String(d.wa_number_id) === client)) &&
        (assignee === 'all' || (assignee === 'none' ? d.assignee_id == null : String(d.assignee_id) === assignee)) &&
        (priority === 'all' || d.priority === priority) &&
        (!q || d.title.toLowerCase().includes(q) || (d.description ?? '').toLowerCase().includes(q)),
    )
  }, [all, search, client, assignee, priority])

  const byColumn = (status: DemandStatus) => {
    const list = filtered.filter((d) => d.status === status)
    if (status === 'concluida') {
      return list.sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
    }
    // atrasadas e urgentes sobem; sem prazo vai pro fim do mesmo nível
    return list.sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') ||
        b.id - a.id,
    )
  }

  const upsert = (d: Demand) => setRows((prev) => (prev ?? []).filter((x) => x.id !== d.id).concat(d))

  const move = async (demand: Demand, to: DemandStatus) => {
    if (demand.status === to) return
    // muda na tela antes da resposta; se o backend recusar, volta
    upsert({ ...demand, status: to })
    try {
      upsert(await demandsApi.update(demand.id, { status: to }))
      setErr(null)
    } catch (e) {
      upsert(demand)
      setErr((e as Error).message)
    }
  }

  const open = all.filter((d) => d.status !== 'concluida')
  const filtering = search.trim() !== '' || client !== 'all' || assignee !== 'all' || priority !== 'all'

  return (
    <div className="space-y-5">
      {err && <Banner tone="bad">{err}</Banner>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <Tile label="A fazer" value={all.filter((d) => d.status === 'aberta').length} />
        <Tile label="Em andamento" value={all.filter((d) => d.status === 'andamento').length} />
        <Tile label="Atrasadas" value={open.filter((d) => isLate(d, now)).length} tone="bad" />
        <Tile label="Vencem hoje" value={open.filter((d) => d.due_date === now).length} tone="warn" />
        <Tile label="Concluídas" value={all.filter((d) => d.status === 'concluida').length} tone="good" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[180px] flex-1 sm:max-w-xs">
          <Input
            type="search"
            aria-label="Buscar demanda"
            placeholder="Buscar demanda…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="w-44">
          <Select aria-label="Filtrar por cliente" value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="all">Todos os clientes</option>
            <option value="none">Internas</option>
            {clients.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        {isAdmin && (
          <div className="w-44">
            <Select aria-label="Filtrar por responsável" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="all">Todos os responsáveis</option>
              <option value="none">Sem responsável</option>
              {assignees.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="w-40">
          <Select aria-label="Filtrar por prioridade" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="all">Toda prioridade</option>
            {PRIORITIES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label[0].toUpperCase() + p.label.slice(1)}
              </option>
            ))}
          </Select>
        </div>
        <span className="ml-auto">
          <Button variant="primary" onClick={() => setEditing('new')}>
            + Nova demanda
          </Button>
        </span>
      </div>

      {rows === null ? (
        !err && <p className="text-xs text-ink-500">carregando…</p>
      ) : all.length === 0 ? (
        <Empty>
          Nenhuma demanda cadastrada ainda. Clique em <span className="text-ink-100">+ Nova demanda</span> para começar.
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {COLUMNS.map((col) => {
            const list = byColumn(col.id)
            const capped = col.id === 'concluida' && !showAllDone ? list.slice(0, DONE_PREVIEW) : list
            return (
              <section
                key={col.id}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(col.id)
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(null)
                  const dropped = all.find((d) => d.id === Number(e.dataTransfer.getData('text/plain')))
                  if (dropped) void move(dropped, col.id)
                }}
                className={`rounded-xl border bg-ink-900 transition-colors ${
                  dragOver === col.id ? 'border-wa-500' : 'border-ink-800'
                }`}
              >
                <header className="flex items-center justify-between border-b border-ink-800 px-4 py-3">
                  <h2 className="text-sm font-semibold tracking-tight text-ink-100">{col.label}</h2>
                  <span className="text-xs tabular-nums text-ink-500">{list.length}</span>
                </header>
                <div className="p-3">
                  {list.length === 0 ? (
                    <p className="px-1 py-6 text-center text-xs text-ink-500">
                      {filtering ? 'Nada neste filtro.' : col.empty}
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {capped.map((d) => (
                        <DemandCard
                          key={d.id}
                          demand={d}
                          now={now}
                          onOpen={() => setEditing(d)}
                          onMove={(to) => void move(d, to)}
                        />
                      ))}
                    </ul>
                  )}
                  {capped.length < list.length && (
                    <button
                      type="button"
                      onClick={() => setShowAllDone(true)}
                      className="mt-3 w-full text-center text-xs text-ink-500 hover:text-ink-100"
                    >
                      ver todas as {list.length}
                    </button>
                  )}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {editing && (
        <DemandModal
          demand={editing === 'new' ? null : editing}
          users={users}
          // quem não é admin só atribui a si mesmo: já vem preenchido
          defaultAssignee={isAdmin ? null : (user?.id ?? null)}
          onClose={() => setEditing(null)}
          onSaved={(d) => {
            upsert(d)
            setEditing(null)
          }}
          onRemoved={(id) => {
            setRows((prev) => (prev ?? []).filter((x) => x.id !== id))
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}
