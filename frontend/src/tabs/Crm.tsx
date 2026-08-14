import { useEffect, useState } from 'react'

import {
  api,
  prospectApi,
  STAGES,
  STAGE_LABEL,
  type Outreach,
  type Pipeline,
  type Prospect,
  type ProspectDetail,
  type ProspectSearch,
  type Stage,
  type WaTemplate,
} from '../api'
import { Badge, Banner, Button, Card, Empty, Field, Input, Json, Select, Textarea, Toggle, when } from '../ui'

const STAGE_TONE: Record<Stage, 'neutral' | 'good' | 'bad' | 'warn' | 'info'> = {
  novo: 'neutral',
  contatado: 'info',
  respondeu: 'warn',
  qualificado: 'warn',
  ganho: 'good',
  perdido: 'bad',
}

function PhoneBadge({ p }: { p: Prospect }) {
  if (!p.phone_e164) return <Badge tone="bad">sem telefone</Badge>
  if (p.phone_kind === 'mobile') return <Badge tone="good">celular</Badge>
  if (p.phone_kind === 'landline') return <Badge tone="warn">fixo</Badge>
  return <Badge>telefone</Badge>
}

function OutreachConfig({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [onlyMobile, setOnlyMobile] = useState(true)
  const [throttle, setThrottle] = useState(8)
  const [cap, setCap] = useState(80)
  const [msg, setMsg] = useState<string | null>(null)

  const load = async () => {
    const { config } = await api.getConfig()
    setEnabled(Boolean(config.outreach_enabled))
    setOnlyMobile(Boolean(config.outreach_only_mobile))
    setThrottle(Number(config.outreach_throttle_seconds ?? 8))
    setCap(Number(config.outreach_daily_cap ?? 80))
  }

  useEffect(() => {
    void load()
  }, [])

  const save = async (patch: Record<string, unknown>) => {
    await api.putConfig(patch)
    await load()
    onSaved()
    setMsg('Salvo.')
    setTimeout(() => setMsg(null), 2000)
  }

  return (
    <Card
      title="Abordagem ativa"
      subtitle={enabled ? 'Ligada — os disparos saem de verdade.' : 'Desligada — nada é enviado.'}
      actions={
        <>
          {enabled ? <Badge tone="good">ligada</Badge> : <Badge tone="bad">desligada</Badge>}
          <Button size="sm" onClick={() => setOpen(!open)}>
            {open ? 'fechar' : 'configurar'}
          </Button>
        </>
      }
    >
      {open ? (
        <div className="space-y-4">
          <Banner tone="warn">
            Mensagem fria (para quem nunca te escreveu) só é entregue por <strong>template aprovado</strong> pela
            Meta — texto livre funciona apenas dentro da janela de 24h após a pessoa responder. Isso é regra da
            Cloud API, não limitação daqui. Vale também lembrar do lado legal: número em ficha do Google Maps é
            dado de contato comercial, mas marcar reclamação de spam derruba a qualidade do seu número.
          </Banner>
          <Toggle
            checked={enabled}
            onChange={(v) => void save({ outreach_enabled: v })}
            label="Permitir disparo de abordagem"
          />
          <Toggle
            checked={onlyMobile}
            onChange={(v) => void save({ outreach_only_mobile: v })}
            label="Só para números classificados como celular"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Intervalo entre envios (s)" hint="Protege a reputação do número.">
              <Input
                type="number"
                min={0}
                value={throttle}
                onChange={(e) => setThrottle(Number(e.target.value))}
                onBlur={() => void save({ outreach_throttle_seconds: throttle })}
              />
            </Field>
            <Field label="Limite por dia" hint="0 desliga o limite.">
              <Input
                type="number"
                min={0}
                value={cap}
                onChange={(e) => setCap(Number(e.target.value))}
                onBlur={() => void save({ outreach_daily_cap: cap })}
              />
            </Field>
          </div>
          {msg && <Banner tone="good">{msg}</Banner>}
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-ink-500">
          O disparo usa o mesmo número da Cloud API que já está conectado na aba Conexão. Quem responder cai
          automaticamente na aba Leads como contato, e o prospect vira{' '}
          <span className="text-ink-300">Respondeu</span> aqui.
        </p>
      )}
    </Card>
  )
}

function SendPanel({
  selected,
  onSent,
  onClear,
}: {
  selected: number[]
  onSent: (info: string) => void
  onClear: () => void
}) {
  const [kind, setKind] = useState<'template' | 'text'>('template')
  const [templates, setTemplates] = useState<WaTemplate[] | null>(null)
  const [templateErr, setTemplateErr] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string>('')
  const [params, setParams] = useState<string[]>([])
  const [text, setText] = useState('Olá {nome}! Vi a página de vocês no Google e queria falar rapidinho.')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ queued: number; skipped: { name: string; reason: string }[] } | null>(
    null,
  )

  const loadTemplates = async () => {
    setTemplateErr(null)
    try {
      const rows = await prospectApi.templates()
      setTemplates(rows)
      const first = rows.find((t) => t.approved)
      if (first) {
        setChosen(`${first.name}|${first.language}`)
        setParams(Array(first.placeholders).fill('{nome}'))
      }
    } catch (e) {
      setTemplateErr((e as Error).message)
      setTemplates([])
    }
  }

  useEffect(() => {
    void loadTemplates()
  }, [])

  const active = templates?.find((t) => `${t.name}|${t.language}` === chosen)

  const send = async () => {
    setBusy(true)
    setErr(null)
    setResult(null)
    try {
      const payload =
        kind === 'template'
          ? {
              kind,
              template_name: active?.name,
              template_language: active?.language,
              template_params: params,
              prospect_ids: selected,
            }
          : { kind, text, prospect_ids: selected }
      const res = await prospectApi.outreachBulk(payload)
      setResult(res)
      onSent(`${res.queued} abordagem(ns) na fila.`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title={`Disparar para ${selected.length} selecionado(s)`}
      subtitle="Vai para uma fila com intervalo entre envios — o resultado aparece no log abaixo."
      actions={
        <Button size="sm" onClick={onClear}>
          limpar seleção
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2">
          {(['template', 'text'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                kind === k
                  ? 'border-wa-500 bg-wa-900/50 text-wa-500'
                  : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-500'
              }`}
            >
              {k === 'template' ? 'Template aprovado (abordagem fria)' : 'Texto livre (janela de 24h)'}
            </button>
          ))}
        </div>

        {kind === 'template' ? (
          <div className="space-y-3">
            {templateErr && (
              <Banner tone="bad">
                Não consegui listar os templates: {templateErr} — confira o WABA ID e o token na aba Conexão.
              </Banner>
            )}
            {templates && templates.length === 0 && !templateErr && (
              <Banner tone="warn">
                Nenhum template cadastrado nesse WABA. Crie um na categoria <strong>Marketing</strong> ou{' '}
                <strong>Utility</strong> no Gerenciador do WhatsApp e espere a aprovação.
              </Banner>
            )}
            {templates && templates.length > 0 && (
              <Field label="Template" hint="Só os aprovados entregam.">
                <Select
                  value={chosen}
                  onChange={(e) => {
                    setChosen(e.target.value)
                    const t = templates.find((x) => `${x.name}|${x.language}` === e.target.value)
                    setParams(Array(t?.placeholders ?? 0).fill('{nome}'))
                  }}
                >
                  {templates.map((t) => (
                    <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>
                      {t.name} ({t.language}) {t.approved ? '' : `— ${t.status}`}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {active && (
              <>
                <div className="rounded-lg border border-ink-800 bg-ink-950 p-3 text-xs leading-relaxed text-ink-300">
                  {active.body || '(template sem corpo de texto)'}
                </div>
                {!active.approved && <Banner tone="bad">Esse template está {active.status}, não vai entregar.</Banner>}
                {params.map((value, i) => (
                  <Field
                    key={i}
                    label={`Variável {{${i + 1}}}`}
                    hint="Use {nome}, {categoria} ou {cidade} para preencher com os dados de cada prospect."
                  >
                    <Input
                      value={value}
                      onChange={(e) => setParams(params.map((p, j) => (j === i ? e.target.value : p)))}
                    />
                  </Field>
                ))}
              </>
            )}
          </div>
        ) : (
          <>
            <Banner tone="warn">
              Texto livre só chega a quem te mandou mensagem nas últimas 24h. Para lista fria, use template.
            </Banner>
            <Field label="Mensagem" hint="{nome}, {categoria} e {cidade} são substituídos por prospect.">
              <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          </>
        )}

        {err && <Banner tone="bad">{err}</Banner>}
        {result && (
          <div className="space-y-2">
            <Banner tone="good">{result.queued} enfileirado(s).</Banner>
            {result.skipped.length > 0 && (
              <div className="rounded-lg border border-ink-800 bg-ink-950 p-3">
                <p className="mb-1.5 text-xs text-ink-500">Pulados:</p>
                <ul className="space-y-0.5">
                  {result.skipped.map((s, i) => (
                    <li key={i} className="text-xs text-ink-300">
                      {s.name} — <span className="text-ink-500">{s.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <Button
          variant="primary"
          disabled={busy || selected.length === 0 || (kind === 'template' && !active?.approved)}
          onClick={() => void send()}
        >
          {busy ? 'enfileirando…' : `Disparar para ${selected.length}`}
        </Button>
      </div>
    </Card>
  )
}

function ProspectDetailCard({
  id,
  onChanged,
  onClose,
}: {
  id: number
  onChanged: () => void
  onClose: () => void
}) {
  const [p, setP] = useState<ProspectDetail | null>(null)
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const load = async () => {
    const row = await prospectApi.prospect(id)
    setP(row)
    setNote(row.note ?? '')
  }

  useEffect(() => {
    void load()
  }, [id])

  if (!p) return <Card title="Detalhe">Carregando…</Card>

  const patch = async (body: Record<string, unknown>) => {
    setErr(null)
    try {
      await prospectApi.patchProspect(id, body)
      await load()
      onChanged()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <Card
      title={p.name}
      subtitle={[p.category, p.address].filter(Boolean).join(' · ') || undefined}
      actions={
        <Button size="sm" onClick={onClose}>
          fechar
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <PhoneBadge p={p} />
          {p.phone_e164 && <Badge>{p.phone_e164}</Badge>}
          {p.distance_km != null && <Badge tone="info">{p.distance_km.toFixed(2)} km</Badge>}
          {p.rating != null && p.rating > 0 && (
            <Badge tone="warn">
              {p.rating} ★ {p.reviews_count ?? 0}
            </Badge>
          )}
          {p.contact_id && <Badge tone="good">virou lead #{p.contact_id}</Badge>}
        </div>

        <div>
          <span className="mb-2 block text-xs font-medium text-ink-300">Etapa</span>
          <div className="flex flex-wrap gap-1.5">
            {STAGES.map((s) => (
              <button
                key={s}
                onClick={() => void patch({ stage: s })}
                className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                  p.stage === s
                    ? 'border-wa-500 bg-wa-900/50 text-wa-500'
                    : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-500'
                }`}
              >
                {STAGE_LABEL[s]}
              </button>
            ))}
          </div>
        </div>

        <Field label="Telefone" hint="Corrigir aqui renormaliza e reclassifica o número.">
          <Input
            defaultValue={p.phone_e164 ?? ''}
            onBlur={(e) => {
              if (e.target.value !== (p.phone_e164 ?? '')) void patch({ phone_e164: e.target.value })
            }}
          />
        </Field>

        <Field label="Anotação">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Button size="sm" onClick={() => void patch({ note })}>
          salvar anotação
        </Button>

        <div className="flex flex-wrap gap-2 text-xs">
          {p.website && (
            <a href={p.website} target="_blank" rel="noreferrer" className="text-wa-500 hover:underline">
              site
            </a>
          )}
          {p.maps_url && (
            <a href={p.maps_url} target="_blank" rel="noreferrer" className="text-wa-500 hover:underline">
              Google Maps
            </a>
          )}
          {p.phone_e164 && (
            <a
              href={`https://wa.me/${p.phone_e164.replace(/\D/g, '')}`}
              target="_blank"
              rel="noreferrer"
              className="text-wa-500 hover:underline"
            >
              abrir no WhatsApp
            </a>
          )}
          {p.email && <span className="font-mono text-ink-300">{p.email}</span>}
        </div>

        {err && <Banner tone="bad">{err}</Banner>}

        <div>
          <p className="mb-2 text-xs font-medium text-ink-300">
            Abordagens ({p.outreaches.length})
          </p>
          {p.outreaches.length === 0 ? (
            <Empty>Nenhuma abordagem enviada.</Empty>
          ) : (
            <ul className="space-y-2">
              {p.outreaches.map((o) => (
                <li key={o.id} className="rounded-lg border border-ink-800 bg-ink-850 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-ink-300">
                      {o.kind === 'template' ? `template ${o.template_name}` : 'texto livre'}
                    </span>
                    <Badge tone={o.status === 'sent' ? 'good' : o.status === 'failed' ? 'bad' : 'neutral'}>
                      {o.status}
                    </Badge>
                  </div>
                  {o.body_preview && <p className="mt-1 text-xs text-ink-500">{o.body_preview}</p>}
                  {o.error && <p className="mt-1 text-xs text-red-300">{o.error}</p>}
                  <p className="mt-1 font-mono text-[11px] text-ink-500">
                    {when(o.sent_at ?? o.created_at)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <details>
          <summary className="cursor-pointer text-xs text-ink-500">dados crus do Google Maps</summary>
          <div className="mt-2">
            <Json value={p.raw} max={260} />
          </div>
        </details>
      </div>
    </Card>
  )
}

export default function Crm({ onChanged }: { onChanged: () => void }) {
  const [pipe, setPipe] = useState<Pipeline | null>(null)
  const [rows, setRows] = useState<Prospect[]>([])
  const [searches, setSearches] = useState<ProspectSearch[]>([])
  const [stage, setStage] = useState<string>('')
  const [searchId, setSearchId] = useState<string>('')
  const [q, setQ] = useState('')
  const [onlyMobile, setOnlyMobile] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [detail, setDetail] = useState<number | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [log, setLog] = useState<Outreach[]>([])

  const filters = {
    stage: stage || undefined,
    search_id: searchId ? Number(searchId) : undefined,
    q: q || undefined,
    only_mobile: onlyMobile,
  }

  const load = async () => {
    const [pl, list, srch, lg] = await Promise.all([
      prospectApi.pipeline().catch(() => null),
      prospectApi.prospects(filters).catch(() => []),
      prospectApi.searches().catch(() => []),
      prospectApi.outreachLog().catch(() => []),
    ])
    setPipe(pl)
    setRows(list)
    setSearches(srch)
    setLog(lg)
    onChanged()
  }

  useEffect(() => {
    void load()
  }, [stage, searchId, onlyMobile])

  // fila andando -> a tela reconsulta pra mostrar os envios saindo
  const queued = pipe?.outreach.queued ?? 0
  useEffect(() => {
    if (queued === 0) return
    const timer = setInterval(() => void load(), 4000)
    return () => clearInterval(timer)
  }, [queued])

  const allSelected = rows.length > 0 && selected.length === rows.length
  const toggleAll = () => setSelected(allSelected ? [] : rows.map((r) => r.id))

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title="Pipeline" subtitle={pipe ? `${pipe.total} prospects · ${pipe.with_mobile} com celular` : ''}>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setStage('')}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                stage === ''
                  ? 'border-wa-500 bg-wa-900/40'
                  : 'border-ink-800 bg-ink-850 hover:border-ink-500'
              }`}
            >
              <span className="block text-[11px] uppercase tracking-wide text-ink-500">Todos</span>
              <span className="block text-lg font-semibold tabular-nums text-ink-100">{pipe?.total ?? 0}</span>
            </button>
            {STAGES.map((s) => (
              <button
                key={s}
                onClick={() => setStage(stage === s ? '' : s)}
                className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                  stage === s ? 'border-wa-500 bg-wa-900/40' : 'border-ink-800 bg-ink-850 hover:border-ink-500'
                }`}
              >
                <span className="block text-[11px] uppercase tracking-wide text-ink-500">{STAGE_LABEL[s]}</span>
                <span className="block text-lg font-semibold tabular-nums text-ink-100">
                  {pipe?.stages[s] ?? 0}
                </span>
              </button>
            ))}
          </div>
          {pipe && (
            <p className="mt-4 text-xs text-ink-500">
              Abordagens: <span className="text-ink-300">{pipe.outreach.sent} enviadas</span> ·{' '}
              {pipe.outreach.queued} na fila · {pipe.outreach.failed} falharam · {pipe.sent_today} nas últimas
              24h
            </p>
          )}
        </Card>

        <OutreachConfig onSaved={() => void load()} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card
          title="Prospects"
          subtitle={`${rows.length} listado(s)`}
          actions={
            <>
              <a
                href={prospectApi.csvUrl(filters)}
                className="inline-flex items-center rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 text-xs text-ink-300 hover:border-ink-500"
              >
                CSV
              </a>
              <Button size="sm" onClick={() => void load()}>
                atualizar
              </Button>
            </>
          }
        >
          <div className="mb-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Buscar">
                <Input
                  placeholder="nome, categoria ou endereço"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void load()
                  }}
                />
              </Field>
              <Field label="Varredura de origem">
                <Select value={searchId} onChange={(e) => setSearchId(e.target.value)}>
                  <option value="">Todas</option>
                  {searches.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-5">
              <Toggle checked={onlyMobile} onChange={setOnlyMobile} label="Só celular" />
              {rows.length > 0 && (
                <Button size="sm" onClick={toggleAll}>
                  {allSelected ? 'desmarcar todos' : `marcar todos (${rows.length})`}
                </Button>
              )}
            </div>
          </div>

          {flash && (
            <div className="mb-3">
              <Banner tone="good">{flash}</Banner>
            </div>
          )}

          {rows.length === 0 ? (
            <Empty>Nenhum prospect. Rode uma varredura na aba Prospecção.</Empty>
          ) : (
            <ul className="divide-y divide-ink-800">
              {rows.map((p) => {
                const on = selected.includes(p.id)
                return (
                  <li key={p.id} className="flex items-start gap-3 py-3">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setSelected(on ? selected.filter((x) => x !== p.id) : [...selected, p.id])
                      }
                      className="mt-1 size-4 shrink-0 accent-wa-500"
                    />
                    <button onClick={() => setDetail(p.id)} className="min-w-0 flex-1 text-left">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-sm font-medium text-ink-100">{p.name}</span>
                        <span className="shrink-0 font-mono text-[11px] text-ink-500">
                          {p.phone_e164 ?? '—'}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-ink-500">
                        {[p.category, p.city].filter(Boolean).join(' · ')}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge tone={STAGE_TONE[p.stage]}>{STAGE_LABEL[p.stage]}</Badge>
                        <PhoneBadge p={p} />
                        {p.distance_km != null && <Badge>{p.distance_km.toFixed(1)} km</Badge>}
                        {p.rating != null && p.rating > 0 && (
                          <Badge tone="warn">
                            {p.rating}★ {p.reviews_count ?? 0}
                          </Badge>
                        )}
                        {!p.website && <Badge tone="info">sem site</Badge>}
                        {p.contact_id && <Badge tone="good">respondeu</Badge>}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <div className="space-y-5">
          {selected.length > 0 && (
            <SendPanel
              selected={selected}
              onClear={() => setSelected([])}
              onSent={(info) => {
                setFlash(info)
                setTimeout(() => setFlash(null), 4000)
                setSelected([])
                void load()
              }}
            />
          )}

          {detail !== null && (
            <ProspectDetailCard id={detail} onChanged={() => void load()} onClose={() => setDetail(null)} />
          )}

          <Card
            title="Log de abordagens"
            subtitle={`${log.length} registro(s)`}
            actions={
              <Button
                size="sm"
                onClick={async () => {
                  await prospectApi.drain()
                  await load()
                }}
              >
                retomar fila
              </Button>
            }
          >
            {log.length === 0 ? (
              <Empty>Nada enviado ainda.</Empty>
            ) : (
              <ul className="divide-y divide-ink-800">
                {log.slice(0, 40).map((o) => (
                  <li key={o.id} className="py-2.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm text-ink-100">{o.prospect_name ?? `#${o.prospect_id}`}</span>
                      <Badge
                        tone={
                          o.status === 'sent'
                            ? 'good'
                            : o.status === 'failed'
                              ? 'bad'
                              : o.status === 'queued'
                                ? 'info'
                                : 'neutral'
                        }
                      >
                        {o.status}
                      </Badge>
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] text-ink-500">
                      {o.to_phone ?? '—'} · {when(o.sent_at ?? o.created_at)}
                    </p>
                    {o.error && <p className="mt-1 text-xs leading-snug text-red-300">{o.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
