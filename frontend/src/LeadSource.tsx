import { useEffect, useState } from 'react'

import { crmApi, type CampaignOverview, type LeadChannel, type LeadSource } from './api'
import { Badge, Banner, Button, Copy, Field, Input, Select } from './ui'

/** Cor e ícone de cada canal. A etiqueta precisa ser lida de relance no card do
 *  kanban: Instagram, Facebook e Google têm cara própria, o resto fica neutro. */
function tone(source: Pick<LeadSource, 'channel' | 'platform'>) {
  if (source.channel === 'meta_ads' || (source.channel === 'utm' && source.platform)) {
    if (source.platform === 'instagram') return 'border-pink-800/60 bg-pink-950/40 text-pink-300'
    return 'border-blue-800/60 bg-blue-950/40 text-blue-300'
  }
  const tones: Record<LeadChannel, string> = {
    meta_ads: 'border-blue-800/60 bg-blue-950/40 text-blue-300',
    google_ads: 'border-amber-800/60 bg-amber-950/40 text-amber-300',
    utm: 'border-violet-800/60 bg-violet-950/40 text-violet-300',
    organic: 'border-ink-700 bg-ink-850 text-ink-300',
    agenda: 'border-ink-700 bg-ink-850 text-ink-500',
    simulado: 'border-amber-900/60 bg-amber-950/30 text-amber-200',
  }
  return tones[source.channel]
}

export function ChannelIcon({
  source,
  className = 'h-3 w-3',
}: {
  source: Pick<LeadSource, 'channel' | 'platform'>
  className?: string
}) {
  const common = { viewBox: '0 0 24 24', className, fill: 'none', stroke: 'currentColor', strokeWidth: 2 }
  if (source.platform === 'instagram') {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.5" cy="6.5" r="0.6" fill="currentColor" />
      </svg>
    )
  }
  if (source.channel === 'meta_ads' || source.platform === 'facebook') {
    return (
      <svg {...common}>
        <path d="M14 8h2.5V4.5H14A3.5 3.5 0 0 0 10.5 8v2.5H8V14h2.5v6.5H14V14h2.5l.5-3.5h-3V8.5c0-.3.2-.5.5-.5Z" />
      </svg>
    )
  }
  if (source.channel === 'google_ads') {
    return (
      <svg {...common}>
        <path d="M20 12.2c0-.6-.1-1.1-.2-1.7H12v3.3h4.5a3.9 3.9 0 0 1-1.7 2.5v2h2.7c1.6-1.4 2.5-3.6 2.5-6.1Z" />
        <path d="M12 20.5c2.3 0 4.2-.8 5.5-2.1l-2.7-2a5 5 0 0 1-7.5-2.7H4.5v2.1A8.5 8.5 0 0 0 12 20.5ZM7.3 13.7a5 5 0 0 1 0-3.3V8.3H4.5a8.5 8.5 0 0 0 0 7.5l2.8-2.1ZM12 6.9c1.3 0 2.4.4 3.3 1.3l2.4-2.4A8.5 8.5 0 0 0 4.5 8.3l2.8 2.1A5 5 0 0 1 12 6.9Z" />
      </svg>
    )
  }
  if (source.channel === 'utm') {
    return (
      <svg {...common}>
        <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
        <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  )
}

/** Texto do tooltip: tudo que se sabe da origem, uma linha por item. */
export function sourceTooltip(s: LeadSource) {
  const lines = [s.channel_label]
  if (s.campaign_name) lines.push(`Campanha: ${s.campaign_name}`)
  if (s.adset_name) lines.push(`Conjunto: ${s.adset_name}`)
  if (s.ad_name || s.ad_headline) lines.push(`Anúncio: ${s.ad_name ?? s.ad_headline}`)
  if (s.ad_id) lines.push(`ID do anúncio: ${s.ad_id}`)
  if (s.objective_label) lines.push(`Objetivo: ${s.objective_label}`)
  for (const [k, v] of Object.entries(s.utm)) lines.push(`${k}: ${v}`)
  if (s.campaign_status === 'pending') lines.push('Campanha ainda não consultada no Meta')
  if (s.campaign_status === 'error') lines.push(`Campanha não resolvida: ${s.campaign_error ?? ''}`)
  return lines.join('\n')
}

/** Etiqueta "de onde veio". `compact` é a da lista de conversas: só o canal e a campanha. */
export function SourceTag({
  source,
  compact,
  full,
}: {
  source: LeadSource
  compact?: boolean
  /** ocupa a largura do card e mostra o objetivo — é a do kanban */
  full?: boolean
}) {
  const campaign =
    source.campaign_name ??
    (source.campaign_status === 'pending' ? 'campanha pendente' : source.ad_headline ?? null)

  return (
    <span
      title={sourceTooltip(source)}
      className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] leading-tight ${tone(source)} ${
        full ? 'w-full' : ''
      }`}
    >
      <ChannelIcon source={source} className="h-3 w-3 shrink-0" />
      <span className="shrink-0 font-medium">{source.channel_label}</span>
      {campaign && !compact && (
        <>
          <span className="shrink-0 opacity-50">·</span>
          <span className={`truncate ${source.campaign_name ? '' : 'italic opacity-70'}`}>{campaign}</span>
        </>
      )}
      {campaign && compact && source.campaign_name && (
        <span className="truncate opacity-80">· {source.campaign_name}</span>
      )}
    </span>
  )
}

/** Objetivo da campanha → evento que ele pede. */
export function ObjectiveChip({ source }: { source: LeadSource }) {
  if (!source.objective_label) return null
  return (
    <span
      title={`Objetivo da campanha: ${source.objective_label}. O disparo pelo objetivo manda ${source.suggested_event}.`}
      className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-1.5 py-0.5 font-mono text-[10px] text-ink-300"
    >
      {source.objective_label}
      <span className="text-ink-500">→</span>
      <span className="text-wa-500">{source.suggested_event}</span>
    </span>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_1fr] items-baseline gap-2 py-1">
      <span className="text-[11px] text-ink-500">{label}</span>
      <div className="min-w-0 text-xs text-ink-100">{children}</div>
    </div>
  )
}

/** Preenchimento manual da campanha de um anúncio — quem não tem token com ads_read. */
function ManualCampaign({
  source,
  objectives,
  onSaved,
  onCancel,
}: {
  source: LeadSource
  objectives: CampaignOverview['objectives']
  onSaved: () => Promise<void>
  onCancel: () => void
}) {
  const [draft, setDraft] = useState({
    campaign_name: source.campaign_name ?? '',
    adset_name: source.adset_name ?? '',
    ad_name: source.ad_name ?? '',
    objective: source.objective ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (data: typeof draft) => {
    if (!source.ad_id) return
    setBusy(true)
    setError(null)
    try {
      await crmApi.setCampaign(source.ad_id, data)
      await onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-ink-800 bg-ink-950 p-3">
      <p className="text-[11px] leading-snug text-ink-500">
        Vale para todos os leads do anúncio <span className="font-mono">{source.ad_id}</span>. A consulta automática
        nunca sobrescreve o que for preenchido aqui.
      </p>
      <Field label="Campanha">
        <Input value={draft.campaign_name} onChange={(e) => setDraft({ ...draft, campaign_name: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Conjunto">
          <Input value={draft.adset_name} onChange={(e) => setDraft({ ...draft, adset_name: e.target.value })} />
        </Field>
        <Field label="Objetivo">
          <Select value={draft.objective} onChange={(e) => setDraft({ ...draft, objective: e.target.value })}>
            <option value="">—</option>
            {objectives.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label} → {o.event}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {error && <Banner tone="bad">{error}</Banner>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void save(draft)}>
          {busy ? 'salvando…' : 'Salvar campanha'}
        </Button>
        <Button size="sm" onClick={onCancel}>
          cancelar
        </Button>
        {source.campaign_from === 'manual' && (
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={() => void save({ campaign_name: '', adset_name: '', ad_name: '', objective: '' })}
          >
            desfazer manual
          </Button>
        )}
      </div>
    </div>
  )
}

/** Bloco "De onde veio" do detalhe da conversa: canal, campanha, conjunto,
 *  anúncio, objetivo, UTMs e o clique — com a consulta ao Meta e o manual. */
export function SourceDetails({
  source,
  ctwaClid,
  sourceUrl,
  numberId,
  onChanged,
}: {
  source: LeadSource
  ctwaClid: string | null
  sourceUrl: string | null
  numberId?: number
  onChanged: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null)
  const [objectives, setObjectives] = useState<CampaignOverview['objectives']>([])
  const [hasToken, setHasToken] = useState<boolean | null>(null)

  useEffect(() => {
    if (source.channel !== 'meta_ads') return
    void crmApi
      .campaigns(numberId)
      .then((o) => {
        setObjectives(o.objectives)
        setHasToken(o.has_ads_token)
      })
      .catch(() => setHasToken(null))
  }, [numberId, source.channel])

  const utm = Object.entries(source.utm)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <SourceTag source={source} compact />
        <ObjectiveChip source={source} />
      </div>

      <div className="divide-y divide-ink-800/70">
        {source.campaign_name ? (
          <Row label="Campanha">
            <span className="font-medium">{source.campaign_name}</span>
            {source.campaign_from === 'utm' && <span className="ml-1 text-[10px] text-ink-500">(utm_campaign)</span>}
            {source.campaign_from === 'manual' && <span className="ml-1 text-[10px] text-ink-500">(manual)</span>}
          </Row>
        ) : (
          source.channel === 'meta_ads' && (
            <Row label="Campanha">
              <span className="italic text-ink-500">
                {source.campaign_status === 'error' ? 'não resolvida' : 'ainda não consultada'}
              </span>
            </Row>
          )
        )}
        {source.adset_name && <Row label="Conjunto">{source.adset_name}</Row>}
        {(source.ad_name || source.ad_headline) && (
          <Row label="Anúncio">
            {source.ad_name ?? source.ad_headline}
            {source.ad_name && source.ad_headline && (
              <span className="block text-[11px] text-ink-500">“{source.ad_headline}”</span>
            )}
          </Row>
        )}
        {source.ad_id && (
          <Row label="ID do anúncio">
            <span className="font-mono text-[11px]">{source.ad_id}</span>
          </Row>
        )}
        {source.objective_label && (
          <Row label="Objetivo">
            {source.objective_label}
            {source.optimization_goal && (
              <span className="ml-1 font-mono text-[10px] text-ink-500">{source.optimization_goal}</span>
            )}
          </Row>
        )}
        <Row label="Evento sugerido">
          <span className="font-mono text-wa-500">{source.suggested_event}</span>
          <span className="block text-[11px] text-ink-500">{source.suggested_reason}</span>
        </Row>
        {utm.length > 0 && (
          <Row label="UTMs">
            <div className="flex flex-wrap gap-1">
              {utm.map(([k, v]) => (
                <Badge key={k}>
                  {k.replace('utm_', '')}={v}
                </Badge>
              ))}
            </div>
          </Row>
        )}
        {ctwaClid && (
          <Row label="ctwa_clid">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-[11px] text-ink-300" title={ctwaClid}>
                {ctwaClid}
              </span>
              <Copy text={ctwaClid} />
            </div>
          </Row>
        )}
        {sourceUrl && (
          <Row label="Link de origem">
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="break-all text-[11px] text-sky-300 underline decoration-dotted underline-offset-2"
            >
              {sourceUrl}
            </a>
          </Row>
        )}
      </div>

      {source.campaign_status === 'error' && source.campaign_error && (
        <Banner tone="warn">
          O Meta não devolveu a campanha: {source.campaign_error}. O token precisa de <code>ads_read</code> na conta
          de anúncios — ou preencha à mão.
        </Banner>
      )}
      {source.channel === 'meta_ads' && hasToken === false && !source.campaign_name && (
        <Banner tone="warn">
          Sem token de anúncios nesta linha. Cadastre um com <code>ads_read</code> em{' '}
          <strong>Rastreamento → Meta</strong> para o nome da campanha e o objetivo virem sozinhos — ou preencha à
          mão.
        </Banner>
      )}
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      {source.channel === 'meta_ads' && source.ad_id && !editing && (
        <div className="flex flex-wrap gap-2 pt-1">
          {hasToken && (
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setMsg(null)
                try {
                  const r = await crmApi.resolveCampaigns(numberId, true)
                  await onChanged()
                  setMsg(
                    r.errors.length
                      ? { tone: 'warn', text: `${r.resolved}/${r.checked} anúncio(s) resolvido(s). ${r.errors[0]}` }
                      : { tone: 'good', text: `${r.resolved} anúncio(s) resolvido(s) no Meta.` },
                  )
                } catch (e) {
                  setMsg({ tone: 'bad', text: (e as Error).message })
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? 'consultando…' : 'consultar no Meta'}
            </Button>
          )}
          <Button size="sm" onClick={() => setEditing(true)}>
            {source.campaign_from === 'manual' ? 'editar campanha' : 'preencher à mão'}
          </Button>
        </div>
      )}
      {editing && (
        <ManualCampaign
          source={source}
          objectives={objectives}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false)
            await onChanged()
          }}
        />
      )}
    </div>
  )
}
