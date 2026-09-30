import { useCallback, useEffect, useRef, useState } from 'react'

import {
  attendanceApi,
  CRM_STAGE_LABEL,
  duration,
  type AiConfig,
  type AiOverview,
  type BatchStatus,
  type FunnelData,
  type FunnelStep,
  type ResponseTimes,
} from '../api'
import { AnalysisBody, CriteriaBars, ScoreRing, TemperatureChip } from '../AttendanceParts'
import { useAuth } from '../authContext'
import { useNumber } from '../numberContext'
import { Badge, Banner, Button, Card, Empty, Info, Input, money, Toggle, when } from '../ui'

const PERIODS = [
  { value: 7, label: '7 dias' },
  { value: 30, label: '30 dias' },
  { value: 90, label: '90 dias' },
]

function pct(v: number | null | undefined, digits = 1) {
  if (v === null || v === undefined) return '—'
  return `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: digits })}%`
}

function Kpi({ label, value, hint, accent, info }: { label: string; value: string; hint?: string; accent?: boolean; info?: string }) {
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900 px-4 py-3">
      <div className="flex items-center gap-1.5">
        <p className="truncate text-[10.5px] font-medium uppercase tracking-wide text-ink-500">{label}</p>
        {info && <Info text={info} />}
      </div>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${accent ? 'text-wa-500' : 'text-ink-100'}`}>{value}</p>
      {hint && <p className="truncate text-[11px] text-ink-500">{hint}</p>}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  funil                                                                      */
/* -------------------------------------------------------------------------- */

const STEP_TONES = ['bg-ink-600', 'bg-wa-900', 'bg-wa-700', 'bg-wa-600', 'bg-wa-500', 'bg-wa-500']

function FunnelBars({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(1, steps[0]?.count ?? 1)
  return (
    <div className="space-y-2">
      {steps.map((s, i) => {
        const width = Math.max(4, (s.count / max) * 100)
        return (
          <div key={s.stage} className="grid grid-cols-[150px_1fr] items-center gap-3 sm:grid-cols-[210px_1fr]">
            <div className="min-w-0 text-right">
              <p className="truncate text-[12.5px] font-medium text-ink-100">{s.label}</p>
              <p className="text-[10.5px] text-ink-500">
                {i === 0 ? 'entrada do funil' : `${pct(s.from_previous)} da etapa anterior`}
              </p>
            </div>
            <div className="flex min-w-0 items-center gap-3">
              <div className="relative h-9 flex-1">
                <div
                  className={`flex h-full items-center rounded-md px-3 transition-[width] ${STEP_TONES[i]} ${
                    i >= 4 ? 'text-ink-950' : 'text-ink-100'
                  }`}
                  style={{ width: `${width}%`, minWidth: 44 }}
                >
                  <span className="text-[15px] font-semibold tabular-nums">{s.count.toLocaleString('pt-BR')}</span>
                </div>
              </div>
              <div className="w-24 shrink-0 text-right">
                <p className="font-mono text-[12px] text-ink-200">{i === 0 ? '100%' : pct(s.from_start)}</p>
                {s.lost_here > 0 && <p className="text-[10.5px] text-red-300">{s.lost_here} perdido(s) aqui</p>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function FunnelSection({ data }: { data: FunnelData }) {
  const closed = data.steps[data.steps.length - 1]
  const mql = data.steps[1]
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Leads no período" value={data.total.toLocaleString('pt-BR')} />
        <Kpi label="Taxa de MQL" value={pct(mql?.from_start)} hint={`${mql?.count ?? 0} qualificados`} />
        <Kpi label="Lead → fechamento" value={pct(closed?.from_start)} hint={`${closed?.count ?? 0} fechados`} accent />
        <Kpi
          label="Receita fechada"
          value={money(data.revenue)}
          hint={data.avg_ticket ? `ticket médio ${money(data.avg_ticket)}` : 'informe o valor ao fechar'}
        />
        <Kpi label="Perdidos" value={data.lost.toLocaleString('pt-BR')} hint="saíram do funil" />
      </div>

      <Card
        title="Funil de atendimento"
        subtitle="Quantos leads alcançaram cada etapa. Quem fechou conta em todas as anteriores; quem foi perdido conta até onde chegou."
      >
        {data.total === 0 ? <Empty>Nenhum lead no período.</Empty> : <FunnelBars steps={data.steps} />}
        <div className="mt-4 grid gap-2 border-t border-ink-800 pt-3 text-[11.5px] text-ink-400 sm:grid-cols-2 lg:grid-cols-3">
          <p>
            <span className="text-ink-200">MQL</span> — marcado à mão, por regra de palavra-chave ou pela análise da IA.
          </p>
          <p>
            <span className="text-ink-200">Continuou a conversa</span> — automático: o lead MQL voltou a responder depois
            do atendente.
          </p>
          <p>
            <span className="text-ink-200">Agendamento, comparecimento e fechamento</span> — à mão no CRM, por regra
            (“agendamento confirmado”) ou pela IA.
          </p>
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[2fr_1fr]">
        <Card title="Funil por origem" subtitle="Onde cada canal perde e onde converte">
          {data.by_origin.length === 0 ? (
            <Empty>Sem leads no período.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[12.5px]">
                <thead>
                  <tr className="border-b border-ink-800 text-[10.5px] uppercase tracking-wide text-ink-500">
                    <th className="px-2 py-2 font-medium">Origem</th>
                    {data.steps.map((s) => (
                      <th key={s.stage} className="px-2 py-2 text-right font-medium">
                        {CRM_STAGE_LABEL[s.stage]}
                      </th>
                    ))}
                    <th className="px-2 py-2 text-right font-medium">Conv.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800">
                  {data.by_origin.map((o) => {
                    const last = o.steps[o.steps.length - 1]
                    return (
                      <tr key={o.label}>
                        <td className="max-w-[180px] truncate px-2 py-2 text-ink-100">{o.label}</td>
                        {o.steps.map((s) => (
                          <td key={s.stage} className="px-2 py-2 text-right font-mono text-ink-300">
                            {s.count}
                          </td>
                        ))}
                        <td className="px-2 py-2 text-right font-mono text-wa-500">{pct(last?.from_start)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Tempo até cada etapa" subtitle="Mediana, contada da entrada do lead">
          <div className="space-y-2">
            {data.timing.map((t) => (
              <div key={t.stage} className="flex items-center justify-between gap-3 text-[12.5px]">
                <span className="text-ink-300">{t.label}</span>
                <span className="font-mono text-ink-100">
                  {t.median_days === null ? '—' : duration(t.median_days * 86400)}
                  <span className="text-ink-500"> · {t.count}</span>
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  tempo de resposta                                                          */
/* -------------------------------------------------------------------------- */

function ResponseSection({ data }: { data: ResponseTimes }) {
  const maxBucket = Math.max(1, ...data.buckets.map((b) => b.count))
  const hours = data.by_hour
  const maxHour = Math.max(1, ...hours.map((h) => h.median_seconds ?? 0))
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi
          label="1ª resposta (mediana)"
          value={duration(data.first_response.median_seconds)}
          hint={`média ${duration(data.first_response.avg_seconds)}`}
          accent
          info="Quanto o lead espera pela primeira resposta da conversa. É o número que mais pesa em lead de anúncio."
        />
        <Kpi
          label="Resposta (mediana)"
          value={duration(data.responses.median_seconds)}
          hint={`média ${duration(data.responses.avg_seconds)} · p90 ${duration(data.responses.p90_seconds)}`}
          info="Toda vez que o cliente escreve e espera. A média é puxada por mensagens da madrugada; a mediana mostra o normal."
        />
        <Kpi label="Em até 5 min" value={pct(data.within_5min, 0)} hint={`${data.responses.count} respostas`} />
        <Kpi label="Sem resposta" value={String(data.unanswered)} hint="esperas do período ainda abertas" />
        <Kpi label="Aguardando agora" value={String(data.waiting_now_count)} hint="cliente falou por último" />
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card title="Faixas de tempo" subtitle="Distribuição das respostas">
          <div className="space-y-2">
            {data.buckets.map((b, i) => (
              <div key={b.label}>
                <div className="mb-0.5 flex justify-between text-[12px]">
                  <span className="text-ink-300">{b.label}</span>
                  <span className="font-mono text-ink-400">
                    {b.count} · {pct(b.share, 0)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-ink-850">
                  <div
                    className={`h-full rounded-full ${i === 0 ? 'bg-wa-500' : i === 1 ? 'bg-wa-700' : i === 2 ? 'bg-amber-300' : 'bg-red-300'}`}
                    style={{ width: `${(b.count / maxBucket) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Por hora do dia" subtitle="Mediana da resposta pela hora em que o cliente escreveu">
          <div className="flex h-36 items-end gap-[3px]">
            {hours.map((h) => (
              <div
                key={h.hour}
                className="flex h-full flex-1 flex-col justify-end"
                title={`${h.hour}h: ${duration(h.median_seconds)} (${h.count})`}
              >
                <div
                  className={`w-full rounded-t-sm ${
                    h.median_seconds === null
                      ? 'bg-ink-850'
                      : h.median_seconds < 300
                        ? 'bg-wa-500'
                        : h.median_seconds < 1800
                          ? 'bg-wa-700'
                          : h.median_seconds < 7200
                            ? 'bg-amber-300'
                            : 'bg-red-300'
                  }`}
                  style={{ height: `${h.median_seconds === null ? 3 : Math.max(4, (h.median_seconds / maxHour) * 100)}%` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-500">
            <span>0h</span>
            <span>6h</span>
            <span>12h</span>
            <span>18h</span>
            <span>23h</span>
          </div>
          <div className="mt-3 grid grid-cols-7 gap-1 text-center">
            {data.by_weekday.map((d) => (
              <div key={d.day} className="rounded-md bg-ink-950/60 px-1 py-1">
                <p className="text-[10px] uppercase text-ink-500">{d.day}</p>
                <p className="font-mono text-[11px] text-ink-200">{duration(d.median_seconds)}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Aguardando resposta agora" subtitle="Quem falou por último e está esperando há mais tempo">
          {data.waiting_now.length === 0 ? (
            <Empty>Ninguém esperando. 👏</Empty>
          ) : (
            <div className="divide-y divide-ink-800">
              {data.waiting_now.map((w) => (
                <div key={w.contact_id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px] text-ink-100">{w.name ?? `#${w.contact_id}`}</p>
                    <p className="text-[10.5px] text-ink-500">{w.stage ? CRM_STAGE_LABEL[w.stage] : ''}</p>
                  </div>
                  <span
                    className={`shrink-0 font-mono text-[12px] ${
                      w.seconds < 300 ? 'text-wa-500' : w.seconds < 3600 ? 'text-amber-300' : 'text-red-300'
                    }`}
                  >
                    {duration(w.seconds)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  IA                                                                         */
/* -------------------------------------------------------------------------- */

function AiSetup({ cfg, onSaved }: { cfg: AiConfig; onSaved: (c: AiConfig) => void }) {
  const { isAdmin } = useAuth()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (patch: Parameters<typeof attendanceApi.saveAiConfig>[0]) => {
    setBusy(true)
    try {
      onSaved(await attendanceApi.saveAiConfig(patch))
      setKey('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3 text-[12px]">
      {cfg.configured ? (
        <Badge tone="good">Claude conectado · chave {cfg.key_hint}</Badge>
      ) : (
        <Badge tone="warn">sem chave da API da Anthropic</Badge>
      )}
      <span className="text-ink-500">
        modelo <span className="font-mono text-ink-300">{cfg.model}</span>
      </span>
      {isAdmin ? (
        <>
          <div className="w-64">
            <Input
              type="password"
              placeholder={cfg.configured ? 'trocar chave (sk-ant-…)' : 'chave da API (sk-ant-…)'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </div>
          <Button size="sm" variant="primary" disabled={busy || key.trim().length < 10} onClick={() => void save({ anthropic_api_key: key })}>
            salvar chave
          </Button>
          <Toggle
            checked={cfg.auto_apply_stage}
            onChange={(v) => void save({ auto_apply_stage: v })}
            label="IA move a etapa sozinha (só avança)"
          />
        </>
      ) : (
        !cfg.configured && <span className="text-ink-500">peça a um administrador para configurar a chave</span>
      )}
    </div>
  )
}

function AiSection({ numberId, days }: { numberId?: number; days: number }) {
  const [cfg, setCfg] = useState<AiConfig | null>(null)
  const [ov, setOv] = useState<AiOverview | null>(null)
  const [batch, setBatch] = useState<BatchStatus | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const poll = useRef<number | undefined>(undefined)

  const load = useCallback(() => {
    attendanceApi.aiConfig().then(setCfg).catch((e: Error) => setError(e.message))
    attendanceApi.aiOverview(numberId, days).then(setOv).catch((e: Error) => setError(e.message))
  }, [numberId, days])

  useEffect(load, [load])

  const watch = useCallback(() => {
    window.clearInterval(poll.current)
    poll.current = window.setInterval(async () => {
      const s = await attendanceApi.batchStatus(numberId).catch(() => null)
      if (!s) return
      setBatch(s)
      if (!s.running) {
        window.clearInterval(poll.current)
        load()
      }
    }, 2500)
  }, [numberId, load])

  useEffect(() => {
    attendanceApi
      .batchStatus(numberId)
      .then((s) => {
        setBatch(s)
        if (s.running) watch()
      })
      .catch(() => undefined)
    return () => window.clearInterval(poll.current)
  }, [numberId, watch])

  const runBatch = async (limit: number) => {
    setError(null)
    try {
      const s = await attendanceApi.batch(numberId, limit)
      setBatch(s)
      if (s.running) watch()
      else if (s.total === 0) setError('Nenhuma conversa nova para analisar — todas já estão em dia.')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (!cfg) return <p className="text-sm text-ink-500">carregando…</p>
  const maxObj = Math.max(1, ...(ov?.objections.map((o) => o.count) ?? [1]))
  const tempTotal = Math.max(1, ov?.temperature.reduce((a, t) => a + t.count, 0) ?? 1)

  return (
    <div className="space-y-5">
      <Card
        title="Análise de atendimento com IA"
        subtitle="O Claude lê cada conversa, dá nota ao atendimento, diz se o lead é MQL, em que etapa está, as objeções e a próxima ação"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void runBatch(20)} disabled={!cfg.configured || !!batch?.running}>
              analisar 20 conversas
            </Button>
            <Button size="sm" variant="primary" onClick={() => void runBatch(100)} disabled={!cfg.configured || !!batch?.running}>
              analisar 100
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <AiSetup cfg={cfg} onSaved={setCfg} />
          {batch?.running && (
            <div>
              <div className="mb-1 flex justify-between text-[12px] text-ink-300">
                <span>analisando conversas…</span>
                <span className="font-mono">
                  {batch.done}/{batch.total}
                  {batch.errors ? ` · ${batch.errors} erro(s)` : ''}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-ink-850">
                <div className="h-full rounded-full bg-wa-500 transition-[width]" style={{ width: `${(batch.done / Math.max(1, batch.total)) * 100}%` }} />
              </div>
            </div>
          )}
          {!batch?.running && batch?.last_error && <Banner tone="bad">Último erro do lote: {batch.last_error}</Banner>}
          {error && <Banner tone="warn">{error}</Banner>}
          <p className="text-[11px] text-ink-500">
            O lote pega só conversas sem análise ou com mensagem nova desde a última — cada conversa é uma chamada à API
            da Anthropic, cobrada na sua conta.
          </p>
        </div>
      </Card>

      {ov && ov.analyzed === 0 && <Empty>Nenhuma conversa analisada no período ainda.</Empty>}

      {ov && ov.analyzed > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900 px-4 py-3">
              <ScoreRing score={ov.avg_score} size={60} />
              <div>
                <p className="text-[10.5px] font-medium uppercase tracking-wide text-ink-500">Nota média</p>
                <p className="text-[11px] text-ink-500">{ov.analyzed} conversas analisadas</p>
              </div>
            </div>
            <Kpi label="Leads MQL (IA)" value={pct(ov.mql_rate, 0)} hint="das conversas analisadas" accent />
            <div className="rounded-xl border border-ink-800 bg-ink-900 px-4 py-3">
              <p className="text-[10.5px] font-medium uppercase tracking-wide text-ink-500">Temperatura</p>
              <div className="mt-2 flex h-2.5 overflow-hidden rounded-full">
                {ov.temperature.map((t) => (
                  <div
                    key={t.value}
                    className={t.value === 'quente' ? 'bg-red-300' : t.value === 'morno' ? 'bg-amber-300' : 'bg-sky-300'}
                    style={{ width: `${(t.count / tempTotal) * 100}%` }}
                  />
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-ink-400">
                {ov.temperature.map((t) => `${t.count} ${t.value}`).join(' · ')}
              </p>
            </div>
            <Kpi
              label="Sentimento"
              value={`${ov.sentiment.find((s) => s.value === 'positivo')?.count ?? 0} positivos`}
              hint={ov.sentiment.map((s) => `${s.count} ${s.value}`).join(' · ')}
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            <Card title="Nota por critério" subtitle="Média das conversas analisadas (0 a 10)">
              <CriteriaBars items={ov.criteria.map((c) => ({ key: c.key, label: c.label, score: c.avg }))} />
            </Card>
            <Card title="Objeções mais comuns" subtitle="O que trava o lead">
              {ov.objections.length === 0 ? (
                <Empty>Nenhuma objeção registrada.</Empty>
              ) : (
                <div className="space-y-2">
                  {ov.objections.map((o) => (
                    <div key={o.key}>
                      <div className="mb-0.5 flex justify-between text-[12px]">
                        <span className="text-ink-200">{o.label}</span>
                        <span className="font-mono text-ink-400">{o.count}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-ink-850">
                        <div className="h-full rounded-full bg-amber-300" style={{ width: `${(o.count / maxObj) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="O que mais precisa melhorar" subtitle="Pontos de melhoria que mais se repetem">
              {ov.top_improvements.length === 0 ? (
                <Empty>Nada recorrente.</Empty>
              ) : (
                <ul className="space-y-1.5 text-[12.5px] text-ink-200">
                  {ov.top_improvements.map((t) => (
                    <li key={t.text} className="flex justify-between gap-3">
                      <span>• {t.text}</span>
                      {t.count > 1 && <span className="shrink-0 font-mono text-[11px] text-ink-500">{t.count}×</span>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card title="Conversas analisadas" subtitle="Da pior nota para a melhor — clique para ver a análise completa">
            <div className="divide-y divide-ink-800">
              {ov.items.map((a) => (
                <div key={a.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(open === a.id ? null : a.id)}
                    className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-ink-850/50"
                  >
                    <ScoreRing score={a.score} size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium text-ink-100">{a.name ?? `#${a.contact_id}`}</span>
                        <TemperatureChip value={a.temperature} />
                        {a.is_mql && <Badge tone="good">MQL</Badge>}
                        {a.stage && <Badge>{CRM_STAGE_LABEL[a.stage]}</Badge>}
                        {a.stale && <Badge tone="warn">mensagem nova</Badge>}
                      </div>
                      <p className="truncate text-[12px] text-ink-400">{a.summary}</p>
                    </div>
                    <span className="hidden shrink-0 text-[11px] text-ink-500 sm:block">{when(a.created_at)}</span>
                  </button>
                  {open === a.id && (
                    <div className="mb-3 rounded-lg border border-ink-800 bg-ink-950/50 p-3">
                      <AnalysisBody a={a} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

type Section = 'funil' | 'resposta' | 'ia'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'funil', label: 'Funil' },
  { id: 'resposta', label: 'Tempo de resposta' },
  { id: 'ia', label: 'Análise com IA' },
]

export default function Atendimento() {
  const { numberId } = useNumber()
  const [days, setDays] = useState(30)
  const [section, setSection] = useState<Section>('funil')
  const [funnelData, setFunnel] = useState<FunnelData | null>(null)
  const [rt, setRt] = useState<ResponseTimes | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    attendanceApi.funnel(numberId, days).then(setFunnel).catch((e: Error) => setError(e.message))
    attendanceApi.responseTimes(numberId, days).then(setRt).catch((e: Error) => setError(e.message))
  }, [numberId, days])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-ink-800 bg-ink-900 p-1">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={`rounded-md px-3 py-1.5 text-[13px] transition-colors ${
                section === s.id ? 'bg-wa-500 font-semibold text-ink-950' : 'text-ink-300 hover:text-ink-100'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
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

      {error && <Banner tone="bad">{error}</Banner>}

      {section === 'funil' && (funnelData ? <FunnelSection data={funnelData} /> : <p className="text-sm text-ink-500">carregando…</p>)}
      {section === 'resposta' && (rt ? <ResponseSection data={rt} /> : <p className="text-sm text-ink-500">carregando…</p>)}
      {section === 'ia' && <AiSection numberId={numberId} days={days} />}
    </div>
  )
}
