import { useCallback, useEffect, useState } from 'react'

import {
  attendanceApi,
  CRM_STAGE_LABEL,
  duration,
  type AiAnalysis,
  type ContactAttendance,
  type CrmStage,
} from './api'
import { Badge, Banner, Button, when } from './ui'

const TEMP_TONE: Record<string, string> = {
  quente: 'border-red-900/60 bg-red-950/40 text-red-300',
  morno: 'border-amber-900/60 bg-amber-950/40 text-amber-300',
  frio: 'border-sky-900/60 bg-sky-950/40 text-sky-300',
}
const SENT_TONE: Record<string, 'good' | 'neutral' | 'bad'> = { positivo: 'good', neutro: 'neutral', negativo: 'bad' }

export function scoreColor(score: number | null | undefined) {
  if (score === null || score === undefined) return 'text-ink-500'
  if (score >= 8) return 'text-wa-500'
  if (score >= 6) return 'text-amber-300'
  return 'text-red-300'
}

export function ScoreRing({ score, size = 56 }: { score: number | null; size?: number }) {
  const pct = Math.max(0, Math.min(1, (score ?? 0) / 10))
  const r = size / 2 - 4
  const c = 2 * Math.PI * r
  const stroke = score === null ? 'var(--color-ink-700)' : score >= 8 ? 'var(--color-wa-500)' : score >= 6 ? 'var(--color-amber-300)' : 'var(--color-red-300)'
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-ink-800)" strokeWidth="4" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`}
        />
      </svg>
      <span className={`absolute text-[15px] font-semibold tabular-nums ${scoreColor(score)}`}>
        {score === null ? '—' : score.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}
      </span>
    </div>
  )
}

export function TemperatureChip({ value }: { value: string | null }) {
  if (!value) return null
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${TEMP_TONE[value] ?? ''}`}>
      {value}
    </span>
  )
}

export function CriteriaBars({ items }: { items: { key: string; label: string; score: number | null }[] }) {
  return (
    <div className="space-y-1.5">
      {items.map((c) => (
        <div key={c.key} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5">
          <span className="truncate text-[11.5px] text-ink-300">{c.label}</span>
          <span className={`font-mono text-[11px] ${scoreColor(c.score)}`}>{c.score ?? '—'}</span>
          <div className="col-span-2 h-1 overflow-hidden rounded-full bg-ink-850">
            <div
              className={`h-full rounded-full ${
                c.score === null ? '' : c.score >= 8 ? 'bg-wa-500' : c.score >= 6 ? 'bg-amber-300' : 'bg-red-300'
              }`}
              style={{ width: `${((c.score ?? 0) / 10) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

export function AnalysisBody({
  a,
  currentStage,
  onApply,
}: {
  a: AiAnalysis
  currentStage?: CrmStage
  onApply?: (stage: CrmStage) => void
}) {
  const canApply = onApply && a.suggested_stage && a.suggested_stage !== currentStage
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <ScoreRing score={a.score} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <TemperatureChip value={a.temperature} />
            {a.sentiment && <Badge tone={SENT_TONE[a.sentiment] ?? 'neutral'}>{a.sentiment}</Badge>}
            {a.is_mql !== null && <Badge tone={a.is_mql ? 'good' : 'neutral'}>{a.is_mql ? 'MQL' : 'não MQL'}</Badge>}
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-200">{a.summary}</p>
        </div>
      </div>

      {a.suggested_stage && (
        <div className="rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] text-ink-300">
              Etapa sugerida: <span className="font-semibold text-ink-100">{a.suggested_stage_label}</span>
              {a.applied_stage && <span className="text-wa-500"> · aplicada pela IA</span>}
            </p>
            {canApply && (
              <Button size="sm" onClick={() => onApply(a.suggested_stage as CrmStage)}>
                mover para {CRM_STAGE_LABEL[a.suggested_stage as CrmStage]}
              </Button>
            )}
          </div>
          {a.stage_reason && <p className="mt-0.5 text-[11px] text-ink-500">{a.stage_reason}</p>}
        </div>
      )}

      <CriteriaBars items={a.criteria} />

      {a.objections.length > 0 && (
        <div>
          <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-500">Objeções</p>
          <div className="flex flex-wrap gap-1">
            {a.objections.map((o) => (
              <Badge key={o.key} tone="warn">
                {o.label}
              </Badge>
            ))}
          </div>
          {a.objection_notes && <p className="mt-1 text-[11.5px] text-ink-400">{a.objection_notes}</p>}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {a.strengths.length > 0 && (
          <div>
            <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-wa-500">Pontos fortes</p>
            <ul className="space-y-0.5 text-[11.5px] text-ink-300">
              {a.strengths.map((s) => (
                <li key={s}>• {s}</li>
              ))}
            </ul>
          </div>
        )}
        {a.improvements.length > 0 && (
          <div>
            <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-amber-300">Melhorar</p>
            <ul className="space-y-0.5 text-[11.5px] text-ink-300">
              {a.improvements.map((s) => (
                <li key={s}>• {s}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {a.next_action && (
        <div className="rounded-lg border border-wa-500/30 bg-wa-900/20 px-3 py-2">
          <p className="text-[10.5px] font-semibold uppercase tracking-wide text-wa-500">Próxima ação</p>
          <p className="text-[12.5px] text-ink-100">{a.next_action}</p>
        </div>
      )}
    </div>
  )
}

/** No painel do contato do CRM: tempo de resposta desta conversa + análise da IA. */
export function ContactAttendanceCard({ contactId, onChanged }: { contactId: number; onChanged?: () => void }) {
  const [data, setData] = useState<ContactAttendance | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    attendanceApi
      .contact(contactId)
      .then(setData)
      .catch((e: Error) => setError(e.message))
  }, [contactId])

  useEffect(load, [load])

  const analyze = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await attendanceApi.analyze(contactId)
      setData((d) => (d ? { ...d, analysis: r.analysis, stage: r.stage } : d))
      if (r.analysis.applied_stage) onChanged?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const apply = async (stage: CrmStage) => {
    await attendanceApi.applyStage(contactId, stage)
    load()
    onChanged?.()
  }

  if (!data) return <p className="text-xs text-ink-500">{error ?? 'carregando…'}</p>
  const r = data.response
  const a = data.analysis

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {[
          ['1ª resposta', duration(r.first_response_seconds)],
          ['mediana', duration(r.median_seconds)],
          ['média', duration(r.avg_seconds)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-ink-800 bg-ink-950/60 px-2 py-1.5 text-center">
            <p className="text-[10px] uppercase tracking-wide text-ink-500">{k}</p>
            <p className="font-mono text-[13px] text-ink-100">{v}</p>
          </div>
        ))}
      </div>
      {r.waiting_since && (
        <Banner tone="warn">Cliente aguardando resposta desde {when(r.waiting_since)}.</Banner>
      )}

      {error && <Banner tone="bad">{error}</Banner>}
      {a?.status === 'error' && <Banner tone="bad">{a.error}</Banner>}
      {a?.status === 'ok' && (
        <AnalysisBody a={a} currentStage={data.stage} onApply={(s) => void apply(s)} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={a?.status === 'ok' && !a.stale ? 'ghost' : 'primary'} onClick={analyze} disabled={busy}>
          {busy ? 'analisando…' : a?.status === 'ok' ? 'analisar de novo' : 'analisar com IA'}
        </Button>
        {a?.status === 'ok' && (
          <span className="text-[11px] text-ink-500">
            {when(a.created_at)} · {a.message_count} msgs
            {a.stale && <span className="text-amber-300"> · chegou mensagem depois</span>}
          </span>
        )}
      </div>
    </div>
  )
}
