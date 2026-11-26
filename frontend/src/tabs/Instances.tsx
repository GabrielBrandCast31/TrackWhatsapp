import { useEffect, useState } from 'react'

import {
  api,
  evolutionApi,
  type EvoAvailable,
  type EvoDefaults,
  type EvoInstance,
  type EvoQr,
  type EvoStatus,
  type MetaQuality,
} from '../api'
import { useNumber } from '../numberContext'
import CloudLines from './CloudLines'
import { Badge, Banner, Button, Card, Copy, Empty, Field, Input, Json, Textarea, Toggle, when } from '../ui'

type Draft = {
  label: string
  instance: string
  base_url: string
  api_key: string
  note: string
  create_on_evolution: boolean
}

// create_on_evolution liga por padrao: digitar um nome que nao existe la era o
// erro mais comum, e ele so aparecia como 404 dois cliques depois, no QR.
const EMPTY: Draft = { label: '', instance: '', base_url: '', api_key: '', note: '', create_on_evolution: true }

function StateBadge({ state }: { state: string | null }) {
  if (!state) return <Badge>estado desconhecido</Badge>
  const open = ['open', 'connected'].includes(state)
  const waiting = ['connecting', 'qrcode', 'close'].includes(state)
  return <Badge tone={open ? 'good' : waiting ? 'warn' : 'bad'}>{open ? 'conectada' : state}</Badge>
}

// --- qualidade do número na Meta ---------------------------------------------

const QUALITY: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral'; hint: string }> = {
  GREEN: { label: 'alta', tone: 'good', hint: 'Sem sinais de problema. Pode seguir no ritmo atual.' },
  YELLOW: {
    label: 'média',
    tone: 'warn',
    hint: 'Há bloqueios/denúncias recentes. Reduza o volume e revise a mensagem antes do próximo disparo.',
  },
  RED: {
    label: 'baixa',
    tone: 'bad',
    hint: 'Muitos bloqueios/denúncias. Pare os disparos: a Meta pode rebaixar o limite ou restringir o número.',
  },
  UNKNOWN: { label: 'sem dados', tone: 'neutral', hint: 'A Meta ainda não tem volume suficiente para avaliar.' },
}

const TIER_LABEL: Record<string, string> = {
  TIER_50: '50 contatos/24h',
  TIER_250: '250 contatos/24h',
  TIER_1K: '1 mil contatos/24h',
  TIER_2K: '2 mil contatos/24h',
  TIER_10K: '10 mil contatos/24h',
  TIER_100K: '100 mil contatos/24h',
  TIER_UNLIMITED: 'ilimitado',
}

const STATUS_LABEL: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  CONNECTED: { label: 'conectado', tone: 'good' },
  FLAGGED: { label: 'sinalizado', tone: 'warn' },
  RESTRICTED: { label: 'restrito', tone: 'bad' },
  RATE_LIMITED: { label: 'limitado', tone: 'warn' },
  BANNED: { label: 'banido', tone: 'bad' },
  DISCONNECTED: { label: 'desconectado', tone: 'bad' },
  PENDING: { label: 'pendente', tone: 'warn' },
  MIGRATED: { label: 'migrado', tone: 'neutral' },
}

export function QualityBadge({ rating }: { rating?: string | null }) {
  if (!rating) return null
  const q = QUALITY[rating.toUpperCase()] ?? { label: rating.toLowerCase(), tone: 'neutral' as const }
  return <Badge tone={q.tone}>qualidade {q.label}</Badge>
}

/** Vínculo da linha Evolution com o mesmo número na Cloud API + o selo de qualidade. */
function MetaQualityPanel({ instance, onChanged }: { instance: EvoInstance; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState({
    pnid: instance.meta_phone_number_id ?? '',
    waba: instance.meta_business_account_id ?? '',
    token: '',
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null)
  const [raw, setRaw] = useState<MetaQuality | null>(null)
  const linked = !!instance.meta_linked
  const rating = (instance.quality_rating ?? '').toUpperCase()
  const q = QUALITY[rating]
  const status = STATUS_LABEL[(instance.meta_status ?? '').toUpperCase()]

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

  const check = () =>
    act('check', async () => {
      const r = await evolutionApi.quality(instance.id)
      setRaw(r)
      await onChanged()
      setMsg(r.ok ? { tone: 'good', text: 'Qualidade atualizada com a Meta.' } : { tone: 'bad', text: r.error ?? 'Falhou.' })
    })

  const save = () =>
    act('save', async () => {
      await evolutionApi.patch(instance.id, {
        meta_phone_number_id: draft.pnid.trim(),
        meta_business_account_id: draft.waba.trim(),
        ...(draft.token.trim() ? { meta_access_token: draft.token.trim() } : {}),
      })
      setDraft({ ...draft, token: '' })
      await onChanged()
      if (draft.pnid.trim()) {
        const r = await evolutionApi.quality(instance.id)
        setRaw(r)
        await onChanged()
        setMsg(
          r.ok
            ? { tone: 'good', text: 'Vínculo salvo e qualidade consultada.' }
            : { tone: 'warn', text: `Vínculo salvo, mas a Meta respondeu: ${r.error}` },
        )
      } else setMsg({ tone: 'good', text: 'Vínculo salvo.' })
    })

  const unlink = () =>
    act('unlink', async () => {
      if (!window.confirm('Remover o vínculo com a API oficial? Qualidade e disparo por template deixam de funcionar nesta linha.'))
        return
      await evolutionApi.patch(instance.id, { clear_meta_link: true })
      setDraft({ pnid: '', waba: '', token: '' })
      setRaw(null)
      await onChanged()
    })

  return (
    <details className="rounded-lg border border-ink-800 bg-ink-850" open={linked}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-xs text-ink-300">
        <span>Qualidade do número (API oficial da Meta)</span>
        {linked ? <QualityBadge rating={instance.quality_rating} /> : <Badge>sem vínculo</Badge>}
      </summary>
      <div className="space-y-3 px-3 pb-3">
        {linked && (
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-ink-800 bg-ink-950 p-3">
              <p className="text-[11px] text-ink-500">Qualidade</p>
              <p className="mt-1">
                {instance.quality_rating ? <QualityBadge rating={instance.quality_rating} /> : <span className="text-xs text-ink-500">—</span>}
              </p>
            </div>
            <div className="rounded-lg border border-ink-800 bg-ink-950 p-3">
              <p className="text-[11px] text-ink-500">Limite de envio</p>
              <p className="mt-1 font-mono text-xs text-ink-200">
                {instance.messaging_limit_tier ? TIER_LABEL[instance.messaging_limit_tier] ?? instance.messaging_limit_tier : '—'}
              </p>
            </div>
            <div className="rounded-lg border border-ink-800 bg-ink-950 p-3">
              <p className="text-[11px] text-ink-500">Status na Meta</p>
              <p className="mt-1">
                {instance.meta_status ? (
                  <Badge tone={status?.tone ?? 'neutral'}>{status?.label ?? instance.meta_status.toLowerCase()}</Badge>
                ) : (
                  <span className="text-xs text-ink-500">—</span>
                )}
              </p>
            </div>
          </div>
        )}
        {linked && q && <p className="text-[11px] leading-snug text-ink-400">{q.hint}</p>}
        {linked && instance.quality_checked_at && (
          <p className="text-[11px] text-ink-500">consultada em {when(instance.quality_checked_at)}</p>
        )}
        {instance.quality_error && <Banner tone="bad">{instance.quality_error}</Banner>}
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

        <p className="text-[11px] leading-snug text-ink-500">
          A Evolution (WhatsApp Web) não tem indicador de qualidade — esse dado só existe na Meta, para número
          registrado na Cloud API (coexistência App + API). Informe o <strong>Phone Number ID</strong> do WhatsApp
          Manager (é o ID numérico, não o telefone). Com o vínculo, a aba de disparo também pode enviar
          <strong> template aprovado pela API oficial</strong>.
        </p>

        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Phone Number ID (Meta)">
            <Input value={draft.pnid} placeholder="1234567890123456" onChange={(e) => setDraft({ ...draft, pnid: e.target.value })} />
          </Field>
          <Field label="WABA ID" hint="Necessário para listar templates.">
            <Input value={draft.waba} placeholder="opcional" onChange={(e) => setDraft({ ...draft, waba: e.target.value })} />
          </Field>
          <Field
            label="Access Token"
            hint={
              instance.meta_access_token__set
                ? `Salvo (${instance.meta_access_token__hint}). Em branco mantém.`
                : 'Obrigatório: token do System User com acesso a este WABA.'
            }
          >
            <Input
              type="password"
              value={draft.token}
              placeholder={instance.meta_access_token__set ? '•••••••• (mantém o atual)' : ''}
              onChange={(e) => setDraft({ ...draft, token: e.target.value })}
            />
          </Field>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={busy !== null} onClick={save}>
            {busy === 'save' ? 'salvando…' : 'Salvar vínculo'}
          </Button>
          {linked && (
            <Button size="sm" disabled={busy !== null} onClick={check}>
              {busy === 'check' ? 'consultando…' : 'Checar qualidade'}
            </Button>
          )}
          {linked && (
            <Button size="sm" variant="danger" disabled={busy !== null} onClick={unlink}>
              desvincular
            </Button>
          )}
        </div>

        {raw?.raw && (
          <details>
            <summary className="cursor-pointer text-[11px] text-ink-500">Resposta crua da Meta</summary>
            <Json value={raw.raw} max={200} />
          </details>
        )}
      </div>
    </details>
  )
}

/** Formulário de cadastro/edição de uma instância. */
function InstanceForm({
  instance,
  defaults,
  onDone,
  onCancel,
}: {
  instance?: EvoInstance
  defaults: EvoDefaults | null
  onDone: () => Promise<void>
  onCancel?: () => void
}) {
  const [draft, setDraft] = useState<Draft>(
    instance
      ? {
          label: instance.label,
          instance: instance.instance ?? '',
          base_url: instance.base_url ?? '',
          api_key: '',
          note: instance.note ?? '',
          create_on_evolution: false,
        }
      : { ...EMPTY, base_url: defaults?.base_url ?? '' },
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [found, setFound] = useState<EvoAvailable[] | null>(null)
  const [looking, setLooking] = useState(false)

  /** Pergunta a Evolution o que existe la. Usa a URL/apikey digitadas, que podem
   *  ainda nao estar salvas em linha nenhuma — por isso vao por query. */
  const lookup = async () => {
    setLooking(true)
    setErr(null)
    try {
      setFound(await evolutionApi.available(draft.base_url.trim(), draft.api_key.trim()))
    } catch (e) {
      setErr((e as Error).message)
      setFound(null)
    } finally {
      setLooking(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      const payload = {
        label: draft.label.trim(),
        instance: draft.instance.trim(),
        base_url: draft.base_url.trim(),
        api_key: draft.api_key.trim(),
        note: draft.note.trim() || null,
        ...(instance ? {} : { create_on_evolution: draft.create_on_evolution }),
      }
      if (instance) await evolutionApi.patch(instance.id, payload)
      else await evolutionApi.create(payload)
      await onDone()
      if (!instance) setDraft({ ...EMPTY, base_url: defaults?.base_url ?? '' })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Nome da linha" hint="Como você reconhece esse cliente no seletor do topo.">
          <Input
            value={draft.label}
            placeholder="Clínica Irailton"
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </Field>
        <Field label="Instância" hint="O nome exato da instância na sua Evolution API.">
          <Input
            value={draft.instance}
            placeholder="clinica-irailton"
            onChange={(e) => setDraft({ ...draft, instance: e.target.value })}
          />
        </Field>
        <Field label="URL da Evolution API" hint="Ex.: https://evo.seudominio.com — sem barra no fim.">
          <Input
            value={draft.base_url}
            placeholder="https://evo.seudominio.com"
            onChange={(e) => setDraft({ ...draft, base_url: e.target.value })}
          />
        </Field>
        <Field
          label="apikey"
          hint={
            instance?.api_key__set
              ? `Salva (${instance.api_key__hint}). Deixe em branco para manter.`
              : 'O header apikey da sua Evolution (global ou da instância).'
          }
        >
          <Input
            type="password"
            value={draft.api_key}
            placeholder={instance?.api_key__set ? '•••••••• (mantém a atual)' : ''}
            onChange={(e) => setDraft({ ...draft, api_key: e.target.value })}
          />
        </Field>
      </div>

      {!instance && (
        <div className="space-y-2 rounded-lg border border-ink-800 bg-ink-850 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={looking || !draft.base_url.trim()} onClick={lookup}>
              {looking ? 'consultando…' : 'Ver instâncias na Evolution'}
            </Button>
            <span className="text-xs text-ink-400">
              O nome tem que ser exatamente igual ao da Evolution.
            </span>
          </div>

          {found && found.length === 0 && (
            <p className="text-xs text-ink-400">
              Nenhuma instância nessa Evolution. Digite um nome e deixe a criação ligada.
            </p>
          )}

          {found && found.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {found.map((row) => (
                <button
                  key={row.name}
                  type="button"
                  title={row.registered ? 'já tem uma linha cadastrada' : 'clique para usar este nome'}
                  onClick={() => setDraft({ ...draft, instance: row.name, create_on_evolution: false })}
                  className="flex items-center gap-2 rounded border border-ink-700 px-2 py-1 text-xs hover:border-ink-500"
                >
                  <span className={row.registered ? 'text-ink-500' : 'text-ink-200'}>{row.name}</span>
                  <StateBadge state={row.state} />
                  {row.registered && <span className="text-ink-500">(já cadastrada)</span>}
                </button>
              ))}
            </div>
          )}

          <Toggle
            checked={draft.create_on_evolution}
            onChange={(v) => setDraft({ ...draft, create_on_evolution: v })}
            label="Criar a instância na Evolution se ela não existir"
          />
        </div>
      )}

      <Field label="Observação (opcional)">
        <Textarea rows={2} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
      </Field>

      {err && <Banner tone="bad">{err}</Banner>}

      <div className="flex gap-2">
        <Button variant="primary" disabled={busy || !draft.label.trim() || !draft.instance.trim()} onClick={save}>
          {busy ? 'salvando…' : instance ? 'Salvar alterações' : 'Adicionar linha'}
        </Button>
        {onCancel && <Button onClick={onCancel}>cancelar</Button>}
      </div>
    </div>
  )
}

/** Uma linha na lista, com pareamento, webhook e teste de envio. */
function InstanceCard({
  instance,
  onChanged,
}: {
  instance: EvoInstance
  onChanged: () => Promise<void>
}) {
  const [status, setStatus] = useState<EvoStatus | null>(null)
  const [qr, setQr] = useState<EvoQr | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null)
  const [test, setTest] = useState({ to: '', body: 'Teste de conexão do rastreamento.' })

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

  return (
    <Card
      title={instance.label}
      subtitle={`instância ${instance.instance ?? '—'}${
        instance.base_url ? ` · ${instance.base_url}` : ''
      }`}
      actions={
        <>
          <StateBadge state={instance.state} />
          {instance.meta_linked && <QualityBadge rating={instance.quality_rating} />}
          {instance.is_default && <Badge tone="info">padrão</Badge>}
          {!instance.active && <Badge tone="warn">inativa</Badge>}
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-4 text-xs text-ink-500">
          {instance.display_phone_number && (
            <span className="font-mono text-ink-300">{instance.display_phone_number}</span>
          )}
          <span>{instance.counts.contacts ?? 0} lead(s)</span>
          <span>{instance.counts.conversions ?? 0} conversão(ões)</span>
          <span>{instance.counts.rules ?? 0} regra(s)</span>
          {instance.last_checked_at && <span>verificada em {when(instance.last_checked_at)}</span>}
        </div>

        {instance.last_error && <Banner tone="bad">{instance.last_error}</Banner>}
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-300">URL do webhook desta linha</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 font-mono text-[11px] text-ink-300">
              {instance.webhook_url}
            </code>
            <Copy text={instance.webhook_url} />
          </div>
          <p className="mt-1 text-[11px] leading-snug text-ink-500">
            O token no fim da URL é o que autentica o POST — trate como senha. “Configurar webhook” grava
            essa URL na instância para você.
          </p>
          {instance.webhook_public_url && instance.webhook_public_url !== instance.webhook_url && (
            <p className="mt-1.5 text-[11px] leading-snug text-ink-500">
              A entrega vai pelo endereço interno acima — não depende de túnel nem de DNS público. Pela
              internet, a mesma rota é{' '}
              <code className="font-mono text-ink-300">{instance.webhook_public_url}</code>; use essa se a
              Evolution rodar fora desta máquina.
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              act('status', async () => {
                const s = await evolutionApi.status(instance.id)
                setStatus(s)
                await onChanged()
                if (s.errors.length) setMsg({ tone: 'bad', text: s.errors.join(' — ') })
                else if (!s.webhook_matches)
                  setMsg({
                    tone: 'warn',
                    text: s.webhook_configured
                      ? `A instância está apontando para outra URL (${s.webhook_configured}). Clique em “Configurar webhook”.`
                      : 'A instância ainda não tem webhook configurado. Clique em “Configurar webhook”.',
                  })
                else setMsg({ tone: 'good', text: 'Conectada e com o webhook apontado para cá.' })
              })
            }
          >
            {busy === 'status' ? 'verificando…' : 'Verificar status'}
          </Button>

          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              act('provision', async () => {
                const r = await evolutionApi.provision(instance.id)
                setMsg(
                  r.created
                    ? { tone: 'good', text: `Instância “${r.instance}” criada na Evolution. Agora clique em “Conectar (QR)”.` }
                    : { tone: 'good', text: `A instância “${r.instance}” já existia na Evolution.` },
                )
              })
            }
          >
            {busy === 'provision' ? 'criando…' : 'Criar na Evolution'}
          </Button>

          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              act('webhook', async () => {
                const r = await evolutionApi.setWebhook(instance.id)
                setMsg({ tone: 'good', text: `Webhook gravado na instância (${r.events.length} eventos).` })
                await onChanged()
              })
            }
          >
            {busy === 'webhook' ? 'configurando…' : 'Configurar webhook'}
          </Button>

          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              act('qr', async () => {
                setQr(await evolutionApi.connect(instance.id))
              })
            }
          >
            {busy === 'qr' ? 'gerando…' : 'Conectar (QR)'}
          </Button>

          <Button size="sm" onClick={() => setEditing(!editing)}>
            {editing ? 'fechar edição' : 'Editar'}
          </Button>

          {!instance.is_default && (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                act('default', async () => {
                  await evolutionApi.patch(instance.id, { is_default: true })
                  await onChanged()
                })
              }
            >
              tornar padrão
            </Button>
          )}

          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              act('active', async () => {
                await evolutionApi.patch(instance.id, { active: !instance.active })
                await onChanged()
              })
            }
          >
            {instance.active ? 'desativar' : 'ativar'}
          </Button>

          <Button
            size="sm"
            variant="danger"
            disabled={busy !== null}
            onClick={() =>
              act('remove', async () => {
                const purge = window.confirm(
                  `Remover “${instance.label}”.\n\nOK = apaga também os leads e conversões dessa linha.\n` +
                    'Cancelar = mantém a base (os leads ficam sem linha e continuam em “Todas as linhas”).',
                )
                await evolutionApi.remove(instance.id, purge)
                await onChanged()
              })
            }
          >
            remover
          </Button>
        </div>

        {qr && (
          <div className="space-y-2 rounded-lg border border-ink-800 bg-ink-850 p-4">
            <p className="text-xs text-ink-300">
              Abra o WhatsApp no celular → Dispositivos conectados → Conectar dispositivo.
            </p>
            {qr.base64 ? (
              <img
                src={qr.base64.startsWith('data:') ? qr.base64 : `data:image/png;base64,${qr.base64}`}
                alt="QR code de pareamento"
                className="h-56 w-56 rounded-lg bg-white p-2"
              />
            ) : (
              <Banner tone="warn">
                A Evolution não devolveu imagem do QR. {qr.pairing_code ? `Código de pareamento: ${qr.pairing_code}` : ''}
              </Banner>
            )}
            <Button size="sm" onClick={() => setQr(null)}>
              fechar
            </Button>
          </div>
        )}

        {editing && (
          <div className="rounded-lg border border-ink-800 bg-ink-850 p-4">
            <InstanceForm
              instance={instance}
              defaults={null}
              onDone={async () => {
                setEditing(false)
                await onChanged()
              }}
              onCancel={() => setEditing(false)}
            />
          </div>
        )}

        <MetaQualityPanel instance={instance} onChanged={onChanged} />

        <details className="rounded-lg border border-ink-800 bg-ink-850">
          <summary className="cursor-pointer px-3 py-2 text-xs text-ink-300">Enviar mensagem de teste</summary>
          <div className="space-y-3 px-3 pb-3">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Número (com DDI)">
                <Input
                  value={test.to}
                  placeholder="5511988887777"
                  onChange={(e) => setTest({ ...test, to: e.target.value })}
                />
              </Field>
              <Field label="Mensagem">
                <Input value={test.body} onChange={(e) => setTest({ ...test, body: e.target.value })} />
              </Field>
            </div>
            <Button
              size="sm"
              disabled={busy !== null || !test.to.trim()}
              onClick={() =>
                act('send', async () => {
                  await evolutionApi.sendTest(instance.id, test.to, test.body)
                  setMsg({ tone: 'good', text: 'Mensagem enviada pela Evolution.' })
                })
              }
            >
              {busy === 'send' ? 'enviando…' : 'enviar'}
            </Button>
          </div>
        </details>

        {status && (
          <details className="rounded-lg border border-ink-800 bg-ink-850">
            <summary className="cursor-pointer px-3 py-2 text-xs text-ink-300">Resposta crua do status</summary>
            <div className="px-3 pb-3">
              <Json value={status} max={240} />
            </div>
          </details>
        )}
      </div>
    </Card>
  )
}

type WebhookLog = {
  id: number
  summary: string
  created_at: string
  wa_number_id: number | null
  phone_number_id: string | null
  payload: unknown
}

/** O que a Evolution mandou de verdade — primeiro lugar pra olhar quando "não chega nada". */
function WebhookLogs() {
  const { numberId, current, labelOf } = useNumber()
  const [logs, setLogs] = useState<WebhookLog[]>([])

  const load = () => void api.webhookLogs(numberId).then(setLogs).catch(() => setLogs([]))
  useEffect(load, [numberId])

  return (
    <Card
      title="Últimos webhooks recebidos"
      subtitle={
        numberId === undefined
          ? 'Payload cru de todas as linhas.'
          : `Payload cru que entrou por ${current?.label ?? 'esta linha'}.`
      }
      actions={
        <Button size="sm" onClick={load}>
          atualizar
        </Button>
      }
    >
      {logs.length === 0 ? (
        <p className="text-xs leading-relaxed text-ink-500">
          Nada recebido ainda. Se a instância está conectada e mesmo assim nada aparece aqui, o webhook não está
          apontando pra cá — clique em “Configurar webhook” na linha.
        </p>
      ) : (
        <ul className="space-y-2">
          {logs.slice(0, 10).map((l) => (
            <li key={l.id}>
              <details className="rounded-lg border border-ink-800 bg-ink-850">
                <summary className="cursor-pointer px-3 py-2 text-xs text-ink-300">
                  <span className="text-ink-500">{when(l.created_at)}</span>
                  {numberId === undefined && <span className="text-ink-500"> · {labelOf(l.wa_number_id)}</span>} —{' '}
                  {l.summary}
                </summary>
                <div className="px-3 pb-3">
                  <Json value={l.payload} max={280} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function EvolutionLines({ onChanged }: { onChanged: () => void }) {
  const { numbers, reload, loading } = useNumber()
  const [defaults, setDefaults] = useState<EvoDefaults | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    void evolutionApi.defaults().then(setDefaults).catch(() => setDefaults(null))
  }, [])

  const refresh = async () => {
    await reload()
    onChanged()
  }

  return (
    <div className="space-y-5">
      <Card
        title="Conexão com a Evolution API"
        subtitle="Cada linha é uma instância. É por ela que a mensagem chega com o ctwaClid do anúncio."
        actions={
          <Button size="sm" variant="primary" onClick={() => setAdding(!adding)}>
            {adding ? 'fechar' : 'Adicionar linha'}
          </Button>
        }
      >
        <div className="space-y-4">
          <ol className="space-y-1.5 text-xs leading-relaxed text-ink-500">
            <li>
              <strong className="text-ink-300">1.</strong> Cadastre a linha com a URL da Evolution, a apikey e o
              nome da instância.
            </li>
            <li>
              <strong className="text-ink-300">2.</strong> Clique em <em>Conectar (QR)</em> e pareie o WhatsApp
              (se a instância ainda não estiver conectada).
            </li>
            <li>
              <strong className="text-ink-300">3.</strong> Clique em <em>Configurar webhook</em> — sem isso
              nenhuma mensagem chega aqui e nada é rastreado.
            </li>
            <li>
              <strong className="text-ink-300">4.</strong> Em <em>Rastreamento</em>, informe o Pixel e o token da
              API e crie as palavras-chave.
            </li>
          </ol>

          {defaults && (
            <p className="text-[11px] leading-snug text-ink-500">
              Webhook público desta instalação: <code className="font-mono text-ink-300">{defaults.webhook_base}</code>{' '}
              — precisa ser HTTPS acessível pela sua Evolution. Eventos assinados:{' '}
              <span className="font-mono">{defaults.webhook_events.join(', ')}</span>.
            </p>
          )}

          {adding && (
            <div className="rounded-lg border border-ink-800 bg-ink-850 p-4">
              <InstanceForm
                defaults={defaults}
                onDone={async () => {
                  setAdding(false)
                  await refresh()
                }}
                onCancel={() => setAdding(false)}
              />
            </div>
          )}
        </div>
      </Card>

      {loading ? (
        <p className="text-sm text-ink-500">carregando linhas…</p>
      ) : numbers.length === 0 ? (
        <Empty>Nenhuma linha cadastrada ainda. Use “Adicionar linha” acima.</Empty>
      ) : (
        <div className="space-y-5">
          {numbers.map((n) => (
            <InstanceCard key={n.id} instance={n} onChanged={refresh} />
          ))}
        </div>
      )}

      {numbers.length > 0 && <WebhookLogs />}
    </div>
  )
}

const MODES = [
  { id: 'evolution', label: 'Evolution API', hint: 'pareia o celular pelo QR code' },
  { id: 'cloud', label: 'Cloud API oficial', hint: 'número sem celular, direto na Meta' },
] as const

type Mode = (typeof MODES)[number]['id']
const MODE_KEY = 'wa.connection.mode'

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'cloud' ? 'cloud' : 'evolution'
  } catch {
    return 'evolution'
  }
}

/** Duas formas de conectar uma linha: Evolution (celular + QR) ou Cloud API
 *  (número que só existe na API da Meta e não tem QR para ler). */
export default function Instances({ onChanged }: { onChanged: () => void }) {
  const [mode, setModeState] = useState<Mode>(readMode)
  const setMode = (m: Mode) => {
    setModeState(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      // sem storage: a escolha vale so pra sessao
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-2 sm:grid-cols-2">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={`rounded-xl border px-4 py-3 text-left transition-colors ${
              mode === m.id
                ? 'border-wa-500/60 bg-wa-900/30'
                : 'border-ink-800 bg-ink-900 hover:border-ink-600'
            }`}
          >
            <span className={`block text-sm font-semibold ${mode === m.id ? 'text-ink-100' : 'text-ink-300'}`}>
              {m.label}
            </span>
            <span className="mt-0.5 block text-[11px] text-ink-500">{m.hint}</span>
          </button>
        ))}
      </div>
      {mode === 'evolution' ? <EvolutionLines onChanged={onChanged} /> : <CloudLines onChanged={onChanged} />}
    </div>
  )
}
