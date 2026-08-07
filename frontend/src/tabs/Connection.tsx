import { useEffect, useState } from 'react'

import { api, type ConfigResponse, type ConnectionStatus } from '../api'
import { Badge, Banner, Button, Card, Copy, Field, Input, Json, when } from '../ui'

const WA_FIELDS: { key: string; label: string; hint?: string; secret?: boolean }[] = [
  {
    key: 'wa_access_token',
    label: 'Access Token',
    hint: 'Token permanente do System User com whatsapp_business_messaging. Meta > Business Settings > Usuários do sistema.',
    secret: true,
  },
  {
    key: 'wa_phone_number_id',
    label: 'Phone Number ID',
    hint: 'Meta for Developers > WhatsApp > API Setup. Não é o número — é o ID numérico.',
  },
  {
    key: 'wa_business_account_id',
    label: 'WhatsApp Business Account ID (WABA)',
    hint: 'Necessário para assinar os webhooks e conferir a assinatura.',
  },
  {
    key: 'wa_verify_token',
    label: 'Verify Token',
    hint: 'Você inventa. Cole o mesmo valor no campo "Verify token" do webhook no painel da Meta.',
  },
  {
    key: 'wa_app_secret',
    label: 'App Secret',
    hint: 'Valida a assinatura X-Hub-Signature-256. Em branco, a validação é ignorada (só use assim em teste local).',
    secret: true,
  },
]

export default function Connection({ onChanged }: { onChanged: () => void }) {
  const [cfg, setCfg] = useState<ConfigResponse | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [testTo, setTestTo] = useState('')
  const [logs, setLogs] = useState<{ id: number; summary: string; created_at: string; payload: unknown }[]>([])

  const load = async () => {
    const data = await api.getConfig()
    setCfg(data)
    setDraft(
      Object.fromEntries(
        WA_FIELDS.filter((f) => !f.secret).map((f) => [f.key, String(data.config[f.key] ?? '')]),
      ),
    )
  }

  useEffect(() => {
    void load()
    void api.webhookLogs().then(setLogs)
  }, [])

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name)
    setMsg(null)
    try {
      await fn()
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const save = () =>
    run('save', async () => {
      await api.putConfig(draft)
      await load()
      setMsg({ tone: 'good', text: 'Credenciais salvas.' })
      onChanged()
    })

  const check = () =>
    run('check', async () => {
      const s = await api.connectionStatus()
      setStatus(s)
      setMsg(
        s.connected
          ? { tone: 'good', text: 'Número respondeu na Graph API.' }
          : { tone: 'bad', text: 'Não foi possível confirmar o número.' },
      )
    })

  if (!cfg) return <p className="text-sm text-ink-500">carregando…</p>

  const secretSet = (key: string) => Boolean(cfg.config[`${key}__set`])
  const secretHint = (key: string) => String(cfg.config[`${key}__hint`] ?? '')

  return (
    <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
      <Card
        title="Credenciais da WhatsApp Cloud API"
        subtitle="Campos de segredo em branco mantêm o valor já salvo."
        actions={
          <Button variant="primary" onClick={save} disabled={busy === 'save'}>
            {busy === 'save' ? 'salvando…' : 'Salvar'}
          </Button>
        }
      >
        <div className="space-y-4">
          {WA_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              hint={f.secret && secretSet(f.key) ? `Salvo (${secretHint(f.key)}). ${f.hint ?? ''}` : f.hint}
            >
              <Input
                type={f.secret ? 'password' : 'text'}
                value={draft[f.key] ?? ''}
                placeholder={f.secret && secretSet(f.key) ? '•••••••• (mantém o atual)' : ''}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
            </Field>
          ))}
          {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
        </div>
      </Card>

      <div className="space-y-5">
        <Card
          title="Webhook"
          subtitle="Cole esta URL em Meta for Developers > WhatsApp > Configuration > Webhook e assine o campo messages."
        >
          <div className="flex items-center gap-2 rounded-lg border border-ink-800 bg-ink-950 px-3 py-2">
            <code className="flex-1 truncate font-mono text-xs text-wa-500">{cfg.webhook_url}</code>
            <Copy text={cfg.webhook_url} />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-ink-500">
            A Meta só aceita HTTPS público. Em dev, exponha a porta 8000 com{' '}
            <code className="font-mono text-ink-300">ngrok http 8000</code> e ajuste{' '}
            <code className="font-mono text-ink-300">PUBLIC_BASE_URL</code> no .env.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={check} disabled={busy === 'check'}>
              {busy === 'check' ? 'testando…' : 'Testar conexão'}
            </Button>
            <Button
              onClick={() =>
                run('sub', async () => {
                  await api.subscribe()
                  setMsg({ tone: 'good', text: 'App assinado nos webhooks do WABA.' })
                  await check()
                })
              }
              disabled={busy === 'sub'}
            >
              Assinar webhooks
            </Button>
          </div>
        </Card>

        {status && (
          <Card title="Status da conexão">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={status.connected ? 'good' : 'bad'}>
                {status.connected ? 'número ativo' : 'sem conexão'}
              </Badge>
              <Badge tone={status.subscribed_apps.length ? 'good' : 'warn'}>
                {status.subscribed_apps.length} app(s) assinado(s)
              </Badge>
            </div>
            {status.phone_number && (
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                {Object.entries(status.phone_number).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-ink-500">{k}</dt>
                    <dd className="truncate font-mono text-ink-100">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {status.errors.length > 0 && (
              <ul className="mt-4 space-y-1.5">
                {status.errors.map((e) => (
                  <li key={e} className="text-xs leading-relaxed text-amber-300">
                    • {e}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <Card title="Mensagem de teste" subtitle="Só entrega dentro da janela de 24h após a pessoa te escrever.">
          <div className="flex gap-2">
            <Input
              placeholder="5511999998888"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
            />
            <Button
              onClick={() =>
                run('send', async () => {
                  await api.sendTest(testTo, 'Teste de conexão da plataforma de trackeamento.')
                  setMsg({ tone: 'good', text: 'Mensagem enviada.' })
                })
              }
              disabled={!testTo || busy === 'send'}
            >
              Enviar
            </Button>
          </div>
        </Card>

        <Card
          title="Últimos webhooks recebidos"
          subtitle="Payload cru da Meta — a prova de que o tracking está chegando."
          actions={<Button size="sm" onClick={() => void api.webhookLogs().then(setLogs)}>atualizar</Button>}
        >
          {logs.length === 0 ? (
            <p className="text-xs text-ink-500">Nada recebido ainda.</p>
          ) : (
            <ul className="space-y-2">
              {logs.slice(0, 6).map((l) => (
                <li key={l.id}>
                  <details className="rounded-lg border border-ink-800 bg-ink-850">
                    <summary className="cursor-pointer px-3 py-2 text-xs text-ink-300">
                      <span className="text-ink-500">{when(l.created_at)}</span> — {l.summary}
                    </summary>
                    <div className="px-3 pb-3">
                      <Json value={l.payload} max={240} />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
