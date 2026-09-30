import { useEffect, useState } from 'react'

import { journeysApi, type JourneyDetail, type TagSetup } from '../api'
import { JourneyDetailView } from '../JourneyView'
import { requireId, useNumber } from '../numberContext'
import { Badge, Banner, Button, Card, Copy, Empty, Field, Input, RadioGroup, Select, when } from '../ui'

const CAPTURED: { group: string; items: string[] }[] = [
  { group: 'Identificação', items: ['tl / transaction_id', 'visitor_id', 'session_id', 'event_id', 'event_name', 'event_time'] },
  { group: 'Página', items: ['page_url', 'page_path', 'page_title', 'page_referrer', 'landing_page', 'hostname'] },
  { group: 'UTMs', items: ['utm_source…utm_term', 'first touch (aquisição)', 'last touch (conversão)'] },
  { group: 'Meta', items: ['fbclid', '_fbp', '_fbc (só com fbclid real)'] },
  { group: 'Google', items: ['gclid', 'gbraid', 'wbraid', 'gad_source'] },
  { group: 'TikTok', items: ['ttclid', '_ttp'] },
  { group: 'GA4', items: ['client_id', 'session_id', 'session_number'] },
  { group: 'Técnico', items: ['IP', 'User-Agent'] },
]

const EVENTS = [
  ['page_view', 'automático em cada página'],
  ['click_whatsapp', 'automático em links wa.me / api.whatsapp.com e window.open'],
  ['click_phone', 'automático em links tel:'],
  ['click_email', 'automático em links mailto:'],
  ['click_instagram', 'automático em links para instagram.com'],
  ['form_start', 'automático no primeiro campo focado de um formulário'],
  ['form_submit', 'automático no envio de um formulário'],
  ['view_service', 'marque a página com data-tl-service="implante"'],
] as const

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-[11.5px] leading-relaxed text-wa-500">
      {children}
    </pre>
  )
}

function Install({ numberId }: { numberId: number }) {
  const [setup, setSetup] = useState<TagSetup | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSetup(null)
    journeysApi
      .setup(numberId)
      .then(setSetup)
      .catch((e: Error) => setError(e.message))
  }, [numberId])

  const rotate = async () => {
    if (!confirm('Gerar uma chave nova? A tag antiga para de gravar eventos até você trocar o snippet no site.')) return
    setSetup(await journeysApi.rotateKey(numberId))
  }

  if (error) return <Banner tone="bad">{error}</Banner>
  if (!setup) return <p className="text-sm text-ink-500">carregando…</p>

  const live = setup.last_event_at && Date.now() - new Date(setup.last_event_at).getTime() < 86400_000

  return (
    <div className="space-y-5">
      <Card
        title="1. Instale a tag no site"
        subtitle="Uma linha só, antes do </head>, em todas as páginas. Ela gera ou recupera o TL_ID e manda os eventos."
        actions={<Copy text={setup.snippet} />}
      >
        <div className="space-y-3">
          <Code>{setup.snippet}</Code>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {setup.last_event_at ? (
              <Badge tone={live ? 'good' : 'warn'}>
                último evento {when(setup.last_event_at)} · {setup.last_event_host}
              </Badge>
            ) : (
              <Badge tone="warn">nenhum evento recebido ainda</Badge>
            )}
            <span className="text-ink-500">
              chave pública <span className="font-mono text-ink-300">{setup.site_key}</span>
            </span>
            <button type="button" onClick={rotate} className="text-ink-500 underline-offset-2 hover:text-ink-100 hover:underline">
              gerar outra
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-ink-500">
            O endereço vem de <span className="font-mono">PUBLIC_BASE_URL</span>. O site precisa alcançar{' '}
            <span className="font-mono text-ink-300">/t/tl.js</span> e <span className="font-mono text-ink-300">/t/collect</span>{' '}
            por HTTPS — o nginx do painel já faz o proxy de <span className="font-mono">/t/</span>.
          </p>
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="2. O que ela registra" subtitle="Não só PageView: todo evento relevante da jornada entra na tabela">
          <div className="space-y-1.5">
            {EVENTS.map(([name, how]) => (
              <div key={name} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                <span className={`font-mono ${name === 'click_whatsapp' ? 'text-wa-500' : 'text-ink-100'}`}>{name}</span>
                <span className="text-right text-ink-500">{how}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-ink-500">Qualquer outro evento:</p>
          <Code>{`tracklabs.track('agendou_avaliacao', { servico: 'implante' })`}</Code>
        </Card>

        <Card title="3. Dados capturados em cada evento" subtitle="tracking_events · 1 linha por evento · transaction_id = TL_ID">
          <div className="grid gap-x-4 gap-y-2.5 sm:grid-cols-2">
            {CAPTURED.map((c) => (
              <div key={c.group}>
                <p className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-500">{c.group}</p>
                <p className="font-mono text-[11.5px] leading-relaxed text-ink-300">{c.items.join(' · ')}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card
        title="4. Propagação do tl"
        subtitle="Duas camadas: a URL dos links internos e a mensagem que inicia a conversa"
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">Camada URL</p>
            <p className="text-xs text-ink-400">Os links internos ganham <span className="font-mono">?tl=TL_ID</span> sozinhos.</p>
            <Code>{`https://seusite.com.br/studio/?tl=1790195601229_17901956838213`}</Code>
            <p className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-500">Camada WhatsApp</p>
            <p className="text-xs leading-relaxed text-ink-400">
              No clique, a tag anexa a referência na mensagem pré-preenchida. Quando a conversa chega, o backend lê o
              TL_ID, consulta <span className="font-mono">tracking_events</span> e cria o lead já com a origem. No CRM a
              referência técnica fica escondida.
            </p>
            <p className="text-xs leading-relaxed text-ink-400">
              Prefere algo mais discreto? Use um protocolo curto:
            </p>
            <Code>{`<script>window.tracklabsConfig = { reference: 'protocol' }</script>`}</Code>
          </div>
          <div className="wa-wallpaper flex flex-col justify-end gap-1.5 rounded-xl border border-ink-800 p-4">
            <div className="mx-auto mb-2 rounded-md bg-chat-header px-2.5 py-1 text-[11px] uppercase tracking-wide text-chat-muted">
              hoje
            </div>
            <div className="ml-auto max-w-[85%] rounded-lg rounded-tr-none bg-chat-out px-2.5 py-1.5 text-[13.5px] leading-snug text-chat-text shadow-sm">
              Olá! Quero saber mais sobre implante.
              <br />
              <br />
              <span className="font-mono text-[12px] text-chat-muted">tl=1790195601229_1790…</span>
              <span className="float-right ml-3 mt-1 text-[10.5px] text-chat-muted">14:32 ✓✓</span>
            </div>
            <p className="text-right text-[10.5px] text-chat-muted">referência técnica anexada ao clique</p>
          </div>
        </div>
      </Card>
    </div>
  )
}

function Simulator({ numberId }: { numberId: number }) {
  const [preset, setPreset] = useState('google')
  const [reference, setReference] = useState('tl')
  const [message, setMessage] = useState('Olá! Quero saber mais sobre implante.')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ tl: string; summary?: string } | null>(null)
  const [detail, setDetail] = useState<JourneyDetail | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    setDetail(null)
    try {
      const r = await journeysApi.simulate({ number_id: numberId, preset, reference, message })
      setResult({ tl: r.transaction_id, summary: r.summary })
      setDetail(await journeysApi.get(r.transaction_id, numberId))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Simular uma jornada inteira"
      subtitle="Anúncio → site (5 eventos) → clique no WhatsApp → conversa → lead. Sem gastar clique em anúncio."
    >
      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <Field label="Origem do visitante">
            <Select value={preset} onChange={(e) => setPreset(e.target.value)}>
              <option value="google">Google Ads (gclid + UTMs)</option>
              <option value="meta">Meta Ads (fbclid, _fbp, _fbc)</option>
              <option value="tiktok">TikTok Ads (ttclid)</option>
              <option value="organic">Orgânico (busca do Google)</option>
              <option value="direct">Direto</option>
            </Select>
          </Field>
          <Field label="Como a conversa chega" hint="Testa cada degrau da estratégia de identificação.">
            <RadioGroup
              name="ref"
              value={reference}
              onChange={setReference}
              options={[
                { value: 'tl', label: 'com tl=', help: 'TL_ID na mensagem — score 1.00' },
                { value: 'protocol', label: 'protocolo', help: 'protocolo curto do clique — score 0.95' },
                { value: 'none', label: 'sem nada', help: 'janela temporal — score 0.75' },
              ]}
            />
          </Field>
          <Field label="Mensagem do visitante">
            <Input value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <Button variant="primary" onClick={run} disabled={busy}>
            {busy ? 'simulando…' : 'Simular jornada'}
          </Button>
          {error && <Banner tone="bad">{error}</Banner>}
          {result?.summary && <Banner tone="good">{result.summary}</Banner>}
          <p className="text-[11px] leading-relaxed text-ink-500">
            O lead simulado entra no CRM desta linha como qualquer outro, com a origem recuperada da jornada.
          </p>
        </div>
        <div className="min-w-0 rounded-xl border border-ink-800 bg-ink-950/40 p-4">
          {detail ? <JourneyDetailView detail={detail} /> : <Empty>A jornada simulada aparece aqui.</Empty>}
        </div>
      </div>
    </Card>
  )
}

export default function SiteTag() {
  const { numberId } = useNumber()
  const id = requireId(numberId)
  if (id === null) {
    return <Banner tone="warn">Escolha uma linha no seletor do topo: cada linha tem a sua tag.</Banner>
  }
  return (
    <div className="space-y-5">
      <Install numberId={id} />
      <Simulator numberId={id} />
    </div>
  )
}
