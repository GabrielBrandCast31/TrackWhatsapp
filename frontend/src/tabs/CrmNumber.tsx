import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  api,
  crmApi,
  CRM_STAGES,
  CRM_STAGE_LABEL,
  OBJECTIVE_EVENT,
  rulesApi,
  type CampaignGroup,
  type CampaignOverview,
  type CrmContact,
  type CrmContactDetail,
  type CrmPipeline,
  type CrmStage,
  type LeadSource,
  type RuleCatalog,
} from '../api'
import { ChannelIcon, ObjectiveChip, SourceDetails, SourceTag } from '../LeadSource'
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
  Select,
  Textarea,
  Toggle,
  money,
  when,
} from '../ui'

type View = 'conversas' | 'kanban' | 'lista'

const VIEWS: { id: View; label: string }[] = [
  { id: 'conversas', label: 'Conversas' },
  { id: 'kanban', label: 'Kanban' },
  { id: 'lista', label: 'Lista' },
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
const VIEW_KEY = 'wa.crmView'
const SUMMARY_KEY = 'wa.crmSummary'

/** Ligado por padrão: quem abre o CRM quer ver a conversa acontecendo. */
function readLive(): boolean {
  try {
    return localStorage.getItem(LIVE_KEY) !== '0'
  } catch {
    return true
  }
}

/** Nas conversas o resumo começa recolhido: o chat precisa caber na tela. */
function readSummary(): boolean {
  try {
    return localStorage.getItem(SUMMARY_KEY) === '1'
  } catch {
    return false
  }
}

function readView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'kanban' || v === 'lista' ? v : 'conversas'
  } catch {
    return 'conversas'
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // navegador sem storage: a preferência vale só pra sessão atual
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
  if (!iso) return ''
  const date = new Date(iso)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  }
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Ontem'
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function dayLabel(iso: string) {
  const date = new Date(iso)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return 'Hoje'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Ontem'
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
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
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-chat-hover font-semibold text-chat-muted"
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.32) }}
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
  if (origin === 'simulado') return <Badge tone="warn">simulado</Badge>
  return null
}

/** Mídia chega como `[imageMessage]`: vira o rótulo que o WhatsApp mostraria. */
const MEDIA_LABEL: Record<string, string> = {
  imageMessage: '📷 Foto',
  videoMessage: '🎥 Vídeo',
  audioMessage: '🎤 Áudio',
  pttMessage: '🎤 Áudio',
  documentMessage: '📄 Documento',
  documentWithCaptionMessage: '📄 Documento',
  stickerMessage: 'Figurinha',
  locationMessage: '📍 Localização',
  liveLocationMessage: '📍 Localização em tempo real',
  contactMessage: '👤 Contato',
  contactsArrayMessage: '👤 Contatos',
  reactionMessage: 'Reação',
  pollCreationMessage: '📊 Enquete',
}

function preview(text: string | null, type?: string | null) {
  if (!text) return type ? MEDIA_LABEL[type] ?? `[${type}]` : null
  const media = /^\[(\w+)\]$/.exec(text.trim())
  return media ? MEDIA_LABEL[media[1]] ?? text : text
}

/** Filtro de origem: um canal inteiro (`ch:`) ou uma campanha específica (`k:`). */
function matchesSource(source: LeadSource, filter: string) {
  if (!filter) return true
  if (filter.startsWith('ch:')) return source.channel === filter.slice(3)
  return source.key === filter.slice(2)
}

/* -------------------------------------------------------------------------- */
/*  detalhe da conversa — peças que as três visualizações compartilham        */
/* -------------------------------------------------------------------------- */

/** Carrega a conversa, relê a cada mudança no servidor e marca como lida. */
function useContactDetail(contactId: number, liveTick: number, onChanged: () => Promise<void>) {
  const [detail, setDetail] = useState<CrmContactDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setDetail(await crmApi.contact(contactId))
  }, [contactId])

  useEffect(() => {
    setDetail(null)
    setError(null)
    void load().catch((e) => setError((e as Error).message))
  }, [load])

  useEffect(() => {
    if (liveTick === 0) return
    void load().catch(() => {
      // a lista já avisa quando o servidor some; aqui o silêncio é melhor que um
      // banner piscando a cada batida
    })
  }, [liveTick, load])

  // conversa aberta fica lida: ao abrir e a cada mensagem que chegar com ela na tela
  useEffect(() => {
    if (detail && detail.unread_count > 0) {
      void crmApi.patch(contactId, { mark_read: true }).then(() => onChanged())
    }
  }, [detail?.id, detail?.unread_count])

  return { detail, load, error }
}

let catalogCache: Promise<RuleCatalog> | null = null
function useEventCatalog() {
  const [events, setEvents] = useState<RuleCatalog['events']>([])
  useEffect(() => {
    catalogCache ??= rulesApi.catalog()
    catalogCache.then((c) => setEvents(c.events.filter((e) => e.name !== OBJECTIVE_EVENT))).catch(() => {
      catalogCache = null
    })
  }, [])
  return events
}

function StagePills({ detail, onChanged }: { detail: CrmContact; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex flex-wrap gap-1.5">
      {CRM_STAGES.map((s) => (
        <button
          key={s}
          type="button"
          disabled={busy}
          onClick={async () => {
            if (s === detail.stage) return
            setBusy(true)
            try {
              await crmApi.patch(detail.id, { stage: s })
              await onChanged()
            } finally {
              setBusy(false)
            }
          }}
          className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
            s === detail.stage
              ? 'border-wa-500 bg-wa-500 font-semibold text-ink-950'
              : 'border-ink-700 text-ink-300 hover:border-ink-500 hover:text-ink-100'
          }`}
        >
          {CRM_STAGE_LABEL[s]}
        </button>
      ))}
    </div>
  )
}

function NoteBox({ detail, onSaved }: { detail: CrmContactDetail; onSaved: () => Promise<void> }) {
  const [note, setNote] = useState(detail.note ?? '')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const base = useRef(detail.note ?? '')

  useEffect(() => {
    setNote(detail.note ?? '')
    base.current = detail.note ?? ''
  }, [detail.id])

  // releitura de fundo não pisa na nota que está sendo digitada
  useEffect(() => {
    const incoming = detail.note ?? ''
    setNote((cur) => (cur === base.current ? incoming : cur))
    base.current = incoming
  }, [detail.note])

  return (
    <div className="space-y-2">
      <Textarea
        rows={2}
        value={note}
        placeholder="Só aparece aqui. Nada é enviado para o cliente."
        onChange={(e) => {
          setNote(e.target.value)
          setSaved(false)
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={busy || note === (detail.note ?? '')}
          onClick={async () => {
            setBusy(true)
            try {
              await crmApi.patch(detail.id, { note })
              await onSaved()
              setSaved(true)
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'salvando…' : 'Salvar nota'}
        </Button>
        {saved && <span className="text-[11px] text-wa-500">nota salva</span>}
      </div>
    </div>
  )
}

/** Disparo manual. O padrão é "pelo objetivo": o backend escolhe o evento que a
 *  campanha do lead pede (Cadastros → Lead, Vendas → Purchase…) na hora do envio. */
function FireBox({ contact, onFired }: { contact: CrmContactDetail; onFired: () => Promise<void> }) {
  const src = contact.source
  const events = useEventCatalog()
  const [mode, setMode] = useState<'objective' | 'custom'>('objective')
  const [eventName, setEventName] = useState(src.suggested_event)
  const [value, setValue] = useState('')
  const [isTest, setIsTest] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  useEffect(() => {
    setEventName(src.suggested_event)
  }, [contact.id, src.suggested_event])

  const effective = mode === 'objective' ? src.suggested_event : eventName
  const needsValue = effective === 'Purchase' && value === ''

  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-lg border border-ink-700 bg-ink-950 p-0.5">
        {(
          [
            ['objective', 'Pelo objetivo da campanha'],
            ['custom', 'Escolher evento'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            className={`flex-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
              mode === id ? 'bg-ink-800 font-medium text-ink-100' : 'text-ink-500 hover:text-ink-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'objective' ? (
        <div className="rounded-lg border border-wa-500/25 bg-wa-900/20 px-3 py-2">
          <p className="text-xs text-ink-100">
            Vai sair <strong className="font-mono text-wa-500">{src.suggested_event}</strong>
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-ink-500">
            {src.objective_label
              ? `Campanha “${src.campaign_name ?? src.ad_id}” com objetivo ${src.objective_label}.`
              : `${src.suggested_reason[0].toUpperCase()}${src.suggested_reason.slice(1)}.`}
          </p>
        </div>
      ) : (
        <Field label="Evento">
          <Select value={eventName} onChange={(e) => setEventName(e.target.value)}>
            {!events.some((e) => e.name === eventName) && <option value={eventName}>{eventName}</option>}
            {events.map((e) => (
              <option key={e.name} value={e.name}>
                {e.label}
                {e.name === src.suggested_event ? ' — sugerido' : ''}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <Field label="Valor (opcional)">
          <Input type="number" placeholder="0,00" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <div className="pb-2">
          <Toggle checked={isTest} onChange={setIsTest} label="Teste" />
        </div>
      </div>

      {!contact.attributable_meta && (
        <Banner tone="warn">
          Conversa sem <code className="font-mono">ctwa_clid</code>: o Meta não consegue ligar esse evento a
          nenhuma campanha. Serve para conferir o payload, não para otimizar.
        </Banner>
      )}
      {needsValue && (
        <Banner tone="warn">Purchase sem valor não alimenta a otimização por valor da campanha de Vendas.</Banner>
      )}
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <Button
        full
        variant="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setMsg(null)
          try {
            const conv = await api.fire({
              contact_id: contact.id,
              event_name: mode === 'objective' ? OBJECTIVE_EVENT : eventName,
              value: value === '' ? null : Number(value),
              is_test: isTest,
              destinations: ['meta_capi'],
            })
            const failed = conv.dispatches.filter((d) => d.status === 'error')
            setMsg(
              failed.length
                ? { tone: 'bad', text: failed[0].error ?? 'O destino recusou o evento.' }
                : { tone: 'good', text: `${conv.event_name} enviado (conversão #${conv.id}).` },
            )
            await onFired()
          } catch (e) {
            setMsg({ tone: 'bad', text: (e as Error).message })
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'enviando…' : `Disparar ${effective}${isTest ? ' (teste)' : ''}`}
      </Button>

      {contact.conversion_events.length > 0 && (
        <ul className="space-y-1.5 border-t border-ink-800 pt-3">
          {contact.conversion_events.map((c) => {
            const failed = c.dispatches.some((d) => d.status === 'error')
            return (
              <li key={c.id} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Badge tone={failed ? 'bad' : 'good'}>{c.event_name}</Badge>
                  {c.value !== null && <span className="text-ink-300">{money(c.value, c.currency)}</span>}
                  {c.is_test && <span className="text-amber-300">teste</span>}
                  <span className="truncate text-ink-500">
                    {c.source === 'rule' ? 'palavra-chave' : c.source === 'auto' ? 'automático' : 'manual'}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-ink-500">{shortTime(c.created_at)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

type Pending = { key: number; text: string }

/** A conversa em bolhas, como no WhatsApp: separador por dia, bolha do cliente à
 *  esquerda, do atendente à direita, e o anúncio de origem no topo. */
function ChatThread({ detail, pending = [] }: { detail: CrmContactDetail; pending?: Pending[] }) {
  const src = detail.source
  const messages = detail.messages

  return (
    <div className="flex flex-col gap-0.5 px-[4%] py-3">
      {src.channel === 'meta_ads' && (
        <div className="mx-auto mb-3 max-w-md rounded-lg bg-chat-header/90 px-3 py-2 text-center text-[11.5px] leading-snug text-chat-muted shadow">
          <span className="inline-flex items-center gap-1 font-medium text-chat-text">
            <ChannelIcon source={src} /> Conversa iniciada por anúncio{src.platform_label ? ` no ${src.platform_label}` : ''}
          </span>
          {src.campaign_name && <span className="block">Campanha: {src.campaign_name}</span>}
          {src.ad_headline && <span className="block italic">“{src.ad_headline}”</span>}
        </div>
      )}

      {messages.length === 0 && pending.length === 0 && (
        <div className="mx-auto my-6 max-w-sm rounded-lg bg-chat-header/90 px-3 py-2 text-center text-xs text-chat-muted">
          Nenhuma mensagem guardada. Use <em>puxar histórico</em> para buscar essa conversa na Evolution.
        </div>
      )}

      {messages.map((m, i) => {
        const out = m.direction === 'out'
        const prev = messages[i - 1]
        const newDay = !prev || new Date(prev.sent_at).toDateString() !== new Date(m.sent_at).toDateString()
        const first = newDay || !prev || prev.direction !== m.direction
        const body = preview(m.body, m.type)
        const isMedia = !m.body || /^\[\w+\]$/.test(m.body.trim())
        return (
          <div key={m.id} className="contents">
            {newDay && (
              <div className="my-2 flex justify-center">
                <span className="rounded-md bg-chat-header px-2.5 py-1 text-[11px] uppercase tracking-wide text-chat-muted shadow">
                  {dayLabel(m.sent_at)}
                </span>
              </div>
            )}
            <div className={`flex ${out ? 'justify-end' : 'justify-start'} ${first ? 'mt-1.5' : ''}`}>
              <div
                className={`relative max-w-[78%] rounded-lg px-2.5 pb-1.5 pt-1.5 text-[13.5px] leading-snug text-chat-text shadow-sm sm:max-w-[65%] ${
                  out ? 'bg-chat-out' : 'bg-chat-in'
                } ${first ? (out ? 'rounded-tr-none' : 'rounded-tl-none') : ''}`}
              >
                {first && (
                  // o "rabinho" da bolha, só na primeira de cada sequência
                  <span
                    aria-hidden
                    className={`absolute top-0 h-2.5 w-2 ${out ? '-right-2 bg-chat-out' : '-left-2 bg-chat-in'}`}
                    style={{ clipPath: out ? 'polygon(0 0, 100% 0, 0 100%)' : 'polygon(0 0, 100% 0, 100% 100%)' }}
                  />
                )}
                <p className={`whitespace-pre-wrap break-words ${isMedia ? 'italic text-chat-muted' : ''}`}>
                  {body}
                  {/* reserva o espaço da hora na última linha, como o WhatsApp faz */}
                  <span className={`inline-block ${m.has_payload !== false ? 'w-24' : 'w-12'}`} />
                </p>
                <div className="-mt-3.5 flex flex-wrap items-center justify-end gap-2 text-[10.5px] text-chat-muted">
                  {m.has_payload !== false && <MessagePayloadToggle messageId={m.id} />}
                  <span title={when(m.sent_at)}>{clock(m.sent_at)}</span>
                </div>
              </div>
            </div>
          </div>
        )
      })}

      {pending.map((p) => (
        <div key={p.key} className="mt-1.5 flex justify-end">
          <div className="max-w-[78%] rounded-lg rounded-tr-none bg-chat-out/60 px-2.5 py-1.5 text-[13.5px] leading-snug text-chat-text sm:max-w-[65%]">
            <p className="whitespace-pre-wrap break-words">{p.text}</p>
            <p className="text-right text-[10.5px] text-chat-muted">enviando…</p>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Caixa de resposta: Enter envia, Shift+Enter quebra linha. */
function Composer({
  contactId,
  onSent,
  onError,
}: {
  contactId: number
  onSent: (text: string) => void
  onError: (text: string) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setText('')
  }, [contactId])

  // cresce com o texto até ~6 linhas, como o campo do WhatsApp
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`
  }, [text])

  const send = async () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      await crmApi.reply(contactId, body)
      setText('')
      onSent(body)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
      ref.current?.focus()
    }
  }

  return (
    <div className="flex items-end gap-2 bg-chat-header px-3 py-2.5">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={busy}
        placeholder="Digite uma mensagem"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
        className="max-h-[132px] min-h-[40px] flex-1 resize-none rounded-lg bg-chat-hover px-3.5 py-2.5 text-sm leading-snug text-chat-text placeholder:text-chat-muted focus:outline-none"
      />
      <button
        type="button"
        onClick={() => void send()}
        disabled={busy || !text.trim()}
        title="Enviar (Enter)"
        aria-label="Enviar"
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-wa-500 text-ink-950 transition-opacity disabled:opacity-40"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
          <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z" />
        </svg>
      </button>
    </div>
  )
}

/** Mensagem enviada só aparece quando a Evolution devolve o SEND_MESSAGE pelo
 *  webhook. Até lá ela fica "enviando…" na conversa — some quando chega de
 *  verdade (ou depois de alguns segundos, se a entrega atrasar). */
function usePending(detail: CrmContactDetail | null, reload: () => Promise<void>) {
  const [pending, setPending] = useState<Pending[]>([])
  const count = detail?.messages.length ?? 0

  useEffect(() => {
    setPending([])
  }, [detail?.id, count])

  const add = (text: string) => {
    const key = Date.now()
    setPending((p) => [...p, { key, text }])
    window.setTimeout(() => void reload(), 1500)
    window.setTimeout(() => setPending((p) => p.filter((x) => x.key !== key)), 12000)
  }
  return { pending, add }
}

function useStickToBottom(dep: unknown, resetKey: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const seen = useRef<unknown>(null)
  useEffect(() => {
    seen.current = null
  }, [resetKey])
  useEffect(() => {
    if (dep === seen.current) return
    seen.current = dep
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}

function HistoryButton({ contactId, onDone }: { contactId: number; onDone: (msg: string, ok: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      disabled={busy}
      title="Buscar o histórico dessa conversa na Evolution"
      onClick={async () => {
        setBusy(true)
        try {
          const r = await crmApi.syncMessages(contactId)
          onDone(
            r.saved
              ? `${r.saved} mensagem(ns) trazida(s) da Evolution.`
              : 'A Evolution não devolveu mensagem nova para essa conversa.',
            r.saved > 0,
          )
        } catch (e) {
          onDone((e as Error).message, false)
        } finally {
          setBusy(false)
        }
      }}
      className="rounded-md px-2 py-1 text-[11px] text-chat-muted transition-colors hover:bg-chat-hover hover:text-chat-text disabled:opacity-50"
    >
      {busy ? 'puxando…' : 'puxar histórico'}
    </button>
  )
}

function Section({ title, info, children }: { title: string; info?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5 border-t border-ink-800 px-4 py-4 first:border-t-0">
      <div className="flex items-center gap-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">{title}</h3>
        {info && <Info text={info} />}
      </div>
      {children}
    </section>
  )
}

/** Tudo que não é a conversa: etapa, origem, disparo e nota. */
function ContactInfo({
  detail,
  numberId,
  reload,
  onChanged,
}: {
  detail: CrmContactDetail
  numberId?: number
  reload: () => Promise<void>
  onChanged: () => Promise<void>
}) {
  const refresh = async () => {
    await reload()
    await onChanged()
  }
  return (
    <>
      <Section title="Etapa">
        <StagePills detail={detail} onChanged={refresh} />
      </Section>
      <Section
        title="De onde veio"
        info="Canal, campanha, conjunto e anúncio do lead. O nome da campanha e o objetivo vêm da Marketing API do Meta pelo ID do anúncio."
      >
        <SourceDetails
          source={detail.source}
          ctwaClid={detail.attribution.ctwa_clid}
          sourceUrl={detail.attribution.source_url}
          numberId={numberId ?? detail.wa_number_id ?? undefined}
          onChanged={refresh}
        />
      </Section>
      <Section
        title="Disparar conversão"
        info="Pelo objetivo: o evento sai de acordo com o objetivo da campanha do lead. Dá para escolher outro evento à mão."
      >
        <FireBox contact={detail} onFired={refresh} />
      </Section>
      <Section title="Nota interna">
        <NoteBox detail={detail} onSaved={reload} />
      </Section>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  visualização 1: conversas (estilo WhatsApp)                                */
/* -------------------------------------------------------------------------- */

type Chip = 'all' | 'unread' | 'ads' | 'won'

const CHIPS: { id: Chip; label: string }[] = [
  { id: 'all', label: 'Tudo' },
  { id: 'unread', label: 'Não lidas' },
  { id: 'ads', label: 'Anúncios' },
  { id: 'won', label: 'Ganhos' },
]

function ConversationItem({ c, active, onOpen }: { c: CrmContact; active: boolean; onOpen: () => void }) {
  const unread = c.unread_count > 0
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full items-center gap-3 px-3 text-left transition-colors ${
        active ? 'bg-chat-hover' : 'hover:bg-chat-header'
      }`}
    >
      <Avatar c={c} size={46} />
      <div className="min-w-0 flex-1 border-b border-chat-line py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] text-chat-text">{who(c)}</span>
          <span className={`shrink-0 text-[11px] ${unread ? 'font-medium text-wa-500' : 'text-chat-muted'}`}>
            {shortTime(c.last_message_at)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-[13px] text-chat-muted">
            {c.last_message_from_me && <span className="text-chat-muted/80">Você: </span>}
            {preview(c.last_message_body) ?? <em>sem mensagem</em>}
          </p>
          {unread && (
            <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-wa-500 px-1.5 text-[11px] font-semibold text-ink-950">
              {c.unread_count}
            </span>
          )}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <SourceTag source={c.source} compact />
          <span className="shrink-0 text-[10px] text-chat-muted">{CRM_STAGE_LABEL[c.stage]}</span>
        </div>
      </div>
    </button>
  )
}

function ChatWindow({
  contactId,
  numberId,
  liveTick,
  onChanged,
  onBack,
}: {
  contactId: number
  numberId?: number
  liveTick: number
  onChanged: () => Promise<void>
  onBack: () => void
}) {
  const { detail, load, error } = useContactDetail(contactId, liveTick, onChanged)
  const { pending, add } = usePending(detail, load)
  const [info, setInfo] = useState(() => window.matchMedia?.('(min-width: 1280px)').matches ?? false)
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null)
  const scroller = useStickToBottom((detail?.messages.length ?? 0) + pending.length, contactId)

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(t)
  }, [toast])

  if (error) return <div className="grid flex-1 place-items-center p-6 text-sm text-red-300">{error}</div>
  if (!detail) return <div className="grid flex-1 place-items-center text-sm text-chat-muted">carregando conversa…</div>

  return (
    <div className="relative flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[60px] shrink-0 items-center gap-3 bg-chat-header px-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Voltar para as conversas"
            className="grid h-8 w-8 place-items-center rounded-full text-chat-muted hover:bg-chat-hover md:hidden"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <button type="button" onClick={() => setInfo((v) => !v)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
            <Avatar c={detail} size={40} />
            <div className="min-w-0">
              <p className="truncate text-[15px] text-chat-text">{who(detail)}</p>
              <p className="truncate text-[12px] text-chat-muted">
                {phoneLabel(detail)} · {CRM_STAGE_LABEL[detail.stage]}
              </p>
            </div>
          </button>
          <div className="hidden min-w-0 max-w-[40%] items-center gap-1.5 lg:flex">
            <SourceTag source={detail.source} />
          </div>
          <HistoryButton
            contactId={detail.id}
            onDone={(text, ok) => {
              setToast({ text, ok })
              void load()
            }}
          />
          <button
            type="button"
            onClick={() => setInfo((v) => !v)}
            title="Dados do contato"
            aria-label="Dados do contato"
            className={`grid h-9 w-9 place-items-center rounded-full transition-colors ${
              info ? 'bg-chat-hover text-chat-text' : 'text-chat-muted hover:bg-chat-hover'
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5M12 8h.01" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div ref={scroller} className="wa-wallpaper min-h-0 flex-1 overflow-y-auto">
          <ChatThread detail={detail} pending={pending} />
        </div>

        {toast && (
          <div
            className={`px-4 py-1.5 text-center text-[11px] ${
              toast.ok ? 'bg-wa-900/60 text-wa-500' : 'bg-red-950/70 text-red-300'
            }`}
          >
            {toast.text}
          </div>
        )}
        <Composer contactId={detail.id} onSent={add} onError={(text) => setToast({ text, ok: false })} />
      </div>

      {info && (
        <aside className="absolute inset-0 z-10 flex flex-col border-l border-chat-line bg-ink-900 xl:static xl:w-[360px] xl:shrink-0">
          <header className="flex h-[60px] shrink-0 items-center gap-3 bg-chat-header px-4">
            <button
              type="button"
              onClick={() => setInfo(false)}
              aria-label="Fechar dados do contato"
              className="grid h-8 w-8 place-items-center rounded-full text-chat-muted hover:bg-chat-hover"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
            <span className="text-[15px] text-chat-text">Dados do contato</span>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col items-center gap-1 px-4 pb-4 pt-5 text-center">
              <Avatar c={detail} size={88} />
              <p className="mt-2 text-base font-medium text-ink-100">{who(detail)}</p>
              <p className="font-mono text-xs text-ink-500">{phoneLabel(detail)}</p>
              <div className="mt-1 flex flex-wrap justify-center gap-1">
                <OriginBadge origin={detail.origin} />
                {detail.conversions > 0 && <Badge tone="info">{detail.conversions} conv.</Badge>}
              </div>
            </div>
            <ContactInfo detail={detail} numberId={numberId} reload={load} onChanged={onChanged} />
          </div>
        </aside>
      )}
    </div>
  )
}

function Conversas({
  rows,
  selectedId,
  onOpen,
  onChanged,
  liveTick,
  numberId,
  q,
  setQ,
  sourceFilter,
  setSourceFilter,
  overview,
}: {
  rows: CrmContact[]
  selectedId: number | null
  onOpen: (id: number | null) => void
  onChanged: () => Promise<void>
  liveTick: number
  numberId?: number
  q: string
  setQ: (q: string) => void
  sourceFilter: string
  setSourceFilter: (v: string) => void
  overview: CampaignOverview | null
}) {
  const [chip, setChip] = useState<Chip>('all')
  const shown = rows.filter((c) => {
    if (chip === 'unread') return c.unread_count > 0
    if (chip === 'ads') return c.source.channel === 'meta_ads' || c.source.channel === 'google_ads'
    if (chip === 'won') return c.stage === 'ganho'
    return true
  })

  return (
    <div className="flex h-[max(560px,calc(100dvh-250px))] overflow-hidden rounded-xl border border-chat-line bg-chat-panel">
      <div
        className={`w-full shrink-0 flex-col border-r border-chat-line md:flex md:w-[340px] lg:w-[380px] ${
          selectedId ? 'hidden' : 'flex'
        }`}
      >
        <div className="space-y-2 px-3 pb-2 pt-3">
          <div className="flex items-center gap-2 rounded-lg bg-chat-header px-3">
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-chat-muted" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Pesquisar nome, telefone ou mensagem"
              className="h-9 w-full bg-transparent text-sm text-chat-text placeholder:text-chat-muted focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {CHIPS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setChip(c.id)}
                className={`rounded-full px-3 py-1 text-[12px] transition-colors ${
                  chip === c.id ? 'bg-wa-900 text-wa-500' : 'bg-chat-header text-chat-muted hover:text-chat-text'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <SourceSelect value={sourceFilter} onChange={setSourceFilter} overview={overview} dark />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {shown.length === 0 ? (
            <p className="px-4 py-10 text-center text-xs text-chat-muted">Nenhuma conversa com esses filtros.</p>
          ) : (
            shown.map((c) => (
              <ConversationItem key={c.id} c={c} active={selectedId === c.id} onOpen={() => onOpen(c.id)} />
            ))
          )}
        </div>
      </div>

      <div className={`min-w-0 flex-1 md:flex ${selectedId ? 'flex' : 'hidden'}`}>
        {selectedId ? (
          <ChatWindow
            key={selectedId}
            contactId={selectedId}
            numberId={numberId}
            liveTick={liveTick}
            onChanged={onChanged}
            onBack={() => onOpen(null)}
          />
        ) : (
          <div className="wa-wallpaper flex flex-1 flex-col items-center justify-center gap-3 border-b-[6px] border-wa-600 px-6 text-center">
            <span className="grid h-16 w-16 place-items-center rounded-full bg-chat-header text-wa-500">
              <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M4 20l1.3-3.9A8 8 0 1 1 8 19.2L4 20Z" strokeLinejoin="round" />
              </svg>
            </span>
            <p className="text-2xl font-light text-chat-text">Conversion Tracker</p>
            <p className="max-w-sm text-sm leading-relaxed text-chat-muted">
              Escolha uma conversa para responder, ver de qual campanha o lead veio e disparar a conversão pelo
              objetivo da campanha.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  painel lateral — kanban (sobreposto) e lista                               */
/* -------------------------------------------------------------------------- */

function ContactPanel({
  contactId,
  numberId,
  onChanged,
  onClose,
  liveTick = 0,
}: {
  contactId: number
  numberId?: number
  onChanged: () => Promise<void>
  onClose?: () => void
  /** Sobe a cada mudança detectada no servidor: é o gatilho de releitura desta conversa. */
  liveTick?: number
}) {
  const { detail, load, error } = useContactDetail(contactId, liveTick, onChanged)
  const { pending, add } = usePending(detail, load)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const scroller = useStickToBottom((detail?.messages.length ?? 0) + pending.length, contactId)

  if (error) return <Banner tone="bad">{error}</Banner>
  if (!detail) return <p className="text-sm text-ink-500">carregando conversa…</p>

  return (
    <div className="-m-5">
      <div className="flex items-center gap-3 bg-chat-header px-4 py-3">
        <Avatar c={detail} size={44} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink-100">{who(detail)}</p>
          <p className="font-mono text-[11px] text-ink-500">{phoneLabel(detail)}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <SourceTag source={detail.source} />
            <OriginBadge origin={detail.origin} />
          </div>
        </div>
        {onClose && (
          <Button size="sm" onClick={onClose}>
            fechar
          </Button>
        )}
      </div>

      <div className="border-b border-chat-line">
        <div className="flex items-center justify-between bg-chat-panel px-3 py-1.5">
          <span className="text-[11px] text-chat-muted">Conversa ({detail.messages.length})</span>
          <HistoryButton
            contactId={detail.id}
            onDone={(text, ok) => {
              setMsg({ tone: ok ? 'good' : 'bad', text })
              void load()
            }}
          />
        </div>
        <div ref={scroller} className="wa-wallpaper max-h-[42vh] min-h-40 overflow-y-auto">
          <ChatThread detail={detail} pending={pending} />
        </div>
        {msg && (
          <div className="px-3 py-2">
            <Banner tone={msg.tone}>{msg.text}</Banner>
          </div>
        )}
        <Composer contactId={detail.id} onSent={add} onError={(text) => setMsg({ tone: 'bad', text })} />
      </div>

      <ContactInfo detail={detail} numberId={numberId} reload={load} onChanged={onChanged} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  visualização 2: kanban                                                     */
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
            className={`w-[284px] shrink-0 rounded-xl border bg-ink-900 p-2.5 transition-colors ${
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
                  className="w-full cursor-grab space-y-2 rounded-lg border border-ink-800 bg-ink-950 p-2.5 text-left transition-colors hover:border-ink-700 active:cursor-grabbing"
                >
                  {/* a etiqueta "de onde veio" vem primeiro: é o que se procura no funil */}
                  <SourceTag source={c.source} full />
                  <div className="flex items-center gap-2">
                    <Avatar c={c} size={28} />
                    <span className="flex-1 truncate text-xs font-medium text-ink-100">{who(c)}</span>
                    {c.unread_count > 0 && (
                      <span className="grid h-4 min-w-4 place-items-center rounded-full bg-wa-500 px-1 text-[10px] font-semibold text-ink-950">
                        {c.unread_count}
                      </span>
                    )}
                  </div>
                  <p className="line-clamp-2 text-[11px] leading-snug text-ink-500">
                    {c.last_message_from_me ? 'você: ' : ''}
                    {preview(c.last_message_body) ?? 'sem mensagem'}
                  </p>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-1">
                      <ObjectiveChip source={c.source} />
                      {c.conversions > 0 && <Badge tone="info">{c.conversions} conv.</Badge>}
                      {c.source.channel !== 'simulado' && <OriginBadge origin={c.origin} />}
                    </div>
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
/*  visualização 3: lista                                                      */
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
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead>
          <tr className="border-b border-ink-800 text-[11px] uppercase tracking-wide text-ink-500">
            <th className="px-2 py-2 font-medium">Contato</th>
            <th className="px-2 py-2 font-medium">Etapa</th>
            <th className="px-2 py-2 font-medium">Origem / campanha</th>
            <th className="px-2 py-2 font-medium">Última mensagem</th>
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
              <td className="max-w-[260px] px-2 py-2.5">
                <div className="flex flex-col items-start gap-1">
                  <SourceTag source={c.source} />
                  <ObjectiveChip source={c.source} />
                </div>
              </td>
              <td className="max-w-[240px] px-2 py-2.5">
                <p className="truncate text-xs text-ink-500">
                  {c.last_message_from_me ? 'você: ' : ''}
                  {preview(c.last_message_body) ?? '—'}
                </p>
              </td>
              <td className="px-2 py-2.5 text-right font-mono text-[11px] text-ink-500">
                {shortTime(c.last_message_at) || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  origem / campanha: filtro e resumo                                         */
/* -------------------------------------------------------------------------- */

const CHANNEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'ch:meta_ads', label: 'Anúncios do Meta (todos)' },
  { value: 'ch:google_ads', label: 'Google Ads' },
  { value: 'ch:utm', label: 'Links com UTM' },
  { value: 'ch:organic', label: 'Orgânico' },
  { value: 'ch:agenda', label: 'Agenda' },
]

function groupLabel(g: CampaignGroup) {
  return g.campaign_name ?? (g.channel === 'meta_ads' ? `${g.channel_label} · campanha pendente` : g.channel_label)
}

function SourceSelect({
  value,
  onChange,
  overview,
  dark,
}: {
  value: string
  onChange: (v: string) => void
  overview: CampaignOverview | null
  dark?: boolean
}) {
  const campaigns = (overview?.groups ?? []).filter((g) => g.campaign_name || g.channel === 'meta_ads')
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={
        dark
          ? 'h-8 w-full rounded-lg bg-chat-header px-2 text-[12px] text-chat-text focus:outline-none'
          : 'w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 focus:border-wa-500 focus:outline-none'
      }
    >
      <option value="">Todas as origens e campanhas</option>
      <optgroup label="Canal">
        {CHANNEL_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </optgroup>
      {campaigns.length > 0 && (
        <optgroup label="Campanha">
          {campaigns.map((g) => (
            <option key={g.key} value={`k:${g.key}`}>
              {groupLabel(g)} ({g.contacts})
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )
}

/** Leads por campanha — clicar filtra a tela por ela. */
function CampaignStrip({
  overview,
  value,
  onPick,
  numberId,
  onResolved,
}: {
  overview: CampaignOverview
  value: string
  onPick: (v: string) => void
  numberId?: number
  onResolved: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const groups = overview.groups
  const pending = groups.some((g) => g.channel === 'meta_ads' && !g.campaign_name)
  if (groups.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Leads por origem</span>
        <div className="flex items-center gap-2">
          {note && <span className="text-[11px] text-ink-500">{note}</span>}
          {overview.has_ads_token ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setNote(null)
                try {
                  const r = await crmApi.resolveCampaigns(numberId, !pending)
                  setNote(
                    r.errors.length
                      ? `${r.resolved}/${r.checked} resolvido(s) — ${r.errors[0]}`
                      : `${r.resolved} anúncio(s) resolvido(s)`,
                  )
                  await onResolved()
                } catch (e) {
                  setNote((e as Error).message)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? 'consultando…' : 'buscar campanhas no Meta'}
            </Button>
          ) : (
            pending && (
              <span className="text-[11px] text-amber-300" title="Rastreamento → Meta → Token de anúncios (ads_read)">
                cadastre o token de anúncios para ver o nome das campanhas
              </span>
            )
          )}
        </div>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {groups.slice(0, 16).map((g) => {
          const key = `k:${g.key}`
          const active = value === key
          return (
            <button
              key={g.key}
              type="button"
              onClick={() => onPick(active ? '' : key)}
              title={[
                g.channel_label,
                g.campaign_name && `Campanha: ${g.campaign_name}`,
                g.objective_label && `Objetivo: ${g.objective_label} → ${g.suggested_event}`,
                `${g.contacts} lead(s), ${g.with_conversion} com conversão, ${g.won} ganho(s)`,
              ]
                .filter(Boolean)
                .join('\n')}
              className={`flex min-w-[170px] max-w-[240px] shrink-0 flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                active ? 'border-wa-500 bg-wa-900/30' : 'border-ink-800 bg-ink-950 hover:border-ink-700'
              }`}
            >
              <span className="flex items-center gap-1.5 text-[10.5px] text-ink-500">
                <ChannelIcon source={g} />
                {g.channel_label}
                {g.objective_label && <span className="truncate">· {g.objective_label}</span>}
              </span>
              <span className={`truncate text-xs ${g.campaign_name ? 'font-medium text-ink-100' : 'italic text-ink-500'}`}>
                {g.campaign_name ?? (g.channel === 'meta_ads' ? 'campanha pendente' : 'sem campanha')}
              </span>
              <span className="flex items-baseline gap-2 text-[11px] text-ink-500">
                <strong className="text-sm text-ink-100">{g.contacts}</strong> lead(s)
                {g.with_conversion > 0 && <span className="text-wa-500">{g.with_conversion} conv.</span>}
                {g.won > 0 && <span className="text-sky-300">{g.won} ganho(s)</span>}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

export default function CrmNumber({ onChanged }: { onChanged: () => void }) {
  const { numberId, current, numbers, loading } = useNumber()
  const [view, setView] = useState<View>(readView)
  const [rows, setRows] = useState<CrmContact[]>([])
  const [pipe, setPipe] = useState<CrmPipeline | null>(null)
  const [overview, setOverview] = useState<CampaignOverview | null>(null)
  const [filters, setFilters] = useState({ q: '', stage: '', onlyAttributed: false, source: '' })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null)
  const [live, setLive] = useState(readLive)
  const [liveTick, setLiveTick] = useState(0)
  const [liveAt, setLiveAt] = useState<Date | null>(null)
  const [summaryOpen, setSummaryOpen] = useState(readSummary)
  const showSummary = view !== 'conversas' || summaryOpen

  const load = useCallback(async () => {
    const [list, pipeline, camp] = await Promise.all([
      crmApi.contacts({
        number_id: numberId,
        // no kanban a coluna já é o filtro de etapa; nas conversas, os chips
        stage: view === 'lista' ? filters.stage || undefined : undefined,
        q: filters.q.trim() || undefined,
        only_attributed: view !== 'conversas' && filters.onlyAttributed,
        order: view === 'lista' && filters.stage ? 'created' : 'last_message',
      }),
      crmApi.pipeline(numberId),
      crmApi.campaigns(numberId).catch(() => null),
    ])
    setRows(list)
    setPipe(pipeline)
    setOverview(camp)
  }, [numberId, view, filters.stage, filters.q, filters.onlyAttributed])

  useEffect(() => {
    void load().catch((e) => setMsg({ tone: 'bad', text: (e as Error).message }))
  }, [load])

  useEffect(() => {
    setSelectedId(null)
  }, [numberId])

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
    remember(LIVE_KEY, v ? '1' : '0')
  }

  const pickView = (v: View) => {
    setView(v)
    remember(VIEW_KEY, v)
    // no kanban a conversa abre sobreposta: levar a seleção junto cobriria a tela
    if (v === 'kanban') setSelectedId(null)
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

  const shown = useMemo(() => rows.filter((c) => matchesSource(c.source, filters.source)), [rows, filters.source])
  const setSource = (source: string) => setFilters((f) => ({ ...f, source }))

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
        subtitle="As conversas deste número, com a campanha de onde cada lead veio. Cada linha tem o seu CRM."
        actions={
          <>
            <div className="flex gap-1 rounded-lg border border-ink-700 bg-ink-850 p-0.5">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  onClick={() => pickView(v.id)}
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

          {pipe && view === 'conversas' && (
            <button
              type="button"
              onClick={() => {
                setSummaryOpen((v) => {
                  remember(SUMMARY_KEY, v ? '0' : '1')
                  return !v
                })
              }}
              className="flex w-full flex-wrap items-center gap-x-5 gap-y-1 text-left text-xs text-ink-500 hover:text-ink-300"
            >
              <span>
                <strong className="text-ink-100">{pipe.total}</strong> conversa(s)
              </span>
              <span>
                <strong className="text-wa-500">{pipe.attributed}</strong> de anúncio
              </span>
              <span>
                <strong className="text-ink-100">{pipe.unread}</strong> não lida(s)
              </span>
              <span className="ml-auto text-[11px] underline decoration-dotted underline-offset-2">
                {summaryOpen ? 'ocultar resumo' : 'ver funil e leads por campanha'}
              </span>
            </button>
          )}

          {pipe && showSummary && (
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
              <span className="flex flex-wrap items-center gap-1.5">
                {CRM_STAGES.map((s) => (
                  <Badge key={s} tone={STAGE_TONE[s]}>
                    {CRM_STAGE_LABEL[s]}: {pipe.stages[s]}
                  </Badge>
                ))}
              </span>
              <span className="flex items-center gap-2">
                <Toggle checked={live} onChange={toggleLive} label="Atualizar sozinho" />
              </span>
            </div>
          )}

          {overview && showSummary && (
            <CampaignStrip
              overview={overview}
              value={filters.source}
              onPick={setSource}
              numberId={numberId}
              onResolved={load}
            />
          )}

          {view !== 'conversas' && (
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
              <div className="w-64">
                <Field label="Origem / campanha">
                  <SourceSelect value={filters.source} onChange={setSource} overview={overview} />
                </Field>
              </div>
              {view === 'lista' && (
                <div className="w-44">
                  <Field label="Etapa">
                    <Select value={filters.stage} onChange={(e) => setFilters({ ...filters, stage: e.target.value })}>
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
              <div className="pb-1">
                <Button size="sm" onClick={() => void refresh()}>
                  atualizar
                </Button>
              </div>
            </div>
          )}

          {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
        </div>
      </Card>

      {view === 'conversas' && (
        <Conversas
          rows={shown}
          selectedId={selectedId}
          onOpen={setSelectedId}
          onChanged={refresh}
          liveTick={liveTick}
          numberId={numberId}
          q={filters.q}
          setQ={(q) => setFilters((f) => ({ ...f, q }))}
          sourceFilter={filters.source}
          setSourceFilter={setSource}
          overview={overview}
        />
      )}

      {view === 'kanban' && <Kanban rows={shown} onMove={move} onOpen={setSelectedId} />}

      {view === 'lista' && (
        <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
          <Card title={`${shown.length} conversa(s)`}>
            <Lista rows={shown} selectedId={selectedId} onOpen={setSelectedId} />
          </Card>
          <Card>
            {selectedId ? (
              <ContactPanel
                key={selectedId}
                contactId={selectedId}
                numberId={numberId}
                onChanged={refresh}
                liveTick={liveTick}
              />
            ) : (
              <Empty>Selecione uma conversa.</Empty>
            )}
          </Card>
        </div>
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
              key={selectedId}
              contactId={selectedId}
              numberId={numberId}
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
