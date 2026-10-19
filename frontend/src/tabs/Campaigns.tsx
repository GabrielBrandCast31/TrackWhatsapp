import { Fragment, useCallback, useEffect, useRef, useState } from 'react'

import {
  broadcastApi,
  CRM_STAGE_LABEL,
  CRM_STAGES,
  type AudienceFilters,
  type AudiencePreview,
  type Broadcast,
  type BroadcastDetail,
  type BroadcastMessage,
  type WaTemplate,
} from '../api'
import { NO_NUMBER_MESSAGE, useNumber } from '../numberContext'
import { Badge, Banner, Button, Card, Empty, Field, Input, Json, Select, Textarea, Toggle, when } from '../ui'

/** Canais da etiqueta "de onde veio" do CRM (`lead_source.channel`). */
const CHANNELS: { value: string; label: string }[] = [
  { value: 'meta_ads', label: 'Meta Ads' },
  { value: 'google_ads', label: 'Google Ads' },
  { value: 'utm', label: 'Link com UTM' },
  { value: 'organic', label: 'Orgânico' },
  { value: 'agenda', label: 'Agenda' },
]

const VARIABLES = ['{primeiro_nome}', '{nome}', '{telefone}']

const STATUS: Record<Broadcast['status'], { label: string; tone: 'neutral' | 'good' | 'bad' | 'warn' | 'info' }> = {
  draft: { label: 'rascunho', tone: 'neutral' },
  running: { label: 'enviando', tone: 'good' },
  paused: { label: 'pausada', tone: 'warn' },
  done: { label: 'concluída', tone: 'info' },
  canceled: { label: 'cancelada', tone: 'bad' },
}

const EXAMPLE =
  '{Oi|Olá|E aí} {primeiro_nome}, tudo bem? 😊\n\n' +
  'Essa semana estamos com uma condição especial: *20% de desconto* para quem já é nosso cliente.\n\n' +
  'Quer que eu te mande os detalhes?'

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
        active
          ? 'border-wa-500/60 bg-wa-900/50 text-wa-500'
          : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-500 hover:text-ink-100'
      }`}
    >
      {children}
    </button>
  )
}

function toggle(list: string[] | undefined, value: string): string[] {
  const set = new Set(list ?? [])
  if (set.has(value)) set.delete(value)
  else set.add(value)
  return [...set]
}

function Progress({ b }: { b: Broadcast }) {
  const { total, sent, failed, skipped } = b.stats
  const pct = (n: number) => (total ? (n / total) * 100 : 0)
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
      <div className="bg-wa-500" style={{ width: `${pct(sent)}%` }} />
      <div className="bg-red-400" style={{ width: `${pct(failed)}%` }} />
      <div className="bg-ink-500" style={{ width: `${pct(skipped)}%` }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// nova campanha
// ---------------------------------------------------------------------------

function Composer({ numberId, channel, onCreated }: { numberId: number; channel: string; onCreated: () => void }) {
  const cloud = channel !== 'evolution'
  const [name, setName] = useState('')
  const [text, setText] = useState(EXAMPLE)
  const [footer, setFooter] = useState(true)
  const [templates, setTemplates] = useState<WaTemplate[]>([])
  const [template, setTemplate] = useState('')
  const [params, setParams] = useState<string[]>([])
  const [filters, setFilters] = useState<AudienceFilters>({ exclude_recent_days: 3 })
  const [audience, setAudience] = useState<AudiencePreview | null>(null)
  const [variations, setVariations] = useState<string[] | null>(null)
  const [throttle, setThrottle] = useState(20)
  const [jitter, setJitter] = useState(15)
  const [cap, setCap] = useState(200)
  const [winStart, setWinStart] = useState(8)
  const [winEnd, setWinEnd] = useState(20)
  const [testPhone, setTestPhone] = useState('')
  const [testName, setTestName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!cloud) return
    broadcastApi
      .templates(numberId)
      .then((rows) => setTemplates(rows.filter((t) => t.approved)))
      .catch((e) => setMsg({ tone: 'bad', text: (e as Error).message }))
  }, [cloud, numberId])

  // audiência ao vivo: recalcula meio segundo depois do último clique no filtro
  useEffect(() => {
    const t = setTimeout(() => {
      broadcastApi
        .audience(numberId, filters)
        .then(setAudience)
        .catch(() => setAudience(null))
    }, 400)
    return () => clearTimeout(t)
  }, [numberId, filters])

  const selected = templates.find((t) => t.name === template)
  useEffect(() => {
    setParams((prev) => Array.from({ length: selected?.placeholders ?? 0 }, (_, i) => prev[i] ?? (i === 0 ? '{primeiro_nome}' : '')))
  }, [selected])

  const message = (): BroadcastMessage =>
    cloud
      ? {
          kind: 'template',
          template_name: template,
          template_language: selected?.language,
          template_params: params,
        }
      : { kind: 'text', text, opt_out_footer: footer }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const insert = (token: string) => {
    const el = textRef.current
    if (!el) return setText((t) => t + token)
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    setText(text.slice(0, start) + token + text.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }

  const preview = () =>
    run(async () => {
      const r = await broadcastApi.preview(message(), testName || undefined)
      setVariations(r.variations)
    })

  const sendTest = () =>
    run(async () => {
      const r = await broadcastApi.test({
        ...message(),
        number_id: numberId,
        phone: testPhone,
        sample_name: testName || undefined,
      })
      setMsg({ tone: 'good', text: `Teste enviado para ${r.to}. Confira no WhatsApp como a mensagem chegou.` })
    })

  const create = (start: boolean) =>
    run(async () => {
      if (!name.trim()) throw new Error('Dê um nome para a campanha.')
      if (!audience?.count) throw new Error('Nenhum contato entra nesse filtro.')
      if (
        start &&
        !window.confirm(
          `Enviar "${name}" para ${audience.count} contato(s)?\n\n` +
            `Ritmo: 1 mensagem a cada ${throttle}–${throttle + jitter}s, até ${cap}/dia, das ${winStart}h às ${winEnd}h.`,
        )
      )
        return
      await broadcastApi.create({
        ...message(),
        number_id: numberId,
        name,
        filters,
        throttle_seconds: throttle,
        jitter_seconds: jitter,
        daily_cap: cap,
        window_start_hour: winStart,
        window_end_hour: winEnd,
        start,
      })
      setMsg({ tone: 'good', text: start ? 'Campanha iniciada — acompanhe o envio abaixo.' : 'Rascunho salvo.' })
      setName('')
      onCreated()
    })

  const eta = audience?.count ? Math.ceil((audience.count * (throttle + jitter / 2)) / 60) : 0

  return (
    <Card
      title="Nova campanha"
      subtitle="Mensagem de venda para os contatos do CRM desta linha. Teste no seu número antes de disparar."
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* --- mensagem --- */}
        <div className="space-y-4">
          <Field label="Nome da campanha" hint="Só pra você: aparece na lista e no histórico.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Black Friday — clientes antigos" />
          </Field>

          {cloud ? (
            <>
              <Banner tone="warn">
                Linha da <strong>Cloud API</strong>: fora da janela de 24h a Meta só entrega <strong>template aprovado</strong>{' '}
                (categoria Marketing). Crie o template no WhatsApp Manager e ele aparece aqui.
              </Banner>
              <Field label="Template aprovado">
                <Select value={template} onChange={(e) => setTemplate(e.target.value)}>
                  <option value="">— escolha —</option>
                  {templates.map((t) => (
                    <option key={`${t.name}:${t.language}`} value={t.name}>
                      {t.name} · {t.language} · {t.category}
                    </option>
                  ))}
                </Select>
              </Field>
              {selected && (
                <div className="space-y-2">
                  <p className="whitespace-pre-wrap rounded-lg border border-ink-800 bg-ink-950 p-3 text-xs text-ink-300">
                    {selected.body}
                  </p>
                  {params.map((p, i) => (
                    <Field key={i} label={`{{${i + 1}}}`}>
                      <Input value={p} onChange={(e) => setParams(params.map((x, j) => (j === i ? e.target.value : x)))} />
                    </Field>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <Field
                label="Mensagem"
                hint="{Oi|Olá} sorteia uma opção por pessoa — variar o texto reduz o risco de bloqueio. *negrito*, _itálico_."
              >
                <Textarea ref={textRef} rows={8} value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-ink-500">Inserir:</span>
                {VARIABLES.map((v) => (
                  <Chip key={v} active={false} onClick={() => insert(v)}>
                    {v}
                  </Chip>
                ))}
              </div>
              <Toggle checked={footer} onChange={setFooter} label='Rodapé "Responda SAIR para não receber mais"' />
            </>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={preview} disabled={busy}>
              Ver 3 variações
            </Button>
          </div>
          {variations && (
            <div className="grid gap-2">
              {variations.map((v, i) => (
                <p
                  key={i}
                  className="whitespace-pre-wrap rounded-lg rounded-tl-none border border-wa-500/20 bg-wa-900/30 p-3 text-xs text-ink-100"
                >
                  {v}
                </p>
              ))}
            </div>
          )}

          <div className="rounded-lg border border-ink-800 bg-ink-950/50 p-3">
            <p className="mb-2 text-xs font-medium text-ink-300">1. Enviar teste para o seu WhatsApp</p>
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Input value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="(11) 98888-7777" />
              <Input value={testName} onChange={(e) => setTestName(e.target.value)} placeholder="nome de exemplo" />
              <Button onClick={sendTest} disabled={busy || testPhone.length < 8}>
                Enviar teste
              </Button>
            </div>
          </div>
        </div>

        {/* --- audiência e ritmo --- */}
        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-300">Etapa do funil (vazio = todas)</p>
            <div className="flex flex-wrap gap-1.5">
              {CRM_STAGES.map((s) => (
                <Chip
                  key={s}
                  active={!!filters.stages?.includes(s)}
                  onClick={() => setFilters({ ...filters, stages: toggle(filters.stages, s) })}
                >
                  {CRM_STAGE_LABEL[s]}
                </Chip>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-300">Origem do lead (vazio = todas)</p>
            <div className="flex flex-wrap gap-1.5">
              {CHANNELS.map((c) => (
                <Chip
                  key={c.value}
                  active={!!filters.channels?.includes(c.value)}
                  onClick={() => setFilters({ ...filters, channels: toggle(filters.channels, c.value) })}
                >
                  {c.label}
                </Chip>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Sem falar há (dias)" hint="reativação">
              <Input
                type="number"
                min={0}
                value={filters.inactive_days ?? 0}
                onChange={(e) => setFilters({ ...filters, inactive_days: Number(e.target.value) || 0 })}
              />
            </Field>
            <Field label="Falou nos últimos (dias)" hint="lead quente">
              <Input
                type="number"
                min={0}
                value={filters.active_days ?? 0}
                onChange={(e) => setFilters({ ...filters, active_days: Number(e.target.value) || 0 })}
              />
            </Field>
            <Field label="Não repetir em (dias)" hint="já recebeu campanha">
              <Input
                type="number"
                min={0}
                value={filters.exclude_recent_days ?? 0}
                onChange={(e) => setFilters({ ...filters, exclude_recent_days: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>

          <div className="rounded-lg border border-ink-800 bg-ink-950/50 p-3">
            <p className="text-xs text-ink-500">Audiência</p>
            <p className="text-2xl font-semibold tabular-nums text-wa-500">{audience?.count ?? '…'}</p>
            {audience && (
              <p className="mt-1 text-[11px] text-ink-500">
                fora: {audience.dropped.opted_out} descadastrado(s) · {audience.dropped.recent} já receberam ·{' '}
                {audience.dropped.no_destination} sem número · {audience.dropped.filtered} pelo filtro
                {' · '}enviadas nas últimas 24h: {audience.sent_last_24h}
              </p>
            )}
            {audience && audience.sample.length > 0 && (
              <p className="mt-2 line-clamp-2 text-[11px] text-ink-300">
                {audience.sample
                  .slice(0, 12)
                  .map((c) => c.name || c.phone_e164 || c.wa_id)
                  .join(', ')}
                {audience.count > 12 ? '…' : ''}
              </p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Intervalo (s)" hint="mínimo 5">
              <Input type="number" min={5} value={throttle} onChange={(e) => setThrottle(Number(e.target.value) || 5)} />
            </Field>
            <Field label="+ variação (s)" hint="sorteada a cada envio">
              <Input type="number" min={0} value={jitter} onChange={(e) => setJitter(Number(e.target.value) || 0)} />
            </Field>
            <Field label="Limite por dia" hint="por linha">
              <Input type="number" min={0} value={cap} onChange={(e) => setCap(Number(e.target.value) || 0)} />
            </Field>
            <Field label="Enviar a partir de (h)">
              <Input type="number" min={0} max={23} value={winStart} onChange={(e) => setWinStart(Number(e.target.value))} />
            </Field>
            <Field label="Até (h)">
              <Input type="number" min={0} max={24} value={winEnd} onChange={(e) => setWinEnd(Number(e.target.value))} />
            </Field>
            <div className="self-end pb-2 text-[11px] text-ink-500">
              {eta ? `≈ ${eta < 60 ? `${eta} min` : `${(eta / 60).toFixed(1)} h`} de envio` : ''}
            </div>
          </div>

          {!cloud && (
            <Banner tone="warn">
              A Evolution conecta como aparelho, não é API oficial. Disparo para quem <strong>não</strong> conversa com você,
              ritmo rápido e texto repetido levam a bloqueio do número. Prefira a base que já falou com a linha, mantenha
              o intervalo e o limite diário.
            </Banner>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => create(false)} disabled={busy}>
              Salvar rascunho
            </Button>
            <Button variant="primary" onClick={() => create(true)} disabled={busy || !audience?.count}>
              2. Criar e iniciar envio
            </Button>
          </div>
        </div>
      </div>
      {msg && (
        <div className="mt-4">
          <Banner tone={msg.tone}>{msg.text}</Banner>
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// detalhe
// ---------------------------------------------------------------------------

function Detail({ id }: { id: number }) {
  const [data, setData] = useState<BroadcastDetail | null>(null)
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      broadcastApi
        .get(id, status || undefined)
        .then((d) => alive && setData(d))
        .catch(() => undefined)
    void load()
    const t = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [id, status])

  if (!data) return <p className="text-xs text-ink-500">carregando…</p>

  return (
    <div className="space-y-3">
      {data.text && (
        <p className="whitespace-pre-wrap rounded-lg border border-ink-800 bg-ink-950 p-3 text-xs text-ink-300">{data.text}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {['', 'queued', 'sent', 'failed', 'skipped'].map((s) => (
          <Chip key={s} active={status === s} onClick={() => setStatus(s)}>
            {s || 'todos'}
          </Chip>
        ))}
      </div>
      <div className="max-h-[420px] overflow-auto rounded-lg border border-ink-800">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-ink-900 text-ink-500">
            <tr>
              <th className="px-3 py-2">Contato</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Enviada</th>
              <th className="px-3 py-2">Resposta</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {data.recipients.map((r) => (
              <Fragment key={r.id}>
                <tr className="border-t border-ink-800">
                  <td className="px-3 py-2 text-ink-100">
                    {r.name || '—'} <span className="text-ink-500">{r.to.replace('@lid', ' (lid)')}</span>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={r.status === 'sent' ? 'good' : r.status === 'failed' ? 'bad' : 'neutral'}>{r.status}</Badge>
                    {r.error && <span className="ml-2 text-red-300">{r.error.slice(0, 80)}</span>}
                  </td>
                  <td className="px-3 py-2 text-ink-300">{r.sent_at ? when(r.sent_at) : '—'}</td>
                  <td className="px-3 py-2">{r.replied ? <Badge tone="good">respondeu</Badge> : ''}</td>
                  <td className="px-3 py-2 text-right">
                    {(r.body || r.error) && (
                      <button className="text-ink-500 hover:text-ink-100" onClick={() => setOpen(open === r.id ? null : r.id)}>
                        {open === r.id ? 'fechar' : 'ver'}
                      </button>
                    )}
                  </td>
                </tr>
                {open === r.id && (
                  <tr className="bg-ink-950">
                    <td colSpan={5} className="space-y-2 px-3 py-3">
                      {r.body && <p className="whitespace-pre-wrap text-ink-100">{r.body}</p>}
                      <Json value={{ request: r.request_payload, response: r.response_body }} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {data.recipients.length === 0 && <p className="px-3 py-6 text-center text-xs text-ink-500">nada aqui</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// aba
// ---------------------------------------------------------------------------

export default function Campaigns() {
  const { numberId, current } = useNumber()
  const [rows, setRows] = useState<Broadcast[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    broadcastApi
      .list(numberId)
      .then(setRows)
      .catch((e) => setErr((e as Error).message))
  }, [numberId])

  useEffect(load, [load])
  // enquanto houver campanha enviando, a lista se atualiza sozinha
  const running = rows.some((r) => r.status === 'running')
  useEffect(() => {
    if (!running) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [running, load])

  const act = async (fn: () => Promise<unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return
    setErr(null)
    try {
      await fn()
      load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div className="space-y-5">
      {numberId && current ? (
        <Composer key={numberId} numberId={numberId} channel={current.channel || 'evolution'} onCreated={load} />
      ) : (
        <Banner tone="warn">{NO_NUMBER_MESSAGE}</Banner>
      )}

      {err && <Banner tone="bad">{err}</Banner>}

      <Card title="Campanhas" subtitle="Quem recebeu, quem respondeu e o que falhou. Resposta = o contato escreveu depois do envio.">
        {rows.length === 0 ? (
          <Empty>Nenhuma campanha ainda.</Empty>
        ) : (
          <div className="space-y-3">
            {rows.map((b) => {
              const s = b.stats
              const rate = s.sent ? Math.round((s.replied / s.sent) * 100) : 0
              return (
                <div key={b.id} className="rounded-xl border border-ink-800 bg-ink-950/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold text-ink-100">{b.name}</p>
                        <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Badge>
                      </div>
                      <p className="mt-0.5 text-[11px] text-ink-500">
                        {when(b.created_at)}
                        {b.created_by ? ` · ${b.created_by}` : ''} · {b.throttle_seconds}–{b.throttle_seconds + b.jitter_seconds}s
                        · até {b.daily_cap}/dia · {b.window_start_hour}h–{b.window_end_hour}h
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(b.status === 'draft' || b.status === 'paused') && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() =>
                            act(
                              () => broadcastApi.start(b.id),
                              b.status === 'draft' ? `Iniciar envio para ${s.queued} contato(s)?` : undefined,
                            )
                          }
                        >
                          {b.status === 'draft' ? 'Iniciar' : 'Retomar'}
                        </Button>
                      )}
                      {b.status === 'running' && (
                        <Button size="sm" onClick={() => act(() => broadcastApi.pause(b.id))}>
                          Pausar
                        </Button>
                      )}
                      {s.failed > 0 && b.status !== 'canceled' && (
                        <Button size="sm" onClick={() => act(() => broadcastApi.retryFailed(b.id))}>
                          Reenviar falhas
                        </Button>
                      )}
                      {['draft', 'running', 'paused'].includes(b.status) && (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => act(() => broadcastApi.cancel(b.id), 'Cancelar? Quem ainda não recebeu não recebe mais.')}
                        >
                          Cancelar
                        </Button>
                      )}
                      {b.status !== 'running' && (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => act(() => broadcastApi.remove(b.id), 'Apagar a campanha e o histórico de envio?')}
                        >
                          Apagar
                        </Button>
                      )}
                      <Button size="sm" onClick={() => setExpanded(expanded === b.id ? null : b.id)}>
                        {expanded === b.id ? 'Fechar' : 'Detalhes'}
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 space-y-2">
                    <Progress b={b} />
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-ink-300">
                      <span>
                        <strong className="text-wa-500">{s.sent}</strong>/{s.total} enviadas
                      </span>
                      <span>{s.queued} na fila</span>
                      <span className={s.failed ? 'text-red-300' : ''}>{s.failed} falharam</span>
                      <span>{s.skipped} puladas</span>
                      <span>
                        <strong className="text-ink-100">{s.replied}</strong> responderam ({rate}%)
                      </span>
                    </div>
                    {b.pause_reason && b.status === 'paused' && <Banner tone="warn">{b.pause_reason}</Banner>}
                  </div>

                  {expanded === b.id && (
                    <div className="mt-4">
                      <Detail id={b.id} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}
