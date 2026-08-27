import { useEffect, useState } from 'react'

import { api, evolutionApi, type EvoDefaults, type EvoInstance, type EvoQr, type EvoStatus } from '../api'
import { useNumber } from '../numberContext'
import { Badge, Banner, Button, Card, Copy, Empty, Field, Input, Json, Textarea, when } from '../ui'

type Draft = {
  label: string
  instance: string
  base_url: string
  api_key: string
  note: string
}

const EMPTY: Draft = { label: '', instance: '', base_url: '', api_key: '', note: '' }

function StateBadge({ state }: { state: string | null }) {
  if (!state) return <Badge>estado desconhecido</Badge>
  const open = ['open', 'connected'].includes(state)
  const waiting = ['connecting', 'qrcode', 'close'].includes(state)
  return <Badge tone={open ? 'good' : waiting ? 'warn' : 'bad'}>{open ? 'conectada' : state}</Badge>
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
        }
      : { ...EMPTY, base_url: defaults?.base_url ?? '' },
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

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

export default function Instances({ onChanged }: { onChanged: () => void }) {
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
