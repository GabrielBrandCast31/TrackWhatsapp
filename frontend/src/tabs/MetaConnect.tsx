import { useCallback, useEffect, useState } from 'react'

import {
  metaApi,
  type EvoInstance,
  type MetaAdAccount,
  type MetaConnection,
  type MetaLead,
  type MetaPage,
  type MetaPixel,
  type MetaStatus,
} from '../api'
import { IconFacebook } from '../icons'
import { takeReturn } from '../oauthReturn'
import { Badge, Banner, Button, Card, Copy, Field, Select, when } from '../ui'

type Msg = { tone: 'good' | 'bad' | 'warn'; text: string }

/** Volta do Facebook (conectou ou deu erro). Lido no módulo: o StrictMode chama
 *  inicializador de estado duas vezes e o aviso sumiria na segunda. */
let connectReturn: Msg | null = (() => {
  if (takeReturn('meta') === 'connected') {
    return { tone: 'good', text: 'Facebook conectado. Agora escolha a conta de anúncios, o Pixel e a Página.' }
  }
  const error = takeReturn('meta_error')
  return error ? { tone: 'bad', text: error } : null
})()

const SCOPE_LABEL: Record<string, string> = {
  ads_read: 'ler anúncios',
  ads_management: 'enviar eventos ao Pixel',
  business_management: 'Business Manager',
  pages_show_list: 'listar Páginas',
  pages_read_engagement: 'ler Páginas',
  pages_manage_metadata: 'webhook da Página',
  pages_manage_ads: 'anúncios da Página',
  leads_retrieval: 'baixar leads',
}

function daysLeft(iso: string | null): number | null {
  if (!iso) return null
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000)
}

/** Passo a passo de quem ainda não criou o app na Meta. */
function SetupGuide({ status }: { status: MetaStatus }) {
  return (
    <div className="space-y-3 text-xs leading-relaxed text-ink-400">
      <Banner tone="warn">
        O app da Meta ainda não foi configurado no servidor. Sem ele o botão de conectar não funciona.
      </Banner>
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          Em <strong className="text-ink-200">developers.facebook.com → Meus apps → Criar app</strong>, escolha o
          tipo <em>Empresa</em> e vincule ao seu Business Manager.
        </li>
        <li>
          Adicione o produto <strong className="text-ink-200">Login do Facebook para Empresas</strong> e cadastre a
          URI de redirecionamento abaixo em “URIs de redirecionamento do OAuth válidos”.
        </li>
        <li>
          Em <strong className="text-ink-200">Configurações → Básico</strong>, copie o ID e a Chave secreta do app
          para o <code className="font-mono">.env</code> do backend:{' '}
          <code className="font-mono">META_APP_ID</code> e <code className="font-mono">META_APP_SECRET</code>.
        </li>
        <li>
          Para os leads chegarem sozinhos: produto <strong className="text-ink-200">Webhooks</strong> → objeto{' '}
          <em>Page</em> → campo <em>leadgen</em>, com a URL abaixo e o mesmo texto de{' '}
          <code className="font-mono">META_WEBHOOK_VERIFY_TOKEN</code>.
        </li>
        <li>Reinicie o backend.</li>
      </ol>
      <UrlRow label="URI de redirecionamento" value={status.redirect_uri} />
      <UrlRow label="URL do webhook (Lead Ads)" value={status.webhook_url} />
    </div>
  )
}

function UrlRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-48 shrink-0 text-ink-500">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded-md border border-ink-800 bg-ink-950 px-2 py-1 font-mono text-[11px] text-ink-200">
        {value}
      </code>
      <Copy text={value} />
    </div>
  )
}

/** Conta de anúncios → Pixel → Página, com o que a conta conectada enxerga. */
function AssetPicker({
  numberId,
  conn,
  onSaved,
}: {
  numberId: number
  conn: MetaConnection
  onSaved: (conn: MetaConnection, applied: string[]) => Promise<void>
}) {
  const [accounts, setAccounts] = useState<MetaAdAccount[] | null>(null)
  const [pages, setPages] = useState<MetaPage[]>([])
  const [pixels, setPixels] = useState<MetaPixel[]>([])
  const [draft, setDraft] = useState({
    ad_account_id: conn.ad_account_id ?? '',
    pixel_id: conn.pixel_id ?? '',
    page_id: conn.page_id ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setErr(null)
    void metaApi
      .assets(numberId)
      .then((r) => {
        setAccounts(r.ad_accounts)
        setPages(r.pages)
      })
      .catch((e) => setErr((e as Error).message))
  }, [numberId, conn.fb_user_id])

  useEffect(() => {
    if (!draft.ad_account_id) {
      setPixels([])
      return
    }
    void metaApi
      .pixels(numberId, draft.ad_account_id)
      .then((r) => setPixels(r.pixels))
      .catch((e) => setErr((e as Error).message))
  }, [numberId, draft.ad_account_id])

  if (accounts === null) {
    return err ? <Banner tone="bad">{err}</Banner> : <p className="text-xs text-ink-500">buscando suas contas…</p>
  }

  const changed =
    draft.ad_account_id !== (conn.ad_account_id ?? '') ||
    draft.pixel_id !== (conn.pixel_id ?? '') ||
    draft.page_id !== (conn.page_id ?? '')

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Conta de anúncios" hint="Dá nome de campanha e objetivo aos leads de anúncio.">
          <Select
            value={draft.ad_account_id}
            onChange={(e) => setDraft({ ...draft, ad_account_id: e.target.value, pixel_id: '' })}
          >
            <option value="">— escolha —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.business ? ` · ${a.business}` : ''}
                {a.active ? '' : ' (inativa)'}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Pixel / Dataset" hint="Para onde vão as conversões desta linha.">
          <Select
            value={draft.pixel_id}
            disabled={!draft.ad_account_id}
            onChange={(e) => setDraft({ ...draft, pixel_id: e.target.value })}
          >
            <option value="">{draft.ad_account_id ? '— escolha —' : 'escolha a conta antes'}</option>
            {pixels.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Página (Lead Ads)" hint="Os leads dos formulários desta Página entram no CRM.">
          <Select value={draft.page_id} onChange={(e) => setDraft({ ...draft, page_id: e.target.value })}>
            <option value="">— nenhuma —</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {accounts.length === 0 && (
        <Banner tone="warn">
          Esta conta do Facebook não enxerga nenhuma conta de anúncios. Confira se a permissão foi dada a ela no
          Business Manager ou reconecte marcando as contas certas.
        </Banner>
      )}
      {err && <Banner tone="bad">{err}</Banner>}

      <Button
        variant="primary"
        disabled={busy || !changed}
        onClick={async () => {
          setBusy(true)
          setErr(null)
          try {
            const r = await metaApi.select(numberId, {
              ad_account_id: draft.ad_account_id || undefined,
              pixel_id: draft.pixel_id || undefined,
              page_id: draft.page_id || undefined,
            })
            await onSaved(r.connection, r.applied)
          } catch (e) {
            setErr((e as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'salvando…' : 'Usar nesta linha'}
      </Button>
    </div>
  )
}

function LeadAds({ numberId, conn, onChanged }: { numberId: number; conn: MetaConnection; onChanged: () => Promise<void> }) {
  const [leads, setLeads] = useState<MetaLead[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)

  const load = useCallback(async () => setLeads(await metaApi.leads(numberId)), [numberId])
  useEffect(() => {
    void load().catch(() => setLeads([]))
  }, [load, conn.leads])

  if (!conn.page_id) return null

  return (
    <div className="space-y-3 border-t border-ink-800 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-ink-100">Lead Ads · {conn.page_name}</h3>
        {conn.leads_subscribed ? (
          <Badge tone="good">recebendo em tempo real</Badge>
        ) : (
          <Badge tone="warn">webhook não inscrito</Badge>
        )}
        <Badge>{conn.leads} lead(s)</Badge>
        <div className="ml-auto">
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setMsg(null)
              try {
                const r = await metaApi.syncLeads(numberId)
                setMsg({
                  tone: 'good',
                  text: `${r.forms} formulário(s), ${r.seen} lead(s) lidos, ${r.new} novo(s) no CRM.`,
                })
                await onChanged()
              } catch (e) {
                setMsg({ tone: 'bad', text: (e as Error).message })
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'importando…' : 'Importar leads'}
          </Button>
        </div>
      </div>
      {conn.last_error && <Banner tone="warn">{conn.last_error}</Banner>}
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      {leads.length > 0 && (
        <ul className="divide-y divide-ink-800 rounded-lg border border-ink-800">
          {leads.slice(0, 8).map((l) => {
            const name = l.answers.full_name || l.answers.first_name || l.answers.email || l.leadgen_id
            return (
              <li key={l.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-ink-200">{name}</span>
                <span className="hidden truncate text-ink-500 md:block">
                  {l.campaign_name || l.form_name || '—'}
                </span>
                {l.platform && <Badge>{l.platform}</Badge>}
                {l.contact_id ? <Badge tone="good">no CRM</Badge> : <Badge tone="warn">sem telefone</Badge>}
                <span className="shrink-0 tabular-nums text-ink-500">{when(l.created_at)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** Conectar o Facebook da linha por OAuth — no lugar de colar Pixel e tokens. */
export default function MetaConnect({ instance, onSaved }: { instance: EvoInstance; onSaved: () => Promise<void> }) {
  const [status, setStatus] = useState<MetaStatus | null>(null)
  const [conn, setConn] = useState<MetaConnection | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(() => connectReturn)

  useEffect(() => {
    connectReturn = null
    void metaApi.status().then(setStatus).catch((e) => setMsg({ tone: 'bad', text: (e as Error).message }))
  }, [])

  const load = useCallback(async () => {
    setConn((await metaApi.line(instance.id)).connection)
  }, [instance.id])

  useEffect(() => {
    setConn(undefined)
    void load().catch((e) => setMsg({ tone: 'bad', text: (e as Error).message }))
  }, [load])

  const connect = async (rerequest = false) => {
    setBusy(true)
    setMsg(null)
    try {
      window.location.href = (await metaApi.start('connect', instance.id, rerequest)).url
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message })
      setBusy(false)
    }
  }

  const left = daysLeft(conn?.expires_at ?? null)

  let badge = <Badge>não conectado</Badge>
  if (conn?.expired) badge = <Badge tone="bad">acesso expirado</Badge>
  else if (conn) badge = <Badge tone="good">conectado</Badge>

  return (
    <Card
      title="Conexão com o Facebook"
      subtitle={`Entre com o Facebook de ${instance.label} e escolha Pixel, conta de anúncios e Página — sem copiar token.`}
      actions={badge}
    >
      <div className="space-y-4">
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

        {status && !status.configured && <SetupGuide status={status} />}

        {status?.configured && conn === null && (
          <div className="flex flex-wrap items-center gap-4">
            <Button variant="primary" disabled={busy} onClick={() => void connect()}>
              <IconFacebook className="h-4 w-4" />
              {busy ? 'abrindo o Facebook…' : 'Conectar com Facebook'}
            </Button>
            <p className="max-w-xl text-[11px] leading-snug text-ink-500">
              Você vai autorizar no próprio Facebook. Pedimos acesso a anúncios, Pixel e Páginas — nunca à sua senha.
            </p>
          </div>
        )}

        {status?.configured && conn && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-400">
              <span>
                Conectado como <strong className="text-ink-100">{conn.fb_user_name ?? conn.fb_user_id}</strong>
              </span>
              {left !== null && !conn.expired && (
                <span className={left <= 7 ? 'text-amber-300' : ''}>
                  acesso vale por mais {left} dia(s)
                </span>
              )}
              <div className="ml-auto flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void connect()}>
                  Reconectar
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={async () => {
                    if (!window.confirm(`Desconectar o Facebook de ${instance.label}? Os leads já recebidos ficam.`)) return
                    setBusy(true)
                    try {
                      await metaApi.disconnect(instance.id)
                      setConn(null)
                      await onSaved()
                      setMsg({ tone: 'good', text: 'Facebook desconectado desta linha.' })
                    } catch (e) {
                      setMsg({ tone: 'bad', text: (e as Error).message })
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  Desconectar
                </Button>
              </div>
            </div>

            {conn.expired && (
              <Banner tone="bad">O acesso dado pelo Facebook expirou (dura ~60 dias). Clique em Reconectar.</Banner>
            )}
            {!conn.expired && left !== null && left <= 7 && (
              <Banner tone="warn">
                O acesso expira em {left} dia(s). Reconecte antes para as conversões não pararem — ou cole um token de
                usuário do sistema (não expira) no card abaixo.
              </Banner>
            )}
            {conn.missing_scopes.length > 0 && (
              <Banner tone="warn">
                Faltam permissões: {conn.missing_scopes.map((s) => SCOPE_LABEL[s] ?? s).join(', ')}.{' '}
                <button type="button" className="underline" onClick={() => void connect(true)}>
                  Pedir de novo
                </button>
              </Banner>
            )}

            {!conn.expired && (
              <AssetPicker
                numberId={instance.id}
                conn={conn}
                onSaved={async (next, applied) => {
                  setConn(next)
                  await onSaved()
                  const kept = !applied.includes('meta_capi_token') && next.pixel_id
                  setMsg({
                    tone: 'good',
                    text:
                      'Salvo nesta linha.' +
                      (kept ? ' O token da API de Conversões colado à mão foi mantido (ele tem prioridade).' : ''),
                  })
                }}
              />
            )}

            {!conn.expired && <LeadAds numberId={instance.id} conn={conn} onChanged={load} />}

            {status && !status.webhook_ready && conn.page_id && (
              <p className="text-[11px] text-ink-500">
                Sem <code className="font-mono">META_WEBHOOK_VERIFY_TOKEN</code> no servidor os leads só entram pelo
                botão Importar. Webhook: <code className="font-mono">{status.webhook_url}</code>
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
