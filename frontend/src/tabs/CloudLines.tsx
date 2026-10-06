import { useEffect, useState } from 'react'

import { cloudLinesApi, type WaNumber } from '../api'
import { useNumber } from '../numberContext'
import { Badge, Banner, Button, Card, Copy, Empty, Field, Input, when } from '../ui'

type Draft = {
  label: string
  phone_number_id: string
  business_account_id: string
  access_token: string
  app_secret: string
  note: string
}

const EMPTY: Draft = { label: '', phone_number_id: '', business_account_id: '', access_token: '', app_secret: '', note: '' }

/** Cadastro/edição de uma linha Cloud. Segredo em branco na edição mantém o atual. */
function LineForm({
  line,
  onDone,
  onCancel,
}: {
  line?: WaNumber
  onDone: () => Promise<void>
  onCancel?: () => void
}) {
  const [draft, setDraft] = useState<Draft>(
    line
      ? {
          label: line.label,
          phone_number_id: line.phone_number_id,
          business_account_id: line.business_account_id ?? '',
          access_token: '',
          app_secret: '',
          note: line.note ?? '',
        }
      : EMPTY,
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: e.target.value })

  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      const payload = { ...draft, phone_number_id: draft.phone_number_id.trim() }
      if (line) await cloudLinesApi.patch(line.id, payload)
      else await cloudLinesApi.create(payload)
      await onDone()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome da linha" hint="Como ela aparece no painel — ex.: Clínica X">
          <Input value={draft.label} onChange={set('label')} placeholder="Clínica X" />
        </Field>
        <Field label="Phone Number ID" hint="Meta for Developers → WhatsApp → Configuração da API">
          <Input value={draft.phone_number_id} onChange={set('phone_number_id')} placeholder="1234567890" />
        </Field>
        <Field label="WhatsApp Business Account ID (WABA)" hint="Necessário para assinar os webhooks">
          <Input value={draft.business_account_id} onChange={set('business_account_id')} placeholder="1234567890" />
        </Field>
        <Field
          label="Access Token permanente"
          hint={
            line?.access_token__set
              ? `Salvo (${line.access_token__hint}). Em branco mantém o atual.`
              : 'Token de Usuário do Sistema no Business Manager, com whatsapp_business_messaging e whatsapp_business_management'
          }
        >
          <Input type="password" value={draft.access_token} onChange={set('access_token')} placeholder="EAAG…" />
        </Field>
        <Field
          label="App Secret (opcional)"
          hint={
            line?.app_secret__set
              ? `Salvo (${line.app_secret__hint}). Em branco mantém o atual.`
              : 'Valida a assinatura do webhook — recomendado'
          }
        >
          <Input type="password" value={draft.app_secret} onChange={set('app_secret')} />
        </Field>
        <Field label="Observação">
          <Input value={draft.note} onChange={set('note')} />
        </Field>
      </div>
      {err && <Banner tone="bad">{err}</Banner>}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={save}>
          {busy ? 'salvando…' : line ? 'Salvar' : 'Cadastrar linha'}
        </Button>
        {onCancel && (
          <Button size="sm" onClick={onCancel}>
            cancelar
          </Button>
        )}
      </div>
    </div>
  )
}

function LineCard({ line, onChanged }: { line: WaNumber; onChanged: () => Promise<void> }) {
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
      title={line.label}
      subtitle={`Cloud API · Phone Number ID ${line.phone_number_id}`}
      actions={
        <>
          <Badge tone={line.last_error ? 'bad' : line.display_phone_number ? 'good' : 'warn'}>
            {line.last_error ? 'com erro' : line.display_phone_number ? 'conectada' : 'não verificada'}
          </Badge>
          {line.is_default && <Badge tone="info">padrão</Badge>}
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-4 text-xs text-ink-500">
          {line.display_phone_number && <span className="font-mono text-ink-300">{line.display_phone_number}</span>}
          {line.verified_name && <span>{line.verified_name}</span>}
          {line.quality_rating && <span>qualidade {line.quality_rating}</span>}
          <span>{line.counts?.contacts ?? 0} lead(s)</span>
          {line.last_checked_at && <span>verificada em {when(line.last_checked_at)}</span>}
        </div>

        {line.last_error && <Banner tone="bad">{line.last_error}</Banner>}
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-300">URL de callback</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 font-mono text-[11px] text-ink-300">
                {line.webhook_url}
              </code>
              <Copy text={line.webhook_url} />
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-300">Token de verificação</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 font-mono text-[11px] text-ink-300">
                {line.verify_token ?? '—'}
              </code>
              {line.verify_token && <Copy text={line.verify_token} />}
            </div>
          </div>
        </div>
        <p className="text-[11px] leading-snug text-ink-500">
          No app da Meta (WhatsApp → Configuração → Webhook), cole a URL e o token acima e assine o campo{' '}
          <span className="font-mono">messages</span>. Depois clique em “Assinar webhooks” aqui.
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              act('status', async () => {
                const s = await cloudLinesApi.status(line.id)
                await onChanged()
                if (s.errors.length) setMsg({ tone: s.connected ? 'warn' : 'bad', text: s.errors.join(' — ') })
                else setMsg({ tone: 'good', text: 'Número conectado e webhooks assinados.' })
              })
            }
          >
            {busy === 'status' ? 'verificando…' : 'Verificar conexão'}
          </Button>
          <Button
            size="sm"
            disabled={busy !== null || !line.business_account_id}
            onClick={() =>
              act('subscribe', async () => {
                await cloudLinesApi.subscribe(line.id)
                setMsg({ tone: 'good', text: 'App assinado nos webhooks do WABA.' })
              })
            }
          >
            {busy === 'subscribe' ? 'assinando…' : 'Assinar webhooks'}
          </Button>
          <Button size="sm" onClick={() => setEditing(!editing)}>
            {editing ? 'fechar edição' : 'Editar'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy !== null}
            onClick={() => {
              if (!confirm(`Remover a linha “${line.label}”? Os leads dela continuam na base, sem linha.`)) return
              void act('remove', async () => {
                await cloudLinesApi.remove(line.id)
                await onChanged()
              })
            }}
          >
            Remover
          </Button>
        </div>

        {editing && (
          <div className="rounded-lg border border-ink-800 bg-ink-850 p-4">
            <LineForm
              line={line}
              onDone={async () => {
                setEditing(false)
                await onChanged()
              }}
              onCancel={() => setEditing(false)}
            />
          </div>
        )}

        <div className="rounded-lg border border-ink-800 bg-ink-850 p-3">
          <p className="mb-2 text-xs font-medium text-ink-300">Mensagem de teste</p>
          <div className="flex flex-wrap gap-2">
            <div className="w-44">
              <Input value={test.to} onChange={(e) => setTest({ ...test, to: e.target.value })} placeholder="5511999999999" />
            </div>
            <div className="min-w-48 flex-1">
              <Input value={test.body} onChange={(e) => setTest({ ...test, body: e.target.value })} />
            </div>
            <Button
              size="sm"
              disabled={busy !== null || !test.to.trim()}
              onClick={() =>
                act('test', async () => {
                  await cloudLinesApi.sendTest(line.id, test.to.trim(), test.body)
                  setMsg({ tone: 'good', text: 'Mensagem aceita pela Meta.' })
                })
              }
            >
              {busy === 'test' ? 'enviando…' : 'Enviar'}
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-ink-500">
            Texto livre só é entregue se a pessoa falou com o número nas últimas 24h. Fora disso, a Meta só aceita
            template aprovado.
          </p>
        </div>
      </div>
    </Card>
  )
}

/** Número que vive direto na Cloud API (sem celular, sem QR): conecta por credenciais. */
export default function CloudLines({ onChanged }: { onChanged: () => void }) {
  const { reload } = useNumber()
  const [lines, setLines] = useState<WaNumber[] | null>(null)
  const [adding, setAdding] = useState(false)

  const refresh = async () => {
    setLines(await cloudLinesApi.list().catch(() => []))
    await reload()
    onChanged()
  }

  useEffect(() => {
    void cloudLinesApi.list().then(setLines).catch(() => setLines([]))
  }, [])

  return (
    <div className="space-y-5">
      <Card
        title="Conexão pela Cloud API oficial"
        subtitle="Para o número que está direto na API da Meta, sem celular vinculado — não usa QR code."
        actions={
          <Button size="sm" variant="primary" onClick={() => setAdding(!adding)}>
            {adding ? 'fechar' : 'Adicionar linha'}
          </Button>
        }
      >
        <div className="space-y-4">
          <ol className="space-y-1.5 text-xs leading-relaxed text-ink-500">
            <li>
              <strong className="text-ink-300">1.</strong> Peça ao cliente o Phone Number ID, o WABA ID e um token
              permanente (Usuário do Sistema no Business Manager).
            </li>
            <li>
              <strong className="text-ink-300">2.</strong> Cadastre a linha aqui — a URL de callback e o token de
              verificação aparecem no card.
            </li>
            <li>
              <strong className="text-ink-300">3.</strong> Cole os dois no webhook do app da Meta, assine o campo{' '}
              <span className="font-mono">messages</span> e clique em <em>Assinar webhooks</em>.
            </li>
            <li>
              <strong className="text-ink-300">4.</strong> <em>Verificar conexão</em> confirma o número e a
              assinatura.
            </li>
          </ol>
          {adding && (
            <div className="rounded-lg border border-ink-800 bg-ink-850 p-4">
              <LineForm
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

      {lines === null ? (
        <p className="text-sm text-ink-500">carregando linhas…</p>
      ) : lines.length === 0 ? (
        <Empty>Nenhuma linha da Cloud API ainda. Use “Adicionar linha” acima.</Empty>
      ) : (
        lines.map((l) => <LineCard key={l.id} line={l} onChanged={refresh} />)
      )}
    </div>
  )
}
