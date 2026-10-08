import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  cloudLinesApi,
  crmApi,
  CRM_STAGES,
  CRM_STAGE_LABEL,
  type CampaignOverview,
  type CrmContact,
  type CrmContactDetail,
  type CrmPipeline,
  type CrmStage,
  type WaNumber,
} from '../api'
import { SourceTag } from '../LeadSource'
import { Badge, Banner, Button, Card, Empty, Field, Input, Select, Toggle } from '../ui'
import {
  Avatar,
  CampaignStrip,
  ChatThread,
  ContactInfo,
  ConversationItem,
  Kanban,
  Lista,
  LiveDot,
  OriginBadge,
  SourceSelect,
  matchesSource,
  phoneLabel,
  useContactDetail,
  useCrmLive,
  useStickToBottom,
  who,
} from './CrmNumber'

/** CRM das linhas da Cloud API (API oficial da Meta).
 *
 *  É uma tela à parte do CRM da Evolution de propósito: a Cloud API só entrega
 *  pelo webhook o que o cliente manda, não expõe a agenda nem o histórico do
 *  aparelho, e a resposta pelo CRM ainda não existe pra ela. O que funciona igual
 *  — origem/campanha, UTM, jornada do site, etapa, nota, disparo de conversão —
 *  vem dos mesmos endpoints e componentes do CRM da Evolution.
 */

type View = 'conversas' | 'kanban' | 'lista'

const VIEWS: { id: View; label: string }[] = [
  { id: 'conversas', label: 'Conversas' },
  { id: 'kanban', label: 'Kanban' },
  { id: 'lista', label: 'Lista' },
]

const STAGE_TONE: Record<CrmStage, 'neutral' | 'info' | 'warn' | 'good' | 'bad'> = {
  novo: 'neutral',
  mql: 'info',
  conversando: 'info',
  agendado: 'warn',
  compareceu: 'warn',
  fechado: 'good',
  perdido: 'bad',
}

const LINE_KEY = 'wa.crmCloudLine'
const VIEW_KEY = 'wa.crmCloudView'
const LIVE_KEY = 'wa.crmCloudLive'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // navegador sem storage: a preferência vale só pra sessão atual
  }
}

const LIMITS_TEXT =
  'Linha da Cloud API: aqui chegam só as mensagens do cliente. Responder pelo CRM, puxar histórico e importar a agenda ' +
  'não estão disponíveis — responda pela plataforma onde o número está conectado.'

/** Faixa no lugar da caixa de resposta: deixa claro por que não dá pra digitar. */
function ReplyUnavailable() {
  return (
    <div className="bg-chat-header px-4 py-2.5 text-center text-[11.5px] leading-snug text-chat-muted">
      Resposta pelo CRM indisponível na Cloud API. As mensagens enviadas pela plataforma do número também não aparecem
      aqui — a Meta só entrega pelo webhook o que o cliente manda.
    </div>
  )
}

function Thread({ detail }: { detail: CrmContactDetail }) {
  if (detail.messages.length === 0) {
    return (
      <div className="mx-auto my-6 max-w-sm rounded-lg bg-chat-header/90 px-3 py-2 text-center text-xs text-chat-muted">
        Nenhuma mensagem guardada para essa conversa.
      </div>
    )
  }
  return <ChatThread detail={detail} />
}

/* -------------------------------------------------------------------------- */
/*  conversa aberta                                                            */
/* -------------------------------------------------------------------------- */

function ChatWindow({
  contactId,
  numberId,
  liveTick,
  onChanged,
  onBack,
}: {
  contactId: number
  numberId: number
  liveTick: number
  onChanged: () => Promise<void>
  onBack: () => void
}) {
  const { detail, load, error } = useContactDetail(contactId, liveTick, onChanged)
  const [info, setInfo] = useState(() => window.matchMedia?.('(min-width: 1280px)').matches ?? false)
  const scroller = useStickToBottom(detail?.messages.length ?? 0, contactId)

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
          <Thread detail={detail} />
        </div>
        <ReplyUnavailable />
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

/** Detalhe usado pelo kanban (sobreposto) e pela lista (ao lado). */
function ContactPanel({
  contactId,
  numberId,
  onChanged,
  onClose,
  liveTick,
}: {
  contactId: number
  numberId: number
  onChanged: () => Promise<void>
  onClose?: () => void
  liveTick: number
}) {
  const { detail, load, error } = useContactDetail(contactId, liveTick, onChanged)
  const scroller = useStickToBottom(detail?.messages.length ?? 0, contactId)

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
        <div className="bg-chat-panel px-3 py-1.5">
          <span className="text-[11px] text-chat-muted">Conversa ({detail.messages.length})</span>
        </div>
        <div ref={scroller} className="wa-wallpaper max-h-[42vh] min-h-40 overflow-y-auto">
          <Thread detail={detail} />
        </div>
        <ReplyUnavailable />
      </div>

      <ContactInfo detail={detail} numberId={numberId} reload={load} onChanged={onChanged} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  visualização de conversas                                                  */
/* -------------------------------------------------------------------------- */

type Chip = 'all' | 'unread' | 'ads' | 'won'

const CHIPS: { id: Chip; label: string }[] = [
  { id: 'all', label: 'Tudo' },
  { id: 'unread', label: 'Não lidas' },
  { id: 'ads', label: 'Anúncios' },
  { id: 'won', label: 'Fechados' },
]

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
  numberId: number
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
    if (chip === 'won') return c.stage === 'fechado'
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
            <p className="text-2xl font-light text-chat-text">CRM da Cloud API</p>
            <p className="max-w-sm text-sm leading-relaxed text-chat-muted">
              Escolha uma conversa para ver de qual campanha o lead veio, as UTMs, a jornada no site e disparar a conversão
              pelo objetivo da campanha.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

export default function CrmCloud({ onChanged }: { onChanged: () => void }) {
  const [lines, setLines] = useState<WaNumber[] | null>(null)
  const [linesError, setLinesError] = useState<string | null>(null)
  const [numberId, setNumberIdState] = useState<number | undefined>(() => Number(read(LINE_KEY)) || undefined)
  const [view, setView] = useState<View>(() => {
    const v = read(VIEW_KEY)
    return v === 'kanban' || v === 'lista' ? v : 'conversas'
  })
  const [rows, setRows] = useState<CrmContact[]>([])
  const [pipe, setPipe] = useState<CrmPipeline | null>(null)
  const [overview, setOverview] = useState<CampaignOverview | null>(null)
  const [filters, setFilters] = useState({ q: '', stage: '', onlyAttributed: false, source: '' })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [live, setLive] = useState(() => read(LIVE_KEY) !== '0')
  const [liveTick, setLiveTick] = useState(0)
  const [liveAt, setLiveAt] = useState<Date | null>(null)

  useEffect(() => {
    cloudLinesApi
      .list()
      .then(setLines)
      .catch((e) => {
        setLines([])
        setLinesError((e as Error).message)
      })
  }, [])

  // linha apagada ou nunca escolhida: cai na primeira Cloud — nunca em "todas",
  // que misturaria as conversas das linhas da Evolution nesta tela
  const lineId = lines?.some((l) => l.id === numberId) ? numberId : lines?.[0]?.id
  const current = lines?.find((l) => l.id === lineId)

  const pickLine = (id: number) => {
    setNumberIdState(id)
    setSelectedId(null)
    remember(LINE_KEY, String(id))
  }

  const load = useCallback(async () => {
    if (lineId === undefined) return
    const [list, pipeline, camp] = await Promise.all([
      crmApi.contacts({
        number_id: lineId,
        stage: view === 'lista' ? filters.stage || undefined : undefined,
        q: filters.q.trim() || undefined,
        only_attributed: view !== 'conversas' && filters.onlyAttributed,
        order: view === 'lista' && filters.stage ? 'created' : 'last_message',
      }),
      crmApi.pipeline(lineId),
      crmApi.campaigns(lineId).catch(() => null),
    ])
    setRows(list)
    setPipe(pipeline)
    setOverview(camp)
  }, [lineId, view, filters.stage, filters.q, filters.onlyAttributed])

  useEffect(() => {
    void load().catch((e) => setMsg((e as Error).message))
  }, [load])

  const refresh = useCallback(async () => {
    await load()
    onChanged()
  }, [load, onChanged])

  useCrmLive(lineId, live && lineId !== undefined, () => {
    void load().catch(() => {
      // sem banner: a lista continua mostrando o último estado bom
    })
    onChanged()
    setLiveTick((n) => n + 1)
    setLiveAt(new Date())
  })

  const pickView = (v: View) => {
    setView(v)
    remember(VIEW_KEY, v)
    if (v === 'kanban') setSelectedId(null)
  }

  const move = async (id: number, stage: CrmStage) => {
    setRows((prev) => prev.map((c) => (c.id === id ? { ...c, stage } : c)))
    try {
      await crmApi.patch(id, { stage })
      await refresh()
    } catch (e) {
      setMsg((e as Error).message)
      await load()
    }
  }

  const shown = useMemo(() => rows.filter((c) => matchesSource(c.source, filters.source)), [rows, filters.source])
  const setSource = (source: string) => setFilters((f) => ({ ...f, source }))

  if (lines === null) return <p className="text-sm text-ink-500">carregando…</p>

  if (lineId === undefined) {
    return (
      <Empty>
        {linesError ?? (
          <>
            Nenhuma linha da Cloud API cadastrada. Cadastre o número na aba{' '}
            <strong className="text-ink-300">Conexão</strong>, na parte da Cloud API.
          </>
        )}
      </Empty>
    )
  }

  return (
    <div className="space-y-4">
      <Card
        title={`CRM Cloud API · ${current?.label ?? ''}`}
        subtitle="As conversas do número na API oficial da Meta, com a campanha, as UTMs e a jornada de onde cada lead veio."
        actions={
          <>
            <select
              value={lineId}
              onChange={(e) => pickLine(Number(e.target.value))}
              title="Linha da Cloud API"
              className="max-w-[220px] truncate rounded-lg border border-ink-700 bg-ink-850 px-2 py-1 text-xs text-ink-100 focus:outline-none"
            >
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                  {l.display_phone_number ? ` · ${l.display_phone_number}` : ''}
                  {l.active ? '' : ' (inativa)'}
                </option>
              ))}
            </select>
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
          </>
        }
      >
        <div className="space-y-4">
          <Banner tone="warn">{LIMITS_TEXT}</Banner>

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
              <span className="flex flex-wrap items-center gap-1.5">
                {CRM_STAGES.map((s) => (
                  <Badge key={s} tone={STAGE_TONE[s]}>
                    {CRM_STAGE_LABEL[s]}: {pipe.stages[s]}
                  </Badge>
                ))}
              </span>
              <span className="flex items-center gap-2">
                <Toggle
                  checked={live}
                  onChange={(v) => {
                    setLive(v)
                    remember(LIVE_KEY, v ? '1' : '0')
                  }}
                  label="Atualizar sozinho"
                />
              </span>
            </div>
          )}

          {overview && (
            <CampaignStrip overview={overview} value={filters.source} onPick={setSource} numberId={lineId} onResolved={load} />
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

          {msg && <Banner tone="bad">{msg}</Banner>}
        </div>
      </Card>

      {view === 'conversas' && (
        <Conversas
          rows={shown}
          selectedId={selectedId}
          onOpen={setSelectedId}
          onChanged={refresh}
          liveTick={liveTick}
          numberId={lineId}
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
                numberId={lineId}
                onChanged={refresh}
                liveTick={liveTick}
              />
            ) : (
              <Empty>Selecione uma conversa.</Empty>
            )}
          </Card>
        </div>
      )}

      {view === 'kanban' && selectedId !== null && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60 p-4" onClick={() => setSelectedId(null)}>
          <div
            className="max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-ink-800 bg-ink-900 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <ContactPanel
              key={selectedId}
              contactId={selectedId}
              numberId={lineId}
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
