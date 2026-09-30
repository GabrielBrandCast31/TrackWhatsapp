import { useCallback, useEffect, useState } from 'react'

import {
  journeysApi,
  MATCH_TONE,
  type JourneyDetail,
  type JourneyEvent,
  type JourneyOrigin,
  type JourneySummary,
  type MatchMethod,
  type Touch,
} from './api'
import { Badge, Button, Copy, Empty, Info, Input, when } from './ui'

/* -------------------------------------------------------------------------- */
/*  peças pequenas                                                            */
/* -------------------------------------------------------------------------- */

const ORIGIN_TONE: Record<JourneyOrigin['channel'], string> = {
  google_ads: 'border-sky-900/60 bg-sky-950/40 text-sky-300',
  meta_ads: 'border-blue-800/60 bg-blue-950/40 text-blue-300',
  tiktok_ads: 'border-pink-800/60 bg-pink-950/40 text-pink-300',
  organic: 'border-wa-500/40 bg-wa-900/40 text-wa-500',
  social: 'border-violet-800/60 bg-violet-950/40 text-violet-300',
  referral: 'border-amber-900/60 bg-amber-950/40 text-amber-300',
  utm: 'border-ink-700 bg-ink-850 text-ink-200',
  direct: 'border-ink-700 bg-ink-850 text-ink-400',
}

export function OriginChip({ origin }: { origin: JourneyOrigin | null | undefined }) {
  if (!origin) return <span className="text-xs text-ink-500">—</span>
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        ORIGIN_TONE[origin.channel] ?? ORIGIN_TONE.utm
      }`}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">{origin.label}</span>
    </span>
  )
}

export function MatchBadge({
  method,
  label,
  score,
}: {
  method: MatchMethod | null
  label?: string | null
  score: number | null
}) {
  if (!method) return null
  return (
    <span title={`match_method = ${method} · match_score = ${score?.toFixed(2) ?? '—'}`}>
      <Badge tone={MATCH_TONE[method] ?? 'neutral'}>
        {label ?? method}
        {score !== null && score !== undefined ? ` · ${score.toFixed(2)}` : ''}
      </Badge>
    </span>
  )
}

export function touchLabel(t: Touch | null | undefined) {
  if (!t || !t.source) return 'direct / none'
  return `${t.source} / ${t.medium || 'none'}`
}

export function shortTl(tl: string) {
  return tl.length > 18 ? `${tl.slice(0, 13)}…${tl.slice(-4)}` : tl
}

function clockOf(iso: string) {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function gap(a: string, b: string) {
  const s = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}min ${s % 60 ? `${s % 60}s` : ''}`.trim()
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}min`
}

/* -------------------------------------------------------------------------- */
/*  linha do tempo: Landing Page -> ... -> Clique WhatsApp -> Conversa         */
/* -------------------------------------------------------------------------- */

const EVENT_ICON: Record<string, string> = {
  page_view: 'M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  view_service: 'M4 6h16M4 12h16M4 18h10',
  click_phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z',
  click_email: 'M4 6h16v12H4z M4 7l8 6 8-6',
  click_instagram: 'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  click_whatsapp: 'M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1.4-5A8.5 8.5 0 1 1 21 11.5Z',
  form_start: 'M4 20h4L19 9l-4-4L4 16v4Z',
  form_submit: 'M5 12l5 5L20 7',
}

function EventDot({ name, highlight }: { name: string; highlight: boolean }) {
  return (
    <span
      className={`relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full border ${
        highlight ? 'border-wa-500 bg-wa-500 text-ink-950' : 'border-ink-700 bg-ink-850 text-ink-300'
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={EVENT_ICON[name] ?? 'M12 8v4l3 2 M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z'} />
      </svg>
    </span>
  )
}

export function JourneyTimeline({
  events,
  lead,
  compact,
}: {
  events: JourneyEvent[]
  lead?: JourneyDetail['lead']
  compact?: boolean
}) {
  const [all, setAll] = useState(false)
  const limit = compact ? 6 : 40
  const shown = all ? events : events.slice(-limit)
  const hidden = events.length - shown.length

  if (events.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-ink-500">
        Nenhum evento de navegação gravado para este TL_ID — a tag do site não chegou a registrar a visita (outro
        domínio, bloqueador ou a referência veio de fora).
      </p>
    )
  }

  return (
    <ol className="relative space-y-0">
      <span aria-hidden className="absolute bottom-4 left-4 top-4 w-px bg-ink-700" />
      {hidden > 0 && (
        <li className="relative flex gap-3 pb-3 pl-11">
          <button type="button" onClick={() => setAll(true)} className="text-xs text-wa-500 hover:underline">
            mostrar {hidden} evento(s) anterior(es)
          </button>
        </li>
      )}
      {shown.map((e, i) => {
        const prev = shown[i - 1]
        const isWa = e.event_name === 'click_whatsapp'
        const utm = e.utm?.source ? touchLabel(e.utm) : null
        return (
          <li key={e.id} className="relative flex gap-3 pb-3">
            <EventDot name={e.event_name} highlight={isWa} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className={`text-[13px] font-medium ${isWa ? 'text-wa-500' : 'text-ink-100'}`}>{e.label}</span>
                <span className="font-mono text-[10.5px] text-ink-500" title={when(e.event_time)}>
                  {clockOf(e.event_time)}
                  {prev ? ` · +${gap(prev.event_time, e.event_time)}` : ''}
                </span>
              </div>
              <p className="truncate font-mono text-[11px] text-ink-400" title={e.page_url ?? undefined}>
                {e.page_path || e.page_url || '—'}
                {e.page_title && !compact ? <span className="font-sans text-ink-500"> · {e.page_title}</span> : null}
              </p>
              {!compact && (utm || Object.keys(e.click_ids).length > 0 || e.protocol) && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {utm && <Badge tone="info">{utm}</Badge>}
                  {e.utm?.campaign && <Badge>{e.utm.campaign}</Badge>}
                  {['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid'].map((k) =>
                    e.click_ids[k] ? <Badge key={k}>{k}</Badge> : null,
                  )}
                  {e.protocol && <Badge tone="good">{e.protocol}</Badge>}
                </div>
              )}
            </div>
          </li>
        )
      })}
      <li className="relative flex gap-3">
        <span
          className={`relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full border ${
            lead ? 'border-wa-500 bg-wa-900 text-wa-500' : 'border-dashed border-ink-600 bg-ink-900 text-ink-500'
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21a8 8 0 0 0-16 0 M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
          </svg>
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          {lead ? (
            <>
              <span className="text-[13px] font-medium text-ink-100">
                Conversa no WhatsApp · {lead.name || lead.phone_e164 || lead.wa_id}
              </span>
              <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-500">
                {lead.whatsapp_arrived_at && <span className="font-mono">{clockOf(lead.whatsapp_arrived_at)}</span>}
                <MatchBadge method={lead.match_method} label={lead.match_label} score={lead.match_score} />
              </p>
            </>
          ) : (
            <>
              <span className="text-[13px] text-ink-500">Ainda sem conversa no WhatsApp</span>
              <p className="text-[11px] text-ink-500">o lead aparece aqui quando a mensagem chegar</p>
            </>
          )}
        </div>
      </li>
    </ol>
  )
}

/* -------------------------------------------------------------------------- */
/*  atribuição: first touch x last touch, click IDs, GA4, técnico             */
/* -------------------------------------------------------------------------- */

function KV({ k, v, mono = true }: { k: string; v: string | null | undefined; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-[11px] text-ink-500">{k}</span>
      <span className={`min-w-0 truncate text-right text-[12px] text-ink-100 ${mono ? 'font-mono' : ''}`} title={v ?? undefined}>
        {v || <span className="text-ink-600">—</span>}
      </span>
    </div>
  )
}

function TouchCard({ title, hint, touch, accent }: { title: string; hint: string; touch: Touch; accent?: boolean }) {
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${accent ? 'border-wa-500/30 bg-wa-900/20' : 'border-ink-800 bg-ink-950/60'}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">{hint}</p>
      <p className="text-[13px] font-semibold text-ink-100">{title}</p>
      <div className="mt-1 divide-y divide-ink-800">
        <KV k="source" v={touch.source} />
        <KV k="medium" v={touch.medium} />
        <KV k="campaign" v={touch.campaign} />
        <KV k="content" v={touch.content} />
        <KV k="term" v={touch.term} />
      </div>
    </div>
  )
}

export function AttributionGrid({ summary }: { summary: JourneySummary }) {
  const c = summary.click_ids ?? {}
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <TouchCard title="First touch" hint="Aquisição" touch={summary.first_touch ?? {}} />
        <TouchCard title="Last touch" hint="Conversão" touch={summary.last_touch ?? {}} accent />
      </div>
      <p className="text-[11px] leading-relaxed text-ink-500">
        Uma visita posterior sem informações (direct / none) nunca apaga uma atribuição válida — por isso as duas
        versões são mantidas separadas.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-300">Meta</p>
          <div className="divide-y divide-ink-800">
            <KV k="fbclid" v={c.fbclid} />
            <KV k="_fbp" v={c.fbp} />
            <KV k="_fbc" v={c.fbc} />
          </div>
        </div>
        <div className="rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-sky-300">Google</p>
          <div className="divide-y divide-ink-800">
            <KV k="gclid" v={c.gclid} />
            <KV k="gbraid" v={c.gbraid} />
            <KV k="wbraid" v={c.wbraid} />
            <KV k="gad_source" v={c.gad_source} />
          </div>
        </div>
        <div className="rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-pink-300">TikTok</p>
          <div className="divide-y divide-ink-800">
            <KV k="ttclid" v={c.ttclid} />
            <KV k="_ttp" v={c.ttp} />
          </div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">Identificação · GA4</p>
          <div className="divide-y divide-ink-800">
            <KV k="transaction_id" v={summary.transaction_id} />
            <KV k="visitor_id" v={summary.visitor_id} />
            <KV k="session_id" v={summary.session_ids?.[summary.session_ids.length - 1]} />
            <KV k="ga client_id" v={summary.ga?.ga_client_id} />
            <KV k="ga session" v={summary.ga?.ga_session_id ? `${summary.ga.ga_session_id} · nº ${summary.ga.ga_session_number ?? '—'}` : null} />
          </div>
        </div>
        <div className="rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">Página · técnico</p>
          <div className="divide-y divide-ink-800">
            <KV k="landing_page" v={summary.landing_page} />
            <KV k="hostname" v={summary.hostname} />
            <KV k="protocolo" v={summary.protocol} />
            <KV k="IP" v={summary.ip} />
            <KV k="User-Agent" v={summary.user_agent} mono={false} />
          </div>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  as sete perguntas                                                          */
/* -------------------------------------------------------------------------- */

function answerText(a: string | null) {
  if (!a) return null
  return /^\d{4}-\d{2}-\d{2}T/.test(a) ? when(a) : a
}

export function SevenAnswers({ answers }: { answers: JourneyDetail['answers'] }) {
  return (
    <ol className="grid gap-2 sm:grid-cols-2">
      {answers.map((x, i) => {
        const a = answerText(x.a)
        return (
          <li key={x.q} className="flex gap-2.5 rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2">
            <span className="font-mono text-[11px] font-semibold text-wa-500">{String(i + 1).padStart(2, '0')}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium text-ink-200">{x.q}</p>
              <p className={`break-words text-[12.5px] ${a ? 'text-ink-100' : 'text-ink-600'}`}>{a ?? 'sem resposta ainda'}</p>
              <p className="text-[10.5px] text-ink-500">{x.how}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/* -------------------------------------------------------------------------- */
/*  detalhe completo de uma jornada                                            */
/* -------------------------------------------------------------------------- */

export function JourneyDetailView({ detail }: { detail: JourneyDetail }) {
  const s = detail.summary
  if (!s) return <Empty>Sem jornada.</Empty>
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <OriginChip origin={s.origin} />
        <span className="font-mono text-[11px] text-ink-400">tl={s.transaction_id}</span>
        <Copy text={s.transaction_id} />
      </div>

      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Jornada reconstruída</h3>
        <JourneyTimeline events={detail.events} lead={detail.lead} />
      </section>

      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">O que a jornada responde</h3>
        <SevenAnswers answers={detail.answers} />
      </section>

      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Dados de atribuição</h3>
        <AttributionGrid summary={s} />
      </section>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  no CRM: a jornada da conversa aberta                                       */
/* -------------------------------------------------------------------------- */

export function ContactJourney({ contactId, onChanged }: { contactId: number; onChanged?: () => void }) {
  const [detail, setDetail] = useState<JourneyDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)
  const [tl, setTl] = useState('')
  const [open, setOpen] = useState(false)

  const load = useCallback(() => {
    setError(null)
    journeysApi
      .forContact(contactId)
      .then(setDetail)
      .catch((e: Error) => setError(e.message))
  }, [contactId])

  useEffect(load, [load])

  const link = async () => {
    setError(null)
    try {
      setDetail(await journeysApi.link(contactId, tl.trim()))
      setLinking(false)
      setTl('')
      onChanged?.()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const unlink = async () => {
    if (!confirm('Desligar esta conversa da jornada do site?')) return
    await journeysApi.unlink(contactId)
    load()
    onChanged?.()
  }

  if (error) return <p className="text-xs text-red-300">{error}</p>
  if (!detail) return <p className="text-xs text-ink-500">carregando jornada…</p>

  const s = detail.summary
  const lead = detail.lead

  if (!s) {
    return (
      <div className="space-y-2">
        <p className="text-xs leading-relaxed text-ink-500">
          Esta conversa não chegou com TL_ID, protocolo nem clique no WhatsApp dentro da janela de tempo. Se você sabe
          qual foi a jornada, ligue à mão.
        </p>
        {linking ? (
          <div className="flex gap-2">
            <Input value={tl} onChange={(e) => setTl(e.target.value)} placeholder="1790195601229_1790…" />
            <Button size="sm" variant="primary" onClick={link} disabled={tl.trim().length < 8}>
              ligar
            </Button>
          </div>
        ) : (
          <Button size="sm" onClick={() => setLinking(true)}>
            ligar a um TL_ID
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <OriginChip origin={s.origin} />
        {lead && <MatchBadge method={lead.match_method} label={lead.match_label} score={lead.match_score} />}
      </div>
      <div className="divide-y divide-ink-800 rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-1">
        <KV k="TL_ID" v={s.transaction_id} />
        <KV k="campanha" v={s.last_touch?.campaign || s.first_touch?.campaign} mono={false} />
        <KV k="first touch" v={touchLabel(s.first_touch)} />
        <KV k="last touch" v={touchLabel(s.last_touch)} />
        <KV k="entrada" v={s.landing_page} />
        <KV k="clicou no WhatsApp" v={s.clicked_whatsapp_at ? when(s.clicked_whatsapp_at) : null} mono={false} />
      </div>
      <JourneyTimeline events={detail.events} lead={lead} compact />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? 'esconder atribuição' : 'ver atribuição completa'}
        </Button>
        <button type="button" onClick={unlink} className="text-[11px] text-ink-500 hover:text-red-300">
          desligar
        </button>
        <Info text="O lead guarda só a referência (TL_ID). A jornada completa é consultada em tracking_events pelo transaction_id." />
      </div>
      {open && <AttributionGrid summary={s} />}
    </div>
  )
}
