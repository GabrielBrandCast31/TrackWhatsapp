import { useEffect, useState } from 'react'

import { api, numbersApi, type ConfigResponse, type ConnectionStatus } from '../api'
import { useNumber } from '../numberContext'
import { Badge, Banner, Button, Card, Copy, Empty, Input, Json, when } from '../ui'

/** Diagnostico da linha selecionada.
 *
 * As credenciais de cada numero vivem na aba Números — aqui e onde voce confere
 * se a linha esta de pe: webhook certo, número respondendo, mensagens chegando.
 */
export default function Connection({ onChanged }: { onChanged: () => void }) {
  const { numberId, current, numbers, labelOf } = useNumber()
  const [cfg, setCfg] = useState<ConfigResponse | null>(null)
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [testTo, setTestTo] = useState('')
  const [logs, setLogs] = useState<
    {
      id: number
      summary: string
      created_at: string
      wa_number_id: number | null
      phone_number_id: string | null
      payload: unknown
    }[]
  >([])

  const loadLogs = () => void api.webhookLogs(numberId).then(setLogs).catch(() => setLogs([]))

  useEffect(() => {
    void api.getConfig().then(setCfg)
  }, [])

  useEffect(() => {
    setStatus(null)
    setMsg(null)
    loadLogs()
  }, [numberId])

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

  const check = () =>
    run('check', async () => {
      if (numberId === undefined) throw new Error('Escolha uma linha no topo para testar a conexão.')
      const s = await numbersApi.status(numberId)
      setStatus(s)
      onChanged()
      setMsg(
        s.connected
          ? { tone: 'good', text: 'Número respondeu na Graph API.' }
          : { tone: 'bad', text: 'Não foi possível confirmar o número.' },
      )
    })

  if (!cfg) return <p className="text-sm text-ink-500">carregando…</p>

  if (numbers.length === 0) {
    return (
      <Card title="Nenhuma linha cadastrada">
        <Empty>
          Vá em <strong className="text-ink-100">Números</strong> e cadastre o primeiro número de
          WhatsApp. Sem isso, não há webhook para configurar na Meta.
        </Empty>
      </Card>
    )
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
      <div className="space-y-5">
        <Card
          title="Webhook"
          subtitle="Cole a URL em Meta for Developers > WhatsApp > Configuration > Webhook e assine o campo messages."
        >
          <p className="mb-2 text-[11px] uppercase tracking-wide text-ink-500">
            URL única — serve todas as linhas
          </p>
          <div className="flex items-center gap-2 rounded-lg border border-ink-800 bg-ink-950 px-3 py-2">
            <code className="flex-1 truncate font-mono text-xs text-wa-500">{cfg.webhook_url}</code>
            <Copy text={cfg.webhook_url} />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">
            A mensagem é roteada pelo <code className="font-mono text-ink-300">phone_number_id</code> que
            a Meta manda no payload. Use esta se todos os números estiverem no mesmo app.
          </p>

          {current && (
            <>
              <p className="mb-2 mt-5 text-[11px] uppercase tracking-wide text-ink-500">
                URL exclusiva de {current.label}
              </p>
              <div className="flex items-center gap-2 rounded-lg border border-ink-800 bg-ink-950 px-3 py-2">
                <code className="flex-1 truncate font-mono text-xs text-wa-500">{current.webhook_url}</code>
                <Copy text={current.webhook_url} />
              </div>
              <p className="mt-2 text-xs leading-relaxed text-ink-500">
                Use esta quando o número estiver num app próprio — ela valida o verify token e o app
                secret só dessa linha.
              </p>
            </>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={check} disabled={busy === 'check' || numberId === undefined}>
              {busy === 'check' ? 'testando…' : 'Testar conexão'}
            </Button>
            <Button
              onClick={() =>
                run('sub', async () => {
                  if (numberId === undefined) throw new Error('Escolha uma linha no topo.')
                  await numbersApi.subscribe(numberId)
                  setMsg({ tone: 'good', text: 'App assinado nos webhooks do WABA.' })
                  await check()
                })
              }
              disabled={busy === 'sub' || numberId === undefined}
            >
              Assinar webhooks
            </Button>
          </div>
          {numberId === undefined && (
            <p className="mt-3 text-xs text-amber-300">
              Você está vendo todas as linhas. Escolha uma no topo para testar ou assinar.
            </p>
          )}
          {msg && (
            <div className="mt-4">
              <Banner tone={msg.tone}>{msg.text}</Banner>
            </div>
          )}
        </Card>

        {status && (
          <Card title={`Status de ${current?.label ?? 'linha'}`}>
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
      </div>

      <div className="space-y-5">
        <Card
          title="Mensagem de teste"
          subtitle={`Sai por ${current?.label ?? 'nenhuma linha'}. Só entrega dentro da janela de 24h.`}
        >
          <div className="flex gap-2">
            <Input placeholder="5511999998888" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
            <Button
              onClick={() =>
                run('send', async () => {
                  if (numberId === undefined) throw new Error('Escolha uma linha no topo.')
                  await numbersApi.sendTest(
                    numberId,
                    testTo,
                    'Teste de conexão da plataforma de trackeamento.',
                  )
                  setMsg({ tone: 'good', text: 'Mensagem enviada.' })
                })
              }
              disabled={!testTo || busy === 'send' || numberId === undefined}
            >
              Enviar
            </Button>
          </div>
        </Card>

        <Card
          title="Últimos webhooks recebidos"
          subtitle={
            numberId === undefined
              ? 'Payload cru da Meta, de todas as linhas.'
              : `Payload cru da Meta que entrou por ${current?.label ?? 'esta linha'}.`
          }
          actions={
            <Button size="sm" onClick={loadLogs}>
              atualizar
            </Button>
          }
        >
          {logs.length === 0 ? (
            <p className="text-xs text-ink-500">Nada recebido ainda.</p>
          ) : (
            <ul className="space-y-2">
              {logs.slice(0, 8).map((l) => (
                <li key={l.id}>
                  <details className="rounded-lg border border-ink-800 bg-ink-850">
                    <summary className="cursor-pointer px-3 py-2 text-xs text-ink-300">
                      <span className="text-ink-500">{when(l.created_at)}</span>
                      {numberId === undefined && (
                        <span className="text-ink-500"> · {labelOf(l.wa_number_id)}</span>
                      )}{' '}
                      — {l.summary}
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
