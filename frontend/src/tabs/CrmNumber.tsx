import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  api,
  crmApi,
  CRM_STAGES,
  CRM_STAGE_LABEL,
  type CrmContact,
  type CrmContactDetail,
  type CrmPipeline,
  type CrmStage,
} from '../api'
import { MessagePayloadToggle } from '../MessagePayload'
import { useNumber } from '../numberContext'
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  Field,
  Info,
  Input,
  Json,
  Select,
  Textarea,
  Toggle,
  when,
} from '../ui'

type View = 'kanban' | 'lista' | 'inbox'

const VIEWS: { id: View; label: string }[] = [
  { id: 'kanban', label: 'Kanban' },
  { id: 'lista', label: 'Lista' },
  { id: 'inbox', label: 'Caixa de entrada' },
]

const STAGE_TONE: Record<CrmStage, 'neutral' | 'info' | 'warn' | 'good' | 'bad'> = {
  novo: 'neutral',
  atendendo: 'info',
  qualificado: 'warn',
  ganho: 'good',
  perdido: 'bad',
}

/** De quanto em quanto tempo a tela pergunta ao servidor se algo mudou. */
const LIVE_POLL_MS = 4000

const LIVE_KEY = 'wa.crmLive'

/** Ligado por padrão: quem abre o CRM quer ver a conversa acontecendo. */
function readLive(): boolean {
  try {
    return localStorage.getItem(LIVE_KEY) !== '0'
  } catch {
    return true
  }
}

/** Sinal de que a tela está se atualizando sozinha e de quando isso aconteceu. */
function LiveDot({ on, at }: { on: boolean; at: Date | null }) {
  const label = !on
    ? 'atualização automática desligada'
    : at
      ? `última mudança às ${at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
      : 'acompanhando novas mensagens'
  return (
    <span
      title={label}
      className="flex items-center gap-1.5 rounded-lg border border-ink-800 bg-ink-850 px-2 py-1 text-[11px] text-ink-500"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${on ? 'animate-pulse bg-wa-500' : 'bg-ink-600'}`} />
      <span className="hidden sm:block">{on ? 'ao vivo' : 'pausado'}</span>
    </span>
  )
}

/** Mantém o CRM vivo sem recarregar a página.
 *
 *  A cada batida pede só o cursor de `/api/crm/activity` — cinco contagens, nada
 *  de listar conversa. Enquanto o cursor não muda, nada é recarregado: a tela
 *  fica parada de propósito, e ninguém perde o que estava digitando. Quando ele
 *  muda (mensagem nova, conversa nova, etapa movida, lida/não lida) o `onChange`
 *  refaz as consultas de verdade.
 *
 *  Com a aba em segundo plano a batida é pulada — não adianta gastar requisição
 *  contra uma tela que ninguém está olhando — e volta assim que ela reaparece.
 */
function useCrmLive(numberId: number | undefined, enabled: boolean, onChange: () => void) {
  const cursor = useRef<string | null>(null)
  const handler = useRef(onChange)
  handler.current = onChange

  useEffect(() => {
    // trocou de linha: o cursor da linha anterior não diz nada sobre esta
    cursor.current = null
  }, [numberId])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    let timer = 0

    const tick = async () => {
      if (!alive) return
      if (document.visibilityState === 'visible') {
        try {
          const { cursor: next } = await crmApi.activity(numberId)
          if (!alive) return
          // a primeira leitura só guarda a régua: ela não é uma mudança
          if (cursor.current !== null && next !== cursor.current) handler.current()
          cursor.current = next
        } catch {
          // rede oscilando ou servidor reiniciando: a próxima batida tenta de novo
        }
      }
      if (alive) timer = window.setTimeout(tick, LIVE_POLL_MS)
    }

    const wake = () => {
      if (document.visibilityState !== 'visible') return
      window.clearTimeout(timer)
      void tick()
    }

    void tick()
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => {
      alive = false
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
    }
  }, [numberId, enabled])
}

function shortTime(iso: string | null) {
  if (!iso) return '—'
  const date = new Date(iso)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

/** Conversa que só se identifica pelo LID do WhatsApp: o `wa_id` dela é o LID,
 *  não um telefone. Mostrar aquele número cru faria passar por telefone o que
 *  não é — e alguém acabaria tentando discar. */
function semTelefone(c: { wa_id: string; wa_lid?: string | null }) {
  return !!c.wa_lid && c.wa_lid === c.wa_id
}

function who(c: CrmContact) {
  return c.name ?? c.phone_e164 ?? (semTelefone(c) ? 'Contato sem telefone' : c.wa_id)
}

function phoneLabel(c: { wa_id: string; wa_lid?: string | null; phone_e164: string | null }) {
  return c.phone_e164 ?? (semTelefone(c) ? 'sem telefone' : c.wa_id)
}

function Avatar({ c, size = 36 }: { c: CrmContact; size?: number }) {
  const initials = who(c)
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('')
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-ink-700 bg-ink-850 text-[11px] font-semibold text-ink-300"
      style={{ width: size, height: size }}
    >
      {c.profile_pic_url ? (
        // a URL da foto vem da Evolution e expira; o onError cai nas iniciais
        <img
          src={c.profile_pic_url}
          alt=""
          className="h-full w-full object-cover"
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
        />
      ) : (
        initials || '?'
      )}
    </span>
  )
}

function OriginBadge({ origin }: { origin: string }) {
  if (origin === 'sync') return <Badge>da agenda</Badge>
  if (origin === 'simulado') return <Badge tone="warn">simulado</Badge>
  return null
}

function Tags({ c }: { c: CrmContact }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {c.attributable_meta && <Badge tone="good">anúncio</Badge>}
      {c.attribution.gclid && <Badge tone="warn">gclid</Badge>}
      <OriginBadge origin={c.origin} />
      {c.conversions > 0 && <Badge tone="info">{c.conversions} conv.</Badge>}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  detalhe da conversa — o mesmo painel nas três visualizações                */
/* -------------------------------------------------------------------------- */

function FireBox({ contact, onFired }: { contact: CrmContactDetail; onFired: () => Promise<void> }) {
  const [eventName, setEventName] = useState('Lead')
  const [value, setValue] = useState('')
  const [isTest, setIsTest] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Evento">
          <Input value={eventName} onChange={(e) => setEventName(e.target.value)} />
        </Field>
        <Field label="Valor (opcional)">
          <Input type="number" placeholder="0.00" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </div>
      <Toggle checked={isTest} onChange={setIsTest} label="Modo teste" />
      {!contact.attributable_meta && (
        <Banner tone="warn">
          Conversa sem <code className="font-mono">ctwa_clid</code>: o Meta não consegue ligar esse evento a
          nenhuma campanha. Serve para conferir o payload, não para otimizar.
        </Banner>
      )}
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      <Button
        size="sm"
        variant="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setMsg(null)
          try {
            const conv = await api.fire({
              contact_id: contact.id,
              event_name: eventName,
              value: value === '' ? null : Number(value),
              is_test: isTest,
              destinations: ['meta_capi'],
            })
            const failed = conv.dispatches.filter((d) => d.status === 'error')
            setMsg(
              failed.length
                ? { tone: 'bad', text: failed[0].error ?? 'O destino recusou o evento.' }
                : { tone: 'good', text: `Conversão #${conv.id} enviada.` },
            )
            await onFired()
          } catch (e) {
            setMsg({ tone: 'bad', text: (e as Error).message })
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'enviando…' : 'Disparar conversão'}
      </Button>
    </div>
  )
}

function Thread({ messages }: { messages: CrmContactDetail['messages'] }) {
  if (messages.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-ink-500">
        Nenhuma mensagem guardada. Use <em>puxar histórico</em> para buscar essa conversa na Evolution.
      </p>
    )
  }
  return (
    <ul className="space-y-2">
      {messages.map((m) => {
        const out = m.direction === 'out'
        return (
          <li
            key={m.id}
            className={`rounded-lg border px-3 py-2 ${
              out ? 'ml-8 border-wa-500/25 bg-wa-900/20' : 'mr-8 border-ink-800 bg-ink-850'
            }`}
          >
            <p className="whitespace-pre-wrap text-sm text-ink-100">{m.body ?? `[${m.type}]`}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-500">
              <span>
                {out ? 'atendente' : 'cliente'} · {when(m.sent_at)}
              </span>
              {m.has_payload !== false && <MessagePayloadToggle messageId={m.id} />}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function ContactPanel({
  contactId,
  onChanged,
  onClose,
  compact,
  liveTick = 0,
}: {
  contactId: number
  onChanged: () => Promise<void>
  onClose?: () => void
  compact?: boolean
  /** Sobe a cada mudança detectada no servidor: é o gatilho de releitura desta conversa. */
  liveTick?: number
}) {
  const [detail, setDetail] = useState<CrmContactDetail | null>(null)
  const [note, setNote] = useState('')
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null)
  const detailRef = useRef<CrmContactDetail | null>(null)
  detailRef.current = detail
  const threadRef = useRef<HTMLDivElement>(null)
  const seenMessages = useRef(0)

  const load = useCallback(async () => {
    const data = await crmApi.contact(contactId)
    setDetail(data)
    setNote(data.note ?? '')
  }, [contactId])

  /** Releitura de fundo: igual à de cima, mas não pisa na nota que está sendo
   *  digitada. Só acompanha o servidor quando não há edição pendente. */
  const liveLoad = useCallback(async () => {
    const data = await crmApi.contact(contactId)
    setNote((cur) => (cur === (detailRef.current?.note ?? '') ? data.note ?? '' : cur))
    setDetail(data)
  }, [contactId])

  useEffect(() => {
    void load().catch((e) => setMsg({ tone: 'bad', text: (e as Error).message }))
  }, [load])

  useEffect(() => {
    if (liveTick === 0) return
    void liveLoad().catch(() => {
      // a lista já avisa quando o servidor some; aqui o silêncio é melhor que um
      // banner piscando a cada batida
    })
  }, [liveTick, liveLoad])

  // conversa aberta fica lida: ao abrir e a cada mensagem que chegar com ela na tela
  useEffect(() => {
    if (detail && detail.unread_count > 0) {
      void crmApi.patch(contactId, { mark_read: true }).then(() => onChanged())
    }
  }, [detail?.id, detail?.unread_count])

  // mensagem nova desce a conversa sozinha — senão ela chega fora da vista
  useEffect(() => {
    const count = detail?.messages.length ?? 0
    if (count === seenMessages.current) return
    seenMessages.current = count
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [detail?.messages.length])

  useEffect(() => {
    seenMessages.current = 0
  }, [contactId])

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name)
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  if (!detail) return <p className="text-sm text-ink-500">carregando conversa…</p>

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar c={detail} size={44} />
          <div>
            <p className="text-sm font-semibold text-ink-100">{who(detail)}</p>
            <p className="font-mono text-[11px] text-ink-500">{phoneLabel(detail)}</p>
            <div className="mt-1">
              <Tags c={detail} />
            </div>
          </div>
        </div>
        {onClose && (
          <Button size="sm" onClick={onClose}>
            fechar
          </Button>
        )}
      </div>

      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Etapa">
          <Select
            value={detail.stage}
            onChange={(e) =>
              void act('stage', async () => {
                await crmApi.patch(detail.id, { stage: e.target.value })
                await load()
                await onChanged()
              })
            }
          >
            {CRM_STAGES.map((s) => (
              <option key={s} value={s}>
                {CRM_STAGE_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Última mensagem">
          <div className="rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-xs text-ink-300">
            {detail.last_message_at ? when(detail.last_message_at) : 'nunca conversou'}
          </div>
        </Field>
      </div>

      <Field label="Nota interna" hint="Só aparece aqui. Nada é enviado para o cliente.">
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Button
        size="sm"
        disabled={busy !== null || note === (detail.note ?? '')}
        onClick={() =>
          act('note', async () => {
            await crmApi.patch(detail.id, { note })
            await load()
            setMsg({ tone: 'good', text: 'Nota salva.' })
          })
        }
      >
        {busy === 'note' ? 'salvando…' : 'Salvar nota'}
      </Button>

      <div className="space-y-2 border-t border-ink-800 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-ink-300">Conversa ({detail.messages.length})</span>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              act('history', async () => {
                const r = await crmApi.syncMessages(detail.id)
                await load()
                setMsg({
                  tone: r.saved ? 'good' : 'warn',
                  text: r.saved
                    ? `${r.saved} mensagem(ns) trazida(s) da Evolution.`
                    : 'A Evolution não devolveu mensagem nova para essa conversa.',
                })
              })
            }
          >
            {busy === 'history' ? 'puxando…' : 'puxar histórico'}
          </Button>
        </div>
        <div
          ref={threadRef}
          className={compact ? 'max-h-[46vh] overflow-y-auto pr-1' : 'max-h-80 overflow-y-auto pr-1'}
        >
          <Thread messages={detail.messages} />
        </div>
      </div>

      <div className="space-y-2 border-t border-ink-800 pt-4">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-ink-300">Responder</span>
          <Info text="Sai pela Evolution como mensagem do atendente. Se o texto casar com uma palavra-chave, o evento dispara por conta própria." />
        </div>
        <Textarea
          rows={2}
          value={reply}
          placeholder="Escreva a resposta…"
          onChange={(e) => setReply(e.target.value)}
        />
        <Button
          size="sm"
          variant="primary"
          disabled={busy !== null || !reply.trim()}
          onClick={() =>
            act('reply', async () => {
              await crmApi.reply(detail.id, reply.trim())
              setReply('')
              setMsg({ tone: 'good', text: 'Enviada. A mensagem entra na conversa pelo webhook.' })
              await onChanged()
              // a mensagem só existe aqui quando a Evolution devolver o SEND_MESSAGE;
              // uma releitura logo depois evita a impressão de que nada aconteceu.
              window.setTimeout(() => void load(), 1500)
            })
          }
        >
          {busy === 'reply' ? 'enviando…' : 'Enviar'}
        </Button>
      </div>

      <details className="rounded-lg border border-ink-800 bg-ink-850">
        <summary className="cursor-pointer px-3 py-2 text-xs text-ink-300">Atribuição do anúncio</summary>
        <div className="px-3 pb-3">
          <Json value={detail.attribution} max={200} />
        </div>
      </details>

      <div className="space-y-2 border-t border-ink-800 pt-4">
        <span className="text-xs font-medium text-ink-300">Disparar conversão manualmente</span>
        <FireBox
          contact={detail}
          onFired={async () => {
            await load()
            await onChanged()
          }}
        />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  visualização 1: kanban                                                     */
/* -------------------------------------------------------------------------- */

function Kanban({
  rows,
  onMove,
  onOpen,
}: {
  rows: CrmContact[]
  onMove: (id: number, stage: CrmStage) => Promise<void>
  onOpen: (id: number) => void
}) {
  const [over, setOver] = useState<CrmStage | null>(null)

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {CRM_STAGES.map((stage) => {
        const cards = rows.filter((c) => c.stage === stage)
        return (
          <div
            key={stage}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(stage)
            }}
            onDragLeave={() => setOver((s) => (s === stage ? null : s))}
            onDrop={(e) => {
              e.preventDefault()
              setOver(null)
              const id = Number(e.dataTransfer.getData('text/plain'))
              if (id) void onMove(id, stage)
            }}
            className={`w-[268px] shrink-0 rounded-xl border bg-ink-900 p-2.5 transition-colors ${
              over === stage ? 'border-wa-500' : 'border-ink-800'
            }`}
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-xs font-semibold text-ink-100">{CRM_STAGE_LABEL[stage]}</span>
              <Badge tone={STAGE_TONE[stage]}>{cards.length}</Badge>
            </div>

            <div className="space-y-2">
              {cards.length === 0 && (
                <p className="px-1 py-4 text-center text-[11px] text-ink-500">arraste uma conversa aqui</p>
              )}
              {cards.map((c) => (
                <button
                  key={c.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', String(c.id))}
                  onClick={() => onOpen(c.id)}
                  className="w-full cursor-grab rounded-lg border border-ink-800 bg-ink-950 p-2.5 text-left transition-colors hover:border-ink-700 active:cursor-grabbing"
                >
                  <div className="flex items-center gap-2">
                    <Avatar c={c} size={28} />
                    <span className="flex-1 truncate text-xs font-medium text-ink-100">{who(c)}</span>
                    {c.unread_count > 0 && <Badge tone="good">{c.unread_count}</Badge>}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-ink-500">
                    {c.last_message_from_me ? 'você: ' : ''}
                    {c.last_message_body ?? 'sem mensagem'}
                  </p>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <Tags c={c} />
                    <span className="shrink-0 font-mono text-[10px] text-ink-500">
                      {shortTime(c.last_message_at)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  visualização 2: lista                                                      */
/* -------------------------------------------------------------------------- */

function Lista({
  rows,
  selectedId,
  onOpen,
}: {
  rows: CrmContact[]
  selectedId: number | null
  onOpen: (id: number) => void
}) {
  if (rows.length === 0) return <Empty>Nenhuma conversa com esses filtros.</Empty>
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-ink-800 text-[11px] uppercase tracking-wide text-ink-500">
            <th className="px-2 py-2 font-medium">Contato</th>
            <th className="px-2 py-2 font-medium">Etapa</th>
            <th className="px-2 py-2 font-medium">Última mensagem</th>
            <th className="px-2 py-2 font-medium">Marcadores</th>
            <th className="px-2 py-2 text-right font-medium">Quando</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-800">
          {rows.map((c) => (
            <tr
              key={c.id}
              onClick={() => onOpen(c.id)}
              className={`cursor-pointer transition-colors hover:bg-ink-850 ${
                selectedId === c.id ? 'bg-ink-850' : ''
              }`}
            >
              <td className="px-2 py-2.5">
                <div className="flex items-center gap-2">
                  <Avatar c={c} size={30} />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-ink-100">{who(c)}</p>
                    <p className="font-mono text-[10px] text-ink-500">{phoneLabel(c)}</p>
                  </div>
                </div>
              </td>
              <td className="px-2 py-2.5">
                <Badge tone={STAGE_TONE[c.stage]}>{CRM_STAGE_LABEL[c.stage]}</Badge>
              </td>
              <td className="max-w-[280px] px-2 py-2.5">
                <p className="truncate text-xs text-ink-500">
                  {c.last_message_from_me ? 'você: ' : ''}
                  {c.last_message_body ?? '—'}
                </p>
              </td>
              <td className="px-2 py-2.5">
                <Tags c={c} />
              </td>
              <td className="px-2 py-2.5 text-right font-mono text-[11px] text-ink-500">
                {shortTime(c.last_message_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  visualização 3: caixa de entrada                                           */
/* -------------------------------------------------------------------------- */

function Inbox({
  rows,
  selectedId,
  onOpen,
  onChanged,
  liveTick,
}: {
  rows: CrmContact[]
  selectedId: number | null
  onOpen: (id: number) => void
  onChanged: () => Promise<void>
  liveTick: number
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div className="max-h-[70vh] overflow-y-auto rounded-xl border border-ink-800 bg-ink-900">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-ink-500">Nenhuma conversa.</p>
        ) : (
          <ul className="divide-y divide-ink-800">
            {rows.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => onOpen(c.id)}
                  className={`flex w-full items-start gap-2.5 px-3 py-3 text-left transition-colors hover:bg-ink-850 ${
                    selectedId === c.id ? 'bg-ink-850' : ''
                  }`}
                >
                  <Avatar c={c} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-xs font-medium text-ink-100">{who(c)}</span>
                      <span className="shrink-0 font-mono text-[10px] text-ink-500">
                        {shortTime(c.last_message_at)}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-ink-500">
                      {c.last_message_from_me ? 'você: ' : ''}
                      {c.last_message_body ?? 'sem mensagem'}
                    </p>
                    <div className="mt-1 flex items-center gap-1.5">
                      <Badge tone={STAGE_TONE[c.stage]}>{CRM_STAGE_LABEL[c.stage]}</Badge>
                      {c.unread_count > 0 && <Badge tone="good">{c.unread_count}</Badge>}
                      {c.attributable_meta && <Badge tone="good">anúncio</Badge>}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-ink-800 bg-ink-900 p-5">
        {selectedId ? (
          <ContactPanel contactId={selectedId} onChanged={onChanged} liveTick={liveTick} compact />
        ) : (
          <Empty>Escolha uma conversa à esquerda.</Empty>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

export default function CrmNumber({ onChanged }: { onChanged: () => void }) {
  const { numberId, current, numbers, loading } = useNumber()
  const [view, setView] = useState<View>('kanban')
  const [rows, setRows] = useState<CrmContact[]>([])
  const [pipe, setPipe] = useState<CrmPipeline | null>(null)
  const [filters, setFilters] = useState({ q: '', stage: '', onlyAttributed: false })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null)
  const [live, setLive] = useState(readLive)
  const [liveTick, setLiveTick] = useState(0)
  const [liveAt, setLiveAt] = useState<Date | null>(null)

  const load = useCallback(async () => {
    const [list, pipeline] = await Promise.all([
      crmApi.contacts({
        number_id: numberId,
        // no kanban a coluna já é o filtro de etapa
        stage: view === 'kanban' ? undefined : filters.stage || undefined,
        q: filters.q.trim() || undefined,
        only_attributed: filters.onlyAttributed,
        order: view === 'lista' && filters.stage ? 'created' : 'last_message',
      }),
      crmApi.pipeline(numberId),
    ])
    setRows(list)
    setPipe(pipeline)
  }, [numberId, view, filters.stage, filters.q, filters.onlyAttributed])

  useEffect(() => {
    void load().catch((e) => setMsg({ tone: 'bad', text: (e as Error).message }))
  }, [load])

  const refresh = useCallback(async () => {
    await load()
    onChanged()
  }, [load, onChanged])

  // o servidor mudou: refaz a lista, o funil, os indicadores do topo e a conversa aberta
  useCrmLive(numberId, live, () => {
    void load().catch(() => {
      // sem banner: a lista continua mostrando o último estado bom
    })
    onChanged()
    setLiveTick((n) => n + 1)
    setLiveAt(new Date())
  })

  const toggleLive = (v: boolean) => {
    setLive(v)
    try {
      localStorage.setItem(LIVE_KEY, v ? '1' : '0')
    } catch {
      // navegador sem storage: a preferência vale só pra sessão atual
    }
  }

  const move = async (id: number, stage: CrmStage) => {
    // otimista: o card muda de coluna na hora, e o servidor confirma depois
    setRows((prev) => prev.map((c) => (c.id === id ? { ...c, stage } : c)))
    try {
      await crmApi.patch(id, { stage })
      await refresh()
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message })
      await load()
    }
  }

  const sync = async () => {
    if (numberId === undefined) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await crmApi.sync(numberId)
      const parts = [`${r.created} nova(s)`, `${r.updated} atualizada(s)`]
      if (r.messages) parts.push(`${r.messages} mensagem(ns)`)
      if (r.skipped) parts.push(`${r.skipped} ignorada(s) (grupo/status)`)
      setMsg({
        tone: r.errors.length ? 'warn' : 'good',
        text: `Sincronizado: ${parts.join(', ')}.${
          r.errors.length ? ` A Evolution recusou parte: ${r.errors.join(' — ')}` : ''
        }`,
      })
      await refresh()
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const stageCounts = useMemo(() => pipe?.stages, [pipe])

  if (loading) return <p className="text-sm text-ink-500">carregando…</p>

  if (numbers.length === 0) {
    return (
      <Empty>
        Nenhuma linha cadastrada. Comece na aba <strong className="text-ink-300">Conexão</strong>.
      </Empty>
    )
  }

  return (
    <div className="space-y-4">
      <Card
        title={`CRM de ${current?.label ?? 'todas as linhas'}`}
        subtitle="As conversas deste número. Cada linha tem o seu CRM — nada se mistura entre clientes."
        actions={
          <>
            <div className="flex gap-1 rounded-lg border border-ink-700 bg-ink-850 p-0.5">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setView(v.id)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    view === v.id ? 'bg-wa-500 text-ink-950' : 'text-ink-300 hover:text-ink-100'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <LiveDot on={live} at={liveAt} />
            <Button
              size="sm"
              variant="primary"
              disabled={busy || numberId === undefined}
              onClick={() => void sync()}
            >
              {busy ? 'sincronizando…' : 'Sincronizar'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {numberId === undefined && (
            <Banner tone="warn">
              Você está vendo todas as linhas. Escolha uma no topo para sincronizar a agenda daquele número.
            </Banner>
          )}

          {pipe && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-ink-500">
              <span>
                <strong className="text-ink-100">{pipe.total}</strong> conversa(s)
              </span>
              <span>
                <strong className="text-wa-500">{pipe.attributed}</strong> vinda(s) de anúncio
              </span>
              <span>
                <strong className="text-ink-100">{pipe.unread}</strong> com mensagem não lida
              </span>
              <span>
                <strong className="text-ink-100">{pipe.from_sync}</strong> trazida(s) da agenda
              </span>
              {stageCounts && (
                <span className="flex flex-wrap items-center gap-1.5">
                  {CRM_STAGES.map((s) => (
                    <Badge key={s} tone={STAGE_TONE[s]}>
                      {CRM_STAGE_LABEL[s]}: {stageCounts[s]}
                    </Badge>
                  ))}
                </span>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-52 flex-1">
              <Field label="Buscar">
                <Input
                  value={filters.q}
                  placeholder="nome, telefone, nota ou texto da conversa"
                  onChange={(e) => setFilters({ ...filters, q: e.target.value })}
                />
              </Field>
            </div>
            {view !== 'kanban' && (
              <div className="w-44">
                <Field label="Etapa">
                  <Select
                    value={filters.stage}
                    onChange={(e) => setFilters({ ...filters, stage: e.target.value })}
                  >
                    <option value="">Todas</option>
                    {CRM_STAGES.map((s) => (
                      <option key={s} value={s}>
                        {CRM_STAGE_LABEL[s]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            <div className="pb-1.5">
              <Toggle
                checked={filters.onlyAttributed}
                onChange={(v) => setFilters({ ...filters, onlyAttributed: v })}
                label="Só vindas de anúncio"
              />
            </div>
            <div className="pb-1.5">
              <Toggle checked={live} onChange={toggleLive} label="Atualizar sozinho" />
            </div>
            <div className="pb-1">
              <Button size="sm" onClick={() => void refresh()}>
                atualizar
              </Button>
            </div>
          </div>

          {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
        </div>
      </Card>

      {view === 'kanban' && <Kanban rows={rows} onMove={move} onOpen={setSelectedId} />}

      {view === 'lista' && (
        <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
          <Card title={`${rows.length} conversa(s)`}>
            <Lista rows={rows} selectedId={selectedId} onOpen={setSelectedId} />
          </Card>
          <Card title="Detalhe da conversa">
            {selectedId ? (
              <ContactPanel contactId={selectedId} onChanged={refresh} liveTick={liveTick} />
            ) : (
              <Empty>Selecione uma conversa.</Empty>
            )}
          </Card>
        </div>
      )}

      {view === 'inbox' && (
        <Inbox
          rows={rows}
          selectedId={selectedId}
          onOpen={setSelectedId}
          onChanged={refresh}
          liveTick={liveTick}
        />
      )}

      {/* no kanban o detalhe abre sobreposto: as colunas já ocupam a largura toda */}
      {view === 'kanban' && selectedId !== null && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/60 p-4"
          onClick={() => setSelectedId(null)}
        >
          <div
            className="max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-ink-800 bg-ink-900 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <ContactPanel
              contactId={selectedId}
              onChanged={refresh}
              liveTick={liveTick}
              onClose={() => setSelectedId(null)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
