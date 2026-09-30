import { useCallback, useEffect, useState } from 'react'

import {
  journeysApi,
  type JourneyDetail,
  type JourneyFilters,
  type JourneyOverview,
  type JourneyRow,
} from '../api'
import { JourneyDetailView, MatchBadge, OriginChip, shortTl, touchLabel } from '../JourneyView'
import { useNumber } from '../numberContext'
import { Banner, Card, Empty, Info, Input, Select } from '../ui'

const PERIODS = [
  { value: 7, label: '7 dias' },
  { value: 30, label: '30 dias' },
  { value: 90, label: '90 dias' },
]

const STATUS: { id: NonNullable<JourneyFilters['status']>; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'lead', label: 'Viraram lead' },
  { id: 'clicked', label: 'Clicaram no WhatsApp' },
  { id: 'browsing', label: 'Só navegaram' },
]

function pct(v: number | null | undefined) {
  if (v === null || v === undefined) return '—'
  return `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
}

function ago(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} d`
}

/* -------------------------------------------------------------------------- */
/*  funil: visitantes -> clique no WhatsApp -> lead identificado               */
/* -------------------------------------------------------------------------- */

function FunnelStep({
  n,
  label,
  value,
  hint,
  rate,
  accent,
}: {
  n: number
  label: string
  value: number
  hint: string
  rate?: string
  accent?: boolean
}) {
  return (
    <div className="relative flex-1 rounded-xl border border-ink-800 bg-ink-900 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span
          className={`grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold ${
            accent ? 'bg-wa-500 text-ink-950' : 'bg-ink-850 text-ink-300'
          }`}
        >
          {n}
        </span>
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-500">{label}</p>
      </div>
      <p className={`mt-1.5 text-3xl font-semibold tabular-nums ${accent ? 'text-wa-500' : 'text-ink-100'}`}>
        {value.toLocaleString('pt-BR')}
      </p>
      <p className="text-[11px] text-ink-500">{hint}</p>
      {rate && (
        <span className="absolute right-3 top-3 rounded-md bg-wa-900/60 px-1.5 py-0.5 font-mono text-[11px] text-wa-500">
          {rate}
        </span>
      )}
    </div>
  )
}

function Funnel({ o }: { o: JourneyOverview }) {
  const clickRate = o.journeys ? o.whatsapp_clicks / o.journeys : null
  return (
    <div className="flex flex-col gap-3 lg:flex-row">
      <FunnelStep n={1} label="Jornadas" value={o.journeys} hint={`${o.visitors.toLocaleString('pt-BR')} visitantes · ${o.page_views.toLocaleString('pt-BR')} page views`} />
      <FunnelStep
        n={2}
        label="Clique no WhatsApp"
        value={o.whatsapp_clicks}
        hint="jornadas com click_whatsapp"
        rate={pct(clickRate)}
      />
      <FunnelStep
        n={3}
        label="Leads com origem"
        value={o.matched_leads}
        hint={`de ${o.conversations.toLocaleString('pt-BR')} conversas no período`}
        rate={pct(o.click_to_lead)}
        accent
      />
      <div className="flex-1 rounded-xl border border-ink-800 bg-ink-900 px-4 py-3.5">
        <div className="flex items-center gap-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-500">WhatsApp fora do ponto cego</p>
          <Info text="Conversas do período que chegaram ligadas a uma jornada do site (com a origem recuperada), sobre todas as conversas novas." />
        </div>
        <p className="mt-1.5 text-3xl font-semibold tabular-nums text-ink-100">{pct(o.match_rate)}</p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-850">
          <div className="h-full rounded-full bg-wa-500" style={{ width: `${Math.min(100, (o.match_rate ?? 0) * 100)}%` }} />
        </div>
      </div>
    </div>
  )
}

function Daily({ o }: { o: JourneyOverview }) {
  const days = o.daily.slice(-30)
  const max = Math.max(1, ...days.map((d) => d.journeys))
  if (days.length === 0) return <Empty>Sem jornadas no período.</Empty>
  return (
    <div>
      <div className="flex h-32 items-end justify-center gap-1">
        {days.map((d) => (
          <div
            key={d.day}
            className="group relative flex h-full max-w-[28px] flex-1 flex-col justify-end"
            title={`${new Date(d.day + 'T12:00').toLocaleDateString('pt-BR')}: ${d.journeys} jornadas · ${d.clicks} cliques · ${d.leads} leads`}
          >
            <div className="relative w-full rounded-t-sm bg-ink-700" style={{ height: `${(d.journeys / max) * 100}%` }}>
              <div className="absolute inset-x-0 bottom-0 rounded-t-sm bg-wa-900" style={{ height: `${d.journeys ? (d.clicks / d.journeys) * 100 : 0}%` }} />
              <div className="absolute inset-x-0 bottom-0 rounded-t-sm bg-wa-500" style={{ height: `${d.journeys ? (Math.min(d.leads, d.journeys) / d.journeys) * 100 : 0}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-ink-500">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-ink-700" /> jornadas</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-wa-900" /> clicaram no WhatsApp</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-wa-500" /> viraram lead</span>
      </div>
    </div>
  )
}

function ByOrigin({ o }: { o: JourneyOverview }) {
  if (o.by_origin.length === 0) return <Empty>Nenhuma origem registrada ainda.</Empty>
  const max = Math.max(1, ...o.by_origin.map((r) => r.journeys))
  return (
    <div className="space-y-2.5">
      {o.by_origin.map((r) => (
        <div key={r.label}>
          <div className="mb-1 flex items-center justify-between gap-3">
            <OriginChip origin={{ channel: r.channel, label: r.label }} />
            <span className="shrink-0 font-mono text-[11px] text-ink-400">
              {r.journeys} · {r.clicks} clique(s) · <span className="text-wa-500">{r.leads} lead(s)</span>
            </span>
          </div>
          <div className="relative h-1.5 overflow-hidden rounded-full bg-ink-850">
            <div className="absolute inset-y-0 left-0 rounded-full bg-ink-600" style={{ width: `${(r.journeys / max) * 100}%` }} />
            <div className="absolute inset-y-0 left-0 rounded-full bg-wa-500" style={{ width: `${(r.leads / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function ByMethod({ o }: { o: JourneyOverview }) {
  const total = o.by_method.reduce((a, m) => a + m.leads, 0)
  if (!total) return <Empty>Nenhum lead ligado a jornada ainda.</Empty>
  return (
    <div className="space-y-2">
      {o.by_method.map((m) => (
        <div key={m.method} className="flex items-center justify-between gap-3">
          <MatchBadge method={m.method} label={m.label} score={null} />
          <span className="font-mono text-[12px] text-ink-200">
            {m.leads} <span className="text-ink-500">({pct(m.leads / total)})</span>
          </span>
        </div>
      ))}
      <p className="pt-1 text-[11px] leading-relaxed text-ink-500">
        Determinístico primeiro (TL_ID, protocolo); temporal e probabilístico só quando não há identificação.
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  lista + detalhe                                                            */
/* -------------------------------------------------------------------------- */

function JourneyList({ rows, active, onOpen }: { rows: JourneyRow[]; active: string | null; onOpen: (tl: string) => void }) {
  if (rows.length === 0) return <Empty>Nenhuma jornada com esse filtro.</Empty>
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead>
          <tr className="border-b border-ink-800 text-[10.5px] uppercase tracking-wide text-ink-500">
            <th className="px-3 py-2 font-medium">TL_ID</th>
            <th className="px-3 py-2 font-medium">Origem</th>
            <th className="px-3 py-2 font-medium">Campanha</th>
            <th className="px-3 py-2 font-medium">Entrada</th>
            <th className="px-3 py-2 font-medium">Eventos</th>
            <th className="px-3 py-2 font-medium">WhatsApp</th>
            <th className="px-3 py-2 font-medium">Lead</th>
            <th className="px-3 py-2 text-right font-medium">Última</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-800">
          {rows.map((r) => (
            <tr
              key={r.transaction_id}
              onClick={() => onOpen(r.transaction_id)}
              className={`cursor-pointer transition-colors hover:bg-ink-850/70 ${active === r.transaction_id ? 'bg-ink-850' : ''}`}
            >
              <td className="px-3 py-2.5 font-mono text-[11.5px] text-ink-300" title={r.transaction_id}>
                {shortTl(r.transaction_id)}
              </td>
              <td className="px-3 py-2.5">
                <OriginChip origin={r.origin} />
              </td>
              <td className="max-w-[160px] truncate px-3 py-2.5 text-[12.5px] text-ink-200" title={touchLabel(r.last_touch)}>
                {r.last_touch?.campaign || r.first_touch?.campaign || <span className="text-ink-600">—</span>}
              </td>
              <td className="max-w-[160px] truncate px-3 py-2.5 font-mono text-[11.5px] text-ink-400">{r.landing_page || '/'}</td>
              <td className="px-3 py-2.5 font-mono text-[12px] text-ink-300">
                {r.events} <span className="text-ink-500">· {r.pages.length} pág.</span>
              </td>
              <td className="px-3 py-2.5">
                {r.clicked_whatsapp_at ? (
                  <span className="inline-flex items-center gap-1 text-[12px] text-wa-500">
                    <span className="h-1.5 w-1.5 rounded-full bg-wa-500" /> clicou
                  </span>
                ) : (
                  <span className="text-[12px] text-ink-600">—</span>
                )}
              </td>
              <td className="px-3 py-2.5">
                {r.lead ? (
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[12.5px] text-ink-100">{r.lead.name || r.lead.phone_e164 || r.lead.wa_id}</span>
                    <MatchBadge method={r.lead.match_method} label={r.lead.match_label} score={r.lead.match_score} />
                  </div>
                ) : (
                  <span className="text-[12px] text-ink-600">—</span>
                )}
              </td>
              <td className="px-3 py-2.5 text-right text-[12px] text-ink-500">{ago(r.last_event_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Drawer({ tl, numberId, onClose }: { tl: string; numberId?: number; onClose: () => void }) {
  const [detail, setDetail] = useState<JourneyDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDetail(null)
    setError(null)
    journeysApi
      .get(tl, numberId)
      .then(setDetail)
      .catch((e: Error) => setError(e.message))
  }, [tl, numberId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink-950/60 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-ink-800 bg-ink-900 shadow-2xl">
        <header className="flex h-[60px] shrink-0 items-center gap-3 bg-chat-header px-4">
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="grid h-8 w-8 place-items-center rounded-full text-ink-300 hover:bg-ink-700 hover:text-ink-100"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
          <div className="min-w-0">
            <p className="text-[15px] text-ink-100">Jornada do visitante</p>
            <p className="truncate font-mono text-[11px] text-ink-500">{tl}</p>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-5">
          {error && <Banner tone="bad">{error}</Banner>}
          {!detail && !error && <p className="text-sm text-ink-500">carregando…</p>}
          {detail && <JourneyDetailView detail={detail} />}
        </div>
      </aside>
    </>
  )
}

export default function Journeys() {
  const { numberId } = useNumber()
  const [days, setDays] = useState(30)
  const [status, setStatus] = useState<NonNullable<JourneyFilters['status']>>('all')
  const [q, setQ] = useState('')
  const [overview, setOverview] = useState<JourneyOverview | null>(null)
  const [rows, setRows] = useState<JourneyRow[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    journeysApi
      .overview(numberId, days)
      .then(setOverview)
      .catch((e: Error) => setError(e.message))
  }, [numberId, days])

  useEffect(load, [load])

  useEffect(() => {
    const t = setTimeout(() => {
      journeysApi
        .list({ number_id: numberId, status, q: q.trim() || undefined, days })
        .then(setRows)
        .catch((e: Error) => setError(e.message))
    }, 250)
    return () => clearTimeout(t)
  }, [numberId, status, q, days])

  // jornada é algo vivo: o visitante está navegando agora
  useEffect(() => {
    const t = setInterval(() => {
      load()
      journeysApi
        .list({ number_id: numberId, status, q: q.trim() || undefined, days })
        .then(setRows)
        .catch(() => undefined)
    }, 20000)
    return () => clearInterval(t)
  }, [load, numberId, status, q, days])

  const empty = overview && overview.journeys === 0

  return (
    <div className="space-y-5">
      {error && <Banner tone="bad">{error}</Banner>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-relaxed text-ink-500">
          Cada visitante do site ganha um <span className="font-mono text-ink-300">TL_ID</span>. Tudo que ele faz — da
          primeira visita ao clique no WhatsApp — fica ligado a esse ID, e a conversa que chega depois recupera de qual
          anúncio ele veio.
        </p>
        <div className="flex items-center gap-1 rounded-lg border border-ink-800 bg-ink-900 p-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setDays(p.value)}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                days === p.value ? 'bg-wa-900 text-wa-500' : 'text-ink-400 hover:text-ink-100'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {empty && (
        <Banner tone="warn">
          Nenhuma jornada registrada nesse período. Instale a tag na aba <strong>Tag do site</strong> — ou rode o
          simulador de lá para ver o fluxo inteiro funcionando.
        </Banner>
      )}

      {overview && <Funnel o={overview} />}

      {overview && (
        <div className="grid gap-5 xl:grid-cols-3">
          <Card title="Jornadas por dia" subtitle="Quantas começaram, quantas clicaram e quantas viraram lead">
            <Daily o={overview} />
          </Card>
          <Card title="De qual mídia vieram" subtitle="Origem pelo last touch — direto nunca apaga origem válida">
            <ByOrigin o={overview} />
          </Card>
          <Card title="Como a conversa foi identificada" subtitle="Todo match registra método e score">
            <ByMethod o={overview} />
            {overview.landing_pages.length > 0 && (
              <div className="mt-4 border-t border-ink-800 pt-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-500">Páginas de entrada</p>
                <div className="space-y-1">
                  {overview.landing_pages.map((l) => (
                    <div key={l.page} className="flex items-center justify-between gap-3 text-[12px]">
                      <span className="truncate font-mono text-ink-300">{l.page}</span>
                      <span className="font-mono text-ink-500">{l.journeys}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      <Card
        title="Jornadas"
        subtitle="Clique numa linha para ver a jornada reconstruída, as sete respostas e os dados de atribuição"
      >
        <div className="mb-4 flex flex-wrap gap-2">
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <Input placeholder="TL_ID, campanha, página…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="w-full sm:w-52">
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              {STATUS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {rows === null ? <p className="text-sm text-ink-500">carregando…</p> : <JourneyList rows={rows} active={open} onOpen={setOpen} />}
      </Card>

      {open && <Drawer tl={open} numberId={numberId} onClose={() => setOpen(null)} />}
    </div>
  )
}
