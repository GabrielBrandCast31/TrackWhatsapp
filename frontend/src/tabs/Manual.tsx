import { useEffect, useState } from 'react'

import { api, numbersApi, type ConfigResponse, type WaNumber } from '../api'
import { Badge, Banner, Button, Card, Copy, Field, Input } from '../ui'

const SECTIONS = [
  { id: 'fluxo', label: 'Como funciona' },
  { id: 'checklist', label: 'O que falta configurar' },
  { id: 'passos', label: 'Passo a passo' },
  { id: 'testar', label: 'Testar sem anúncio' },
  { id: 'google', label: 'O caso do Google Ads' },
  { id: 'glossario', label: 'Glossário' },
  { id: 'problemas', label: 'Problemas comuns' },
]

/* ---------- blocos de apoio ---------- */

function Section({ id, title, subtitle, children }: {
  id: string
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <Card title={title} subtitle={subtitle}>
        {children}
      </Card>
    </section>
  )
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-ink-300">{children}</p>
}

function C({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-ink-950 px-1 py-0.5 font-mono text-[12px] text-wa-500">{children}</code>
}

function Step({ n, title, children, action }: {
  n: number
  title: string
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <li className="relative pl-11">
      <span className="absolute left-0 top-0 flex h-7 w-7 items-center justify-center rounded-full border border-wa-500/40 bg-wa-900/50 font-mono text-xs font-semibold text-wa-500">
        {n}
      </span>
      <h3 className="pt-1 text-sm font-semibold text-ink-100">{title}</h3>
      <div className="mt-2 space-y-2.5">{children}</div>
      {action && <div className="mt-3">{action}</div>}
    </li>
  )
}

/* ---------- diagrama do fluxo ---------- */

function FlowBox({ title, note, tone }: { title: string; note: string; tone?: 'wa' | 'plain' }) {
  return (
    <div
      className={`flex-1 rounded-lg border px-3 py-2.5 text-center ${
        tone === 'wa' ? 'border-wa-500/40 bg-wa-900/40' : 'border-ink-700 bg-ink-850'
      }`}
    >
      <p className={`text-xs font-semibold ${tone === 'wa' ? 'text-wa-500' : 'text-ink-100'}`}>{title}</p>
      <p className="mt-1 font-mono text-[10px] leading-tight text-ink-500">{note}</p>
    </div>
  )
}

function Arrow({ label }: { label: string }) {
  return (
    <div className="flex shrink-0 flex-col items-center justify-center px-1 py-2 sm:py-0">
      <span className="font-mono text-[10px] text-ink-500">{label}</span>
      <span className="text-ink-700">
        <span className="hidden sm:inline">→</span>
        <span className="sm:hidden">↓</span>
      </span>
    </div>
  )
}

/* ---------- checklist vivo ---------- */

type Item = { label: string; ok: boolean; optional?: boolean; why: string }

function CheckRow({ item }: { item: Item }) {
  const tone = item.ok ? 'good' : item.optional ? 'neutral' : 'warn'
  const text = item.ok ? 'ok' : item.optional ? 'opcional' : 'falta'
  return (
    <li className="flex items-start gap-3 py-2">
      <span className="mt-0.5 shrink-0">
        <Badge tone={tone}>{text}</Badge>
      </span>
      <div className="min-w-0">
        <p className={`text-xs font-medium ${item.ok ? 'text-ink-300' : 'text-ink-100'}`}>{item.label}</p>
        {!item.ok && <p className="mt-0.5 text-[11px] leading-snug text-ink-500">{item.why}</p>}
      </div>
    </li>
  )
}

function Group({ title, items, onGo }: { title: string; items: Item[]; onGo?: () => void }) {
  const done = items.filter((i) => i.ok).length
  const blocking = items.filter((i) => !i.ok && !i.optional).length
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-850 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-ink-100">{title}</h3>
        <Badge tone={blocking === 0 ? 'good' : 'warn'}>
          {done}/{items.length}
        </Badge>
      </div>
      <ul className="mt-1 divide-y divide-ink-800">
        {items.map((i) => (
          <CheckRow key={i.label} item={i} />
        ))}
      </ul>
      {onGo && (
        <div className="mt-3">
          <Button size="sm" onClick={onGo}>
            abrir aba
          </Button>
        </div>
      )}
    </div>
  )
}

/* ---------- a aba ---------- */

export default function Manual({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const [cfg, setCfg] = useState<ConfigResponse | null>(null)
  // o checklist abaixo e da Cloud API: olha a linha Cloud padrao, nao a instancia
  // da Evolution selecionada na tela principal.
  const [current, setCurrent] = useState<WaNumber | undefined>(undefined)
  const [phone, setPhone] = useState('5511999998888')

  useEffect(() => {
    void api.getConfig().then(setCfg).catch(() => setCfg(null))
    void numbersApi
      .list('cloud')
      .then((rows) => setCurrent(rows.find((n) => n.is_default) ?? rows[0]))
      .catch(() => setCurrent(undefined))
  }, [])

  const val = (k: string) => String(cfg?.config[k] ?? '')
  // um campo conta como preenchido se o global tem OU a linha em uso sobrescreve
  const has = (k: string) => {
    const own = current?.overrides ?? {}
    const ownSet = Boolean(own[`${k}__set`]) || String(own[k] ?? '').length > 0
    return ownSet || Boolean(cfg?.config[`${k}__set`]) || val(k).length > 0
  }

  const webhookUrl = cfg?.webhook_url ?? ''
  const publicOk = webhookUrl.startsWith('https://')

  const waLink = `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(
    'Olá! Vim pelo anúncio. gclid={gclid}',
  )}`

  // as credenciais da Cloud API sao POR LINHA — o checklist olha a linha em uso
  const conexao: Item[] = [
    {
      label: 'Linha selecionada',
      ok: Boolean(current),
      why: current
        ? `Checklist da linha Cloud API "${current.label}".`
        : 'Nenhuma linha da Cloud API cadastrada — este checklist é do canal legado (aba Cloud API).',
    },
    {
      label: 'Access Token',
      ok: Boolean(current?.access_token__set),
      why: 'Sem ele a plataforma não fala com a Graph API por esta linha.',
    },
    {
      label: 'Phone Number ID',
      ok: Boolean(current?.phone_number_id),
      why: 'Identifica qual número recebe as mensagens.',
    },
    {
      label: 'WABA ID',
      ok: Boolean(current?.business_account_id),
      why: 'Necessário para assinar os webhooks e listar templates desta linha.',
    },
    {
      label: 'Verify Token',
      ok: Boolean(current?.verify_token),
      why: 'A Meta usa para validar a URL do webhook desta linha.',
    },
    {
      label: 'App Secret',
      ok: Boolean(current?.app_secret__set),
      optional: true,
      why: 'Em branco, qualquer um pode forjar um webhook desta linha. Preencha antes de ir a produção.',
    },
    {
      label: 'URL pública HTTPS',
      ok: publicOk,
      why: `Hoje é ${webhookUrl || '—'}. A Meta só entrega webhook em HTTPS público — use ngrok em dev.`,
    },
  ]

  const meta: Item[] = [
    { label: 'Dataset / Pixel ID', ok: has('meta_dataset_id'), why: 'Destino do evento no Events Manager.' },
    { label: 'Token da Conversions API', ok: has('meta_capi_token'), why: 'Gerado em Events Manager → Configurações.' },
    {
      label: 'Test Event Code',
      ok: has('meta_test_event_code'),
      optional: true,
      why: 'Sem ele, o modo teste não separa o evento da otimização real.',
    },
  ]

  const google: Item[] = [
    { label: 'Customer ID', ok: has('google_customer_id'), why: 'A conta do Google Ads que recebe a conversão.' },
    { label: 'Conversion Action ID', ok: has('google_conversion_action_id'), why: 'A ação do tipo Importar.' },
    { label: 'Developer Token', ok: has('google_developer_token'), why: 'Emitido no MCC, com acesso à API.' },
    { label: 'OAuth completo', ok: has('google_client_id') && has('google_client_secret') && has('google_refresh_token'), why: 'Client ID + Secret + Refresh Token.' },
  ]

  const saida: Item[] = [
    { label: 'URL de destino', ok: has('webhook_url'), optional: true, why: 'n8n, Make, GTM server-side ou seu backend.' },
    { label: 'Secret (HMAC)', ok: has('webhook_secret'), optional: true, why: 'Assina o corpo em X-Signature-256.' },
  ]

  return (
    <div className="grid gap-5 lg:grid-cols-[190px_minmax(0,1fr)]">
      <nav className="hidden lg:block">
        <div className="sticky top-6 space-y-1">
          <p className="mb-2 px-2.5 text-[11px] uppercase tracking-wide text-ink-500">Neste manual</p>
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="block rounded-lg px-2.5 py-1.5 text-xs text-ink-500 transition-colors hover:bg-ink-850 hover:text-ink-100"
            >
              {s.label}
            </a>
          ))}
        </div>
      </nav>

      <div className="max-w-3xl space-y-5">
        {/* ---- fluxo ---- */}
        <Section
          id="fluxo"
          title="Como funciona"
          subtitle="Vale entender isso antes de mexer em qualquer campo — o resto é consequência."
        >
          <div className="space-y-4">
            <P>
              Quem clica num anúncio <strong className="text-ink-100">Click to WhatsApp</strong> sai do Facebook ou do
              Instagram e cai na conversa. Nesse pulo, a Meta perde o rastro: a campanha sabe que houve clique, mas não
              sabe que virou cliente. Esta plataforma existe para fechar esse buraco.
            </P>

            <div className="flex flex-col gap-1 rounded-xl border border-ink-800 bg-ink-950 p-4 sm:flex-row sm:items-stretch">
              <FlowBox title="Anúncio CTWA" note="Meta / Instagram" />
              <Arrow label="clique" />
              <FlowBox title="WhatsApp" note="1ª mensagem" />
              <Arrow label="webhook" />
              <FlowBox title="Esta plataforma" note="grava ctwa_clid" tone="wa" />
              <Arrow label="conversão" />
              <FlowBox title="Meta / Google" note="otimização" />
            </div>

            <Banner tone="warn">
              O <C>ctwa_clid</C> chega dentro do objeto <C>referral</C> <strong>só na primeira mensagem depois do
              clique</strong>. Se você perder esse webhook, aquele lead nunca mais fica atribuível — não existe forma de
              recuperar depois. Por isso a plataforma grava no ato e nunca sobrescreve a atribuição nas mensagens
              seguintes.
            </Banner>

            <P>
              Quando você dispara a conversão, o evento sai com <C>action_source: business_messaging</C> e o{' '}
              <C>ctwa_clid</C> dentro de <C>user_data</C>. É esse par que faz a Meta reconhecer a venda e devolver o
              aprendizado para a campanha que gerou o clique.
            </P>
          </div>
        </Section>

        {/* ---- checklist ---- */}
        <Section
          id="checklist"
          title="O que falta configurar"
          subtitle="Lido da configuração real desta instalação, agora."
        >
          {!cfg ? (
            <p className="text-sm text-ink-500">carregando…</p>
          ) : (
            <div className="space-y-3">
              <Group
                title={`1. Conexão com o WhatsApp${current ? ` · ${current.label}` : ''}`}
                items={conexao}
                onGo={() => onNavigate('numbers')}
              />
              <Group title="2. Meta Conversions API" items={meta} onGo={() => onNavigate('destinations')} />
              <Group title="3. Google Ads (opcional)" items={google} onGo={() => onNavigate('destinations')} />
              <Group title="4. Webhook de saída (opcional)" items={saida} onGo={() => onNavigate('destinations')} />
              <P>
                Destinos ativos agora:{' '}
                {cfg.enabled_destinations.length === 0 ? (
                  <Badge tone="warn">nenhum</Badge>
                ) : (
                  cfg.enabled_destinations.map((d) => (
                    <span key={d} className="mr-1 inline-block">
                      <Badge tone="good">{d}</Badge>
                    </span>
                  ))
                )}
              </P>
            </div>
          )}
        </Section>

        {/* ---- passo a passo ---- */}
        <Section id="passos" title="Passo a passo" subtitle="A ordem importa: cada etapa depende da anterior.">
          <ol className="space-y-7">
            <Step
              n={1}
              title="Exponha a plataforma em HTTPS"
              action={<Button size="sm" onClick={() => onNavigate('connection')}>Ir para Conexão</Button>}
            >
              <P>
                A Meta se recusa a entregar webhook em <C>localhost</C>. Em desenvolvimento, rode{' '}
                <C>ngrok http 3031</C> e coloque o host gerado em <C>PUBLIC_BASE_URL</C> no <C>.env</C>. Reinicie o
                backend depois de mudar.
              </P>
              <div className="flex items-center gap-2 rounded-lg border border-ink-800 bg-ink-950 px-3 py-2">
                <code className="flex-1 truncate font-mono text-xs text-wa-500">{webhookUrl || '—'}</code>
                {webhookUrl && <Copy text={webhookUrl} />}
              </div>
              {!publicOk && (
                <Banner tone="warn">
                  Esta URL não é HTTPS pública. Serve para testar com o simulador, mas a Meta não vai conseguir entregar
                  mensagem real nela.
                </Banner>
              )}
            </Step>

            <Step
              n={2}
              title="Preencha as credenciais do WhatsApp"
              action={<Button size="sm" onClick={() => onNavigate('connection')}>Ir para Conexão</Button>}
            >
              <P>
                Access Token, Phone Number ID e WABA ID saem do painel Meta for Developers, em WhatsApp → API Setup. O
                Verify Token você inventa — só precisa ser o mesmo dos dois lados.
              </P>
              <P>
                Salve e clique em <strong className="text-ink-100">Testar conexão</strong>. Se o número responder, o
                token está valendo.
              </P>
            </Step>

            <Step n={3} title="Registre o webhook no painel da Meta">
              <P>
                Em WhatsApp → Configuration → Webhook, cole a URL acima e o mesmo Verify Token. A Meta faz uma chamada
                de verificação na hora; se o token bater, ela aceita.
              </P>
              <Banner tone="warn">
                Não esqueça de <strong>assinar o campo <C>messages</C></strong>. É o erro mais comum: o webhook fica
                verde no painel da Meta, mas nada chega, porque nenhum campo foi assinado.
              </Banner>
              <P>
                Volte aqui e clique em <strong className="text-ink-100">Assinar webhooks</strong> para confirmar que o
                app está inscrito no WABA.
              </P>
            </Step>

            <Step
              n={4}
              title="Configure ao menos um destino"
              action={<Button size="sm" onClick={() => onNavigate('destinations')}>Ir para Destinos</Button>}
            >
              <P>
                O mínimo útil é a <strong className="text-ink-100">Meta CAPI</strong>: Dataset ID e o token gerado em
                Events Manager → Configurações. Aproveite e preencha o Test Event Code — é ele que permite ensaiar sem
                sujar a otimização da campanha.
              </P>
            </Step>

            <Step
              n={5}
              title="Valide com um lead simulado antes de subir anúncio"
              action={<Button size="sm" variant="primary" onClick={() => onNavigate('leads')}>Ir para Leads</Button>}
            >
              <P>
                Não gaste verba para descobrir que faltava um campo. O simulador injeta um payload idêntico ao da Meta e
                exercita o caminho inteiro. A seção abaixo explica.
              </P>
            </Step>
          </ol>
        </Section>

        {/* ---- testar ---- */}
        <Section
          id="testar"
          title="Testar sem gastar clique em anúncio"
          subtitle="Três níveis, do mais seguro ao real."
        >
          <div className="space-y-5">
            <div>
              <h3 className="text-sm font-semibold text-ink-100">Nível 1 — simulador, sem credencial nenhuma</h3>
              <div className="mt-2 space-y-2.5">
                <P>
                  Em <strong className="text-ink-100">Leads → Simular lead</strong>, a plataforma monta um webhook igual
                  ao da Meta, com <C>referral.ctwa_clid</C> preenchido, e processa como se fosse real. O lead aparece na
                  lista com a atribuição já extraída.
                </P>
                <P>
                  Abra o lead e clique em <strong className="text-ink-100">Ver payload</strong>: monta o JSON dos três
                  destinos e mostra na tela <em>sem enviar nada</em>. É aqui que você confere se o <C>ctwa_clid</C>{' '}
                  entrou no lugar certo e se o telefone foi hasheado.
                </P>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-ink-100">Nível 2 — envio real, sem sujar a campanha</h3>
              <div className="mt-2 space-y-2.5">
                <P>
                  Com o Test Event Code preenchido e o <strong className="text-ink-100">modo teste</strong> ligado, o
                  evento vai de verdade para a Meta, aparece em Events Manager → Test Events, e{' '}
                  <strong className="text-ink-100">não entra na otimização</strong>. É o ensaio geral.
                </P>
                <P>
                  A aba <strong className="text-ink-100">Conversões</strong> guarda request e response de cada destino.
                  O request é gravado <em>antes</em> do envio, então mesmo um destino que recusou deixa visível o JSON
                  exato que foi montado — é por ali que se descobre o motivo da recusa.
                </P>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-ink-100">Nível 3 — mensagem real no WhatsApp</h3>
              <div className="mt-2 space-y-2.5">
                <P>
                  Só depois de o simulador passar limpo. Com o ngrok no ar e o webhook assinado, mande uma mensagem para
                  o número pelo próprio link do anúncio. Confira em{' '}
                  <strong className="text-ink-100">Conexão → Últimos webhooks recebidos</strong>: o payload cru da Meta
                  aparece ali, e é a prova de que o <C>referral</C> está chegando.
                </P>
              </div>
            </div>

            <Banner tone="good">
              Retry é seguro. Cada conversão tem um <C>event_id</C> único e a Meta deduplica por ele — reenviar não
              conta duas vezes.
            </Banner>
          </div>
        </Section>

        {/* ---- google ---- */}
        <Section
          id="google"
          title="O caso do Google Ads"
          subtitle="Funciona diferente da Meta, e é onde quase todo mundo trava."
        >
          <div className="space-y-4">
            <P>
              O Google <strong className="text-ink-100">não injeta <C>gclid</C> no WhatsApp</strong>. Não existe
              equivalente ao <C>ctwa_clid</C>: se o anúncio manda direto para o <C>wa.me</C>, o clique se perde e não há
              o que rastrear.
            </P>
            <P>
              O caminho que funciona é passar por uma landing page. O anúncio leva para a sua página, que lê o{' '}
              <C>gclid</C> da própria URL e monta o link do WhatsApp com esse valor embutido no texto pré-preenchido.
              Quando a pessoa envia a mensagem, o identificador vem junto — e o extrator o encontra.
            </P>

            <div className="space-y-3 rounded-lg border border-ink-800 bg-ink-850 p-4">
              <Field label="Seu número (com DDI)" hint="Monta o modelo de link que a landing deve gerar.">
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
              </Field>
              <div className="flex items-center gap-2 rounded-lg border border-ink-800 bg-ink-950 px-3 py-2">
                <code className="flex-1 truncate font-mono text-[11px] text-wa-500">{waLink}</code>
                <Copy text={waLink} />
              </div>
              <p className="text-[11px] leading-relaxed text-ink-500">
                Troque <C>{'{gclid}'}</C> pelo valor real capturado da URL da landing. A plataforma lê{' '}
                <C>gclid</C>, <C>wbraid</C>, <C>gbraid</C> e UTMs tanto do texto da mensagem quanto da{' '}
                <C>source_url</C>.
              </p>
            </div>

            <P>
              Do lado do Google Ads, a conversão precisa ser do tipo <strong className="text-ink-100">Importar</strong>{' '}
              — o upload usa <C>uploadClickConversions</C>. Uma ação criada como conversão de site não aceita o envio.
            </P>
          </div>
        </Section>

        {/* ---- glossário ---- */}
        <Section id="glossario" title="Glossário">
          <dl className="divide-y divide-ink-800">
            {[
              ['ctwa_clid', 'O identificador do clique no anúncio Click to WhatsApp. Chega no referral da primeira mensagem e é o que amarra a conversa à campanha.'],
              ['gclid / wbraid / gbraid', 'Equivalentes do Google. gclid é o clássico; wbraid e gbraid aparecem quando há restrição de cookie no iOS.'],
              ['CAPI', 'Conversions API. O canal server-to-server da Meta — não depende de pixel nem de navegador.'],
              ['action_source', 'Diz à Meta onde a conversão aconteceu. Para WhatsApp o valor correto é business_messaging.'],
              ['event_id', 'Chave de deduplicação. Único por conversão, o que torna o retry seguro.'],
              ['Dataset ID', 'O destino do evento no Events Manager. Em contas antigas aparece como Pixel ID.'],
              ['WABA', 'WhatsApp Business Account. Agrupa os números; é nela que o app assina os webhooks.'],
              ['Janela de 24h', 'Depois que a pessoa te escreve, você pode responder livremente por 24 horas. Fora disso, só com template aprovado.'],
            ].map(([term, def]) => (
              <div key={term} className="grid gap-1 py-2.5 sm:grid-cols-[170px_1fr] sm:gap-4">
                <dt className="font-mono text-xs text-wa-500">{term}</dt>
                <dd className="text-xs leading-relaxed text-ink-300">{def}</dd>
              </div>
            ))}
          </dl>
        </Section>

        {/* ---- problemas ---- */}
        <Section id="problemas" title="Problemas comuns">
          <ul className="space-y-3">
            {[
              {
                q: 'O webhook está verde na Meta, mas nenhum lead aparece.',
                a: 'Quase sempre é o campo messages não assinado. Verificar a URL e assinar campos são duas coisas separadas no painel da Meta. Clique em Assinar webhooks na aba Conexão.',
              },
              {
                q: 'O lead chegou, mas sem ctwa_clid.',
                a: 'Ou a pessoa não veio de anúncio, ou essa não foi a primeira mensagem depois do clique. O referral só vem uma vez. Se a conversa já existia antes, não há atribuição a recuperar.',
              },
              {
                q: 'A Meta aceitou o evento mas ele não aparece em Test Events.',
                a: 'O test_event_code só é enviado com o modo teste ligado no disparo. Sem o código preenchido em Destinos, o evento vai como produção.',
              },
              {
                q: 'O Google Ads recusa o upload.',
                a: 'Confira se a Conversion Action é do tipo Importar e se o Customer ID está sem traços. Se a conta é acessada por central, o Login Customer ID (MCC) também é obrigatório.',
              },
              {
                q: 'Mudei o PUBLIC_BASE_URL e a URL do webhook não mudou.',
                a: 'Ela é lida do ambiente na subida do backend. Reinicie o container para valer.',
              },
              {
                q: 'A mensagem de teste falha com erro de janela.',
                a: 'Envio livre só dentro de 24h após a pessoa te escrever. Fora disso, a Meta exige template aprovado — a plataforma não envia template.',
              },
            ].map((f) => (
              <li key={f.q} className="rounded-lg border border-ink-800 bg-ink-850 px-4 py-3">
                <p className="text-xs font-semibold text-ink-100">{f.q}</p>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-300">{f.a}</p>
              </li>
            ))}
          </ul>
        </Section>

        <Banner tone="warn">
          Antes de produção: preencha o <strong>App Secret</strong>. Sem ele a validação de assinatura é ignorada e
          qualquer um que descubra sua URL consegue injetar leads falsos.
        </Banner>
      </div>
    </div>
  )
}
