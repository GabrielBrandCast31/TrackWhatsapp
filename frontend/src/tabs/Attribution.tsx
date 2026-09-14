import { useEffect, useMemo, useState } from 'react'

import { api, numbersApi, type Contact, type ConfigResponse, type Stats, type WaNumber } from '../api'
import { useNumber } from '../numberContext'
import { Badge, Banner, Button, Card, Copy } from '../ui'

/** Por que a conversa ainda não vira campanha, e o caminho para que vire.
 *
 *  A página é meio diagnóstico, meio manual: os números do topo saem da base
 *  real desta instalação, então o texto abaixo deles nunca fala de um cenário
 *  hipotético — fala do que está acontecendo aqui, agora.
 */

const SECTIONS = [
  { id: 'diagnostico', label: 'Onde você está' },
  { id: 'elo', label: 'O elo que falta' },
  { id: 'evolution', label: 'Por que a Evolution não fecha' },
  { id: 'hoje', label: 'O que dá pra fazer hoje' },
  { id: 'oficial', label: 'O caminho oficial' },
  { id: 'checklist', label: 'Checklist ao vivo' },
  { id: 'comparativo', label: 'Evolution × Cloud API' },
  { id: 'erros', label: 'Erros comuns' },
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

function Pre({ code, note }: { code: string; note?: string }) {
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-950">
      <div className="flex items-center justify-between gap-3 border-b border-ink-800 px-3 py-1.5">
        <span className="text-[11px] text-ink-500">{note ?? 'copie e rode no seu terminal'}</span>
        <Copy text={code} />
      </div>
      <pre className="overflow-auto p-3 font-mono text-[11px] leading-relaxed text-ink-300">{code}</pre>
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="relative pl-11">
      <span className="absolute left-0 top-0 flex h-7 w-7 items-center justify-center rounded-full border border-wa-500/40 bg-wa-900/50 font-mono text-xs font-semibold text-wa-500">
        {n}
      </span>
      <h3 className="pt-1 text-sm font-semibold text-ink-100">{title}</h3>
      <div className="mt-2 space-y-2.5">{children}</div>
    </li>
  )
}

/** Um elo da corrente de atribuição, com o veredito de quem o entrega. */
function Link({ n, title, detail, state }: {
  n: number
  title: string
  detail: string
  state: 'ok' | 'broken' | 'depends'
}) {
  const tone = state === 'ok' ? 'good' : state === 'broken' ? 'bad' : 'warn'
  const text = state === 'ok' ? 'inteiro' : state === 'broken' ? 'rompido' : 'depende'
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] ${
            state === 'broken'
              ? 'border-red-900/60 bg-red-950/40 text-red-300'
              : state === 'ok'
                ? 'border-wa-500/40 bg-wa-900/50 text-wa-500'
                : 'border-amber-900/60 bg-amber-950/40 text-amber-300'
          }`}
        >
          {n}
        </span>
        {n < 5 && <span className="my-1 w-px flex-1 bg-ink-800" />}
      </div>
      <div className="min-w-0 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-semibold text-ink-100">{title}</p>
          <Badge tone={tone}>{text}</Badge>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-ink-500">{detail}</p>
      </div>
    </li>
  )
}

function Metric({ label, value, tone, hint }: {
  label: string
  value: number | string
  tone?: 'good' | 'bad' | 'warn'
  hint: string
}) {
  const color = tone === 'good' ? 'text-wa-500' : tone === 'bad' ? 'text-red-300' : tone === 'warn' ? 'text-amber-300' : 'text-ink-100'
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-850 p-3.5">
      <p className="text-[11px] uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
      <p className="mt-1 text-[11px] leading-snug text-ink-500">{hint}</p>
    </div>
  )
}

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
        <p className="mt-0.5 text-[11px] leading-snug text-ink-500">{item.why}</p>
      </div>
    </li>
  )
}

function Group({ title, items }: { title: string; items: Item[] }) {
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
    </div>
  )
}

function Row({ cells, head }: { cells: React.ReactNode[]; head?: boolean }) {
  return (
    <tr className={head ? '' : 'border-t border-ink-800'}>
      {cells.map((cell, i) => (
        <td
          key={i}
          className={`px-3 py-2 align-top ${
            head ? 'text-[11px] uppercase tracking-wide text-ink-500' : 'text-xs leading-relaxed text-ink-300'
          } ${i === 0 && !head ? 'font-medium text-ink-100' : ''}`}
        >
          {cell}
        </td>
      ))}
    </tr>
  )
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-ink-800">
      <table className="w-full min-w-[520px] border-collapse">
        <thead className="bg-ink-850">
          <Row head cells={head} />
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <Row key={i} cells={r} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---------- a aba ---------- */

export default function Attribution() {
  const { numberId, current } = useNumber()
  const [stats, setStats] = useState<Stats | null>(null)
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [cfg, setCfg] = useState<ConfigResponse | null>(null)
  const [cloud, setCloud] = useState<WaNumber | undefined>(undefined)

  useEffect(() => {
    void api.stats(numberId).then(setStats).catch(() => setStats(null))
    void api.contacts(false, numberId).then(setContacts).catch(() => setContacts(null))
  }, [numberId])

  useEffect(() => {
    void api.getConfig().then(setCfg).catch(() => setCfg(null))
    void numbersApi
      .list('cloud')
      .then((rows) => setCloud(rows.find((n) => n.is_default) ?? rows[0]))
      .catch(() => setCloud(undefined))
  }, [])

  const diag = useMemo(() => {
    const rows = contacts ?? []
    const withClid = rows.filter((c) => c.attribution.ctwa_clid).length
    const adNoClid = rows.filter(
      (c) => !c.attribution.ctwa_clid && (c.attribution.ad_id || c.attribution.source_url),
    ).length
    return { total: rows.length, withClid, adNoClid, plain: rows.length - withClid - adNoClid }
  }, [contacts])

  const val = (k: string) => String(cfg?.config[k] ?? '')
  const hasGlobal = (k: string) => Boolean(cfg?.config[`${k}__set`]) || val(k).length > 0
  const hasCloud = (k: string) => {
    const own = cloud?.overrides ?? {}
    return Boolean(own[`${k}__set`]) || String(own[k] ?? '').length > 0 || hasGlobal(k)
  }

  const webhookUrl = cfg?.webhook_url ?? ''
  const publicOk = webhookUrl.startsWith('https://')
  const wabaId = cloud?.business_account_id || '{WABA_ID}'
  const graph = cloud?.graph_version || String(cfg?.config.graph_version ?? '') || 'v21.0'

  const datasetCurl = `# cria (ou recupera) o dataset de conversões DESTA conta do WhatsApp Business
curl -X POST \\
  "https://graph.facebook.com/${graph}/${wabaId}/dataset" \\
  -d "access_token=SEU_TOKEN_COM_whatsapp_business_manage_events"

# resposta: {"id":"1234567890123456"}  <- é ESTE id que vai no campo Dataset/Pixel`

  const testCurl = `curl -X POST \\
  "https://graph.facebook.com/${graph}/SEU_DATASET_ID/events" \\
  -H "Content-Type: application/json" \\
  -d '{
    "data": [{
      "event_name": "Lead",
      "event_time": '"$(date +%s)"',
      "action_source": "business_messaging",
      "messaging_channel": "whatsapp",
      "user_data": {
        "whatsapp_business_account_id": "${wabaId}",
        "ctwa_clid": "COLE_UM_CLID_REAL_DO_WEBHOOK"
      },
      "custom_data": { "currency": "BRL", "value": 1 }
    }],
    "test_event_code": "TESTXXXXX"
  }' \\
  -G --data-urlencode "access_token=SEU_TOKEN"`

  /* --- checklists --- */

  const linha: Item[] = [
    {
      label: 'Linha da Cloud API cadastrada',
      ok: Boolean(cloud),
      why: cloud
        ? `Linha "${cloud.label}" em Admin → Cloud API.`
        : 'Só existem instâncias da Evolution. Cadastre a linha oficial em Admin → Cloud API.',
    },
    {
      label: 'WABA ID',
      ok: Boolean(cloud?.business_account_id),
      why: 'É dele que sai o dataset de conversões e é ele que vai dentro do evento.',
    },
    {
      label: 'Phone Number ID',
      ok: Boolean(cloud?.phone_number_id && !cloud.phone_number_id.startsWith('evo:')),
      why: 'Identifica qual número recebe as mensagens da Cloud API.',
    },
    {
      label: 'Access Token',
      ok: Boolean(cloud?.access_token__set),
      why: 'Precisa carregar whatsapp_business_management e whatsapp_business_manage_events.',
    },
    {
      label: 'Verify Token',
      ok: Boolean(cloud?.verify_token),
      why: 'A Meta usa para validar a URL do webhook na hora de assinar.',
    },
    {
      label: 'App Secret',
      ok: Boolean(cloud?.app_secret__set),
      optional: true,
      why: 'Em branco, qualquer um pode forjar um webhook desta linha. Preencha antes da produção.',
    },
    {
      label: 'URL pública HTTPS',
      ok: publicOk,
      why: `Hoje é ${webhookUrl || '—'}. A Meta só entrega webhook em HTTPS público.`,
    },
  ]

  const destino: Item[] = [
    {
      label: 'Dataset ID preenchido',
      ok: hasCloud('meta_dataset_id'),
      why: 'Em Rastreamento → Meta. Tem que ser o dataset da WABA, não o pixel do site.',
    },
    {
      label: 'Token da Conversions API',
      ok: hasCloud('meta_capi_token'),
      why: 'Pode ser o mesmo token da linha, desde que tenha whatsapp_business_manage_events.',
    },
    {
      label: 'Test Event Code',
      ok: hasCloud('meta_test_event_code'),
      optional: true,
      why: 'Sem ele o modo teste mistura evento de teste com a otimização real.',
    },
    {
      label: 'Pelo menos uma regra de palavra-chave',
      ok: Boolean(stats?.rules),
      why: 'É a regra que decide o momento da conversão. Cadastre em Rastreamento.',
    },
  ]

  const isEvolution = (current?.channel ?? 'evolution') === 'evolution'

  return (
    <div className="grid gap-5 lg:grid-cols-[210px_minmax(0,1fr)]">
      <nav className="hidden lg:block">
        <div className="sticky top-6 space-y-1">
          <p className="mb-2 px-2.5 text-[11px] uppercase tracking-wide text-ink-500">Nesta página</p>
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
        {/* ---- diagnóstico ---- */}
        <Section
          id="diagnostico"
          title="Onde você está"
          subtitle={`Lido da base real${current ? ` da linha "${current.label}"` : ' de todas as linhas'}, agora.`}
        >
          <div className="space-y-4">
            <P>
              Associar conversa com campanha depende de <strong className="text-ink-100">um único dado</strong>: o{' '}
              <C>ctwa_clid</C>, o identificador que a Meta gera no clique do anúncio e entrega junto da primeira
              mensagem. Sem ele não existe atribuição — nem aproximada, nem por telefone, nem por horário. Os números
              abaixo dizem quantos dos seus leads têm esse dado.
            </P>

            {contacts === null ? (
              <p className="text-sm text-ink-500">carregando…</p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Metric label="Leads" value={diag.total} hint="conversas registradas nesta linha" />
                  <Metric
                    label="Com ctwa_clid"
                    value={diag.withClid}
                    tone={diag.withClid > 0 ? 'good' : 'bad'}
                    hint="dá pra devolver conversão pro Meta"
                  />
                  <Metric
                    label="Anúncio sem clid"
                    value={diag.adNoClid}
                    tone={diag.adNoClid > 0 ? 'warn' : undefined}
                    hint="veio de anúncio, mas o elo não chegou"
                  />
                  <Metric label="Sem sinal de anúncio" value={diag.plain} hint="orgânico, agenda ou prospecção" />
                </div>

                {diag.total === 0 && (
                  <Banner tone="warn">
                    Nenhum lead nesta linha ainda. Assim que a primeira conversa entrar pelo webhook, estes números
                    passam a responder sozinhos se a atribuição está chegando.
                  </Banner>
                )}

                {diag.total > 0 && diag.withClid === 0 && diag.adNoClid > 0 && (
                  <Banner tone="bad">
                    <strong>É o cenário clássico.</strong> {diag.adNoClid} lead(s) trouxeram o bloco do anúncio (título,
                    link <C>fb.me</C>, id do criativo), mas nenhum trouxe o <C>ctwa_clid</C>. Dá pra saber de qual
                    anúncio a pessoa veio, e não dá pra devolver a conversão. O porquê está logo abaixo.
                  </Banner>
                )}

                {diag.total > 0 && diag.withClid === 0 && diag.adNoClid === 0 && (
                  <Banner tone="bad">
                    Nenhum lead trouxe qualquer sinal de anúncio — nem o <C>ctwa_clid</C>, nem o id do criativo. Ou
                    ninguém entrou por anúncio Click to WhatsApp ainda, ou o canal está descartando o bloco inteiro
                    antes de chegar aqui.
                  </Banner>
                )}

                {diag.withClid > 0 && (
                  <Banner tone="good">
                    {diag.withClid} lead(s) já carregam <C>ctwa_clid</C>: esses são atribuíveis. Se a conversão deles
                    ainda não aparece na campanha, o problema não é mais a captura — é o destino do evento (dataset e
                    token, no checklist mais abaixo).
                  </Banner>
                )}
              </>
            )}

            <div className="rounded-lg border border-ink-800 bg-ink-850 p-3.5">
              <p className="text-[11px] uppercase tracking-wide text-ink-500">Canal da linha selecionada</p>
              <p className="mt-1 text-sm text-ink-100">
                {current ? (
                  <>
                    {current.label} —{' '}
                    <Badge tone={isEvolution ? 'warn' : 'good'}>{isEvolution ? 'Evolution API' : 'Cloud API'}</Badge>
                  </>
                ) : (
                  'visão consolidada (todas as linhas)'
                )}
              </p>
            </div>
          </div>
        </Section>

        {/* ---- o elo ---- */}
        <Section
          id="elo"
          title="O elo que falta"
          subtitle="A atribuição é uma corrente de cinco elos. Basta um romper e a campanha não aprende nada."
        >
          <ul className="mt-1">
            <Link
              n={1}
              state="ok"
              title="A pessoa clica no anúncio Click to WhatsApp"
              detail="A Meta gera ali um ctwa_clid único daquele clique e abre a conversa no WhatsApp. Esse elo nunca é o problema."
            />
            <Link
              n={2}
              state="ok"
              title="A Meta anexa o clid à primeira mensagem"
              detail="Vai dentro do objeto referral, junto com source_id (o id do anúncio), source_url, headline e body. Só na PRIMEIRA mensagem daquele número — a segunda já não traz."
            />
            <Link
              n={3}
              state={diag.withClid > 0 ? 'ok' : 'broken'}
              title="O canal entrega esse bloco para o seu servidor"
              detail={
                diag.withClid > 0
                  ? 'Aqui já chegou clid pelo menos uma vez — esse elo está de pé nesta instalação.'
                  : 'É AQUI que sua corrente arrebenta hoje. A Evolution não entrega o ctwa_clid — as três razões estão na seção seguinte.'
              }
            />
            <Link
              n={4}
              state="ok"
              title="A plataforma grava o clid no lead e espera a conversão"
              detail="Esta parte já está pronta e funcionando: o webhook varre o payload inteiro atrás do bloco do anúncio, grava no contato e nunca sobrescreve. Quando a regra de palavra-chave bate, o evento é montado."
            />
            <Link
              n={5}
              state={hasCloud('meta_dataset_id') && hasCloud('meta_capi_token') ? 'depends' : 'broken'}
              title="O evento volta para a Meta com o clid dentro"
              detail="action_source: business_messaging + messaging_channel: whatsapp + user_data.ctwa_clid + user_data.whatsapp_business_account_id, num dataset criado a partir da WABA. O código já monta isso; falta o destino estar configurado."
            />
          </ul>
        </Section>

        {/* ---- por que a Evolution não fecha ---- */}
        <Section
          id="evolution"
          title="Por que a Evolution não fecha esse elo"
          subtitle="São três razões independentes. A terceira sozinha já basta."
        >
          <div className="space-y-5">
            <div className="rounded-lg border border-ink-800 bg-ink-850 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="bad">razão 1</Badge>
                <h3 className="text-xs font-semibold text-ink-100">
                  Número pareado por QR não roda no protocolo que carrega o clid
                </h3>
              </div>
              <div className="mt-2 space-y-2.5">
                <P>
                  Quando você conecta a instância lendo o QR Code, a Evolution está falando o protocolo do{' '}
                  <strong className="text-ink-100">WhatsApp Web</strong> — o mesmo de um celular pareado. Nesse
                  protocolo a mensagem vem com <C>contextInfo.externalAdReply</C>: título, corpo, miniatura,{' '}
                  <C>sourceId</C> e <C>sourceUrl</C>. É o bloco que o WhatsApp usa para <em>desenhar</em> o cartãozinho
                  do anúncio na tela do atendente.
                </P>
                <P>
                  Só que esse bloco existe para renderizar, não para medir. O <C>ctwaClid</C> — quando aparece — vem
                  vazio ou intermitente, porque o canal de atribuição da Meta nunca foi o WhatsApp Web: é a plataforma
                  oficial. Por isso o seu painel mostra "veio do anúncio X" e ainda assim não consegue devolver a
                  conversão.
                </P>
              </div>
            </div>

            <div className="rounded-lg border border-ink-800 bg-ink-850 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="bad">razão 2</Badge>
                <h3 className="text-xs font-semibold text-ink-100">
                  Mesmo por cima da Cloud API, a Evolution derruba o <C>referral</C>
                </h3>
              </div>
              <div className="mt-2 space-y-2.5">
                <P>
                  A Evolution também sabe conectar numa Cloud API oficial. Nesse modo a Meta <em>manda</em> o{' '}
                  <C>referral</C> completo, com <C>ctwa_clid</C> — e a Evolution descarta antes de repassar: o que sai
                  no <C>messages.upsert</C> vem com <C>contextInfo: undefined</C>, sem nenhum campo de atribuição.
                </P>
                <P>
                  Isso é bug conhecido e ainda <strong className="text-ink-100">aberto</strong>: issue #2645 do
                  repositório da Evolution, registrada em 15/07/2026, reproduzida na v2.3.7. Ou seja: hoje não existe
                  configuração sua que resolva — depende de merge no projeto deles.
                </P>
                <a
                  href="https://github.com/evolution-foundation/evolution-api/issues/2645"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block text-xs text-wa-500 underline underline-offset-2 hover:text-wa-600"
                >
                  ver a issue no GitHub →
                </a>
              </div>
            </div>

            <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="bad">razão 3 — a decisiva</Badge>
                <h3 className="text-xs font-semibold text-ink-100">Não existe endereço para o evento chegar</h3>
              </div>
              <div className="mt-2 space-y-2.5">
                <P>
                  Suponha que as duas razões acima fossem resolvidas amanhã e você tivesse o <C>ctwa_clid</C> na mão.
                  Ainda não funcionaria, e aqui está o porquê: a Meta não aceita evento de Click to WhatsApp em qualquer
                  pixel. Ele tem que ir para um <strong className="text-ink-100">dataset criado a partir da WABA</strong>{' '}
                  (<C>POST /&#123;WABA_ID&#125;/dataset</C>), com um token que carregue a permissão{' '}
                  <C>whatsapp_business_manage_events</C>, e o próprio evento precisa declarar{' '}
                  <C>user_data.whatsapp_business_account_id</C>.
                </P>
                <P>
                  Um número pareado por QR <strong className="text-ink-100">não pertence a WABA nenhuma</strong>. Ele
                  não está na WhatsApp Business Platform. Não há WABA ID para declarar, não há dataset para receber, não
                  há permissão para pedir. Não é limitação da Evolution nem deste sistema: é o desenho da atribuição da
                  Meta.
                </P>
                <Banner tone="warn">
                  É por isso que o caminho não é "consertar a Evolution". É migrar o número que recebe os anúncios para
                  a Cloud API — a Evolution continua ótima para o resto (CRM, prospecção, abordagem ativa), só não para
                  fechar o ciclo com a campanha.
                </Banner>
              </div>
            </div>
          </div>
        </Section>

        {/* ---- o que dá pra fazer hoje ---- */}
        <Section
          id="hoje"
          title="O que dá pra fazer hoje, sem migrar nada"
          subtitle="Não é atribuição de campanha, mas já é relatório por anúncio."
        >
          <div className="space-y-4">
            <P>
              Quando o bloco do anúncio chega (mesmo sem o clid), ele traz o <C>sourceId</C> — que é o{' '}
              <strong className="text-ink-100">ID do anúncio</strong> no Gerenciador — e o <C>sourceUrl</C>, o link{' '}
              <C>fb.me</C>. Esta plataforma já grava os dois: aparecem como <C>ad_id</C> e <C>source_url</C> no detalhe
              do lead, na aba <strong className="text-ink-100">Leads</strong>.
            </P>
            <Table
              head={['Com isso você consegue', 'Com isso você NÃO consegue']}
              rows={[
                [
                  'Saber de qual anúncio cada conversa veio, cruzando o ad_id com o Gerenciador de Anúncios',
                  'Fazer o Meta otimizar a entrega pelas pessoas que viraram cliente',
                ],
                [
                  'Montar seu próprio relatório de custo por lead real por criativo',
                  'Ver a conversão dentro do relatório da campanha, ao lado do custo',
                ],
                [
                  'Decidir qual criativo pausar ou escalar, na mão',
                  'Usar lances por valor (ROAS) ou públicos semelhantes de compradores',
                ],
              ]}
            />
            <Banner tone="warn">
              A diferença prática é essa: o relatório manual informa <em>você</em>; a conversão via API informa{' '}
              <em>o algoritmo</em>. O ganho grande de CTWA vem do segundo.
            </Banner>
          </div>
        </Section>

        {/* ---- o caminho oficial ---- */}
        <Section
          id="oficial"
          title="O caminho oficial, passo a passo"
          subtitle="WhatsApp Cloud API + Conversions API for Business Messaging. É o que a Meta suporta."
        >
          <ol className="space-y-7">
            <Step n={1} title="Escolha (ou separe) o número que vai receber os anúncios">
              <P>
                O número precisa entrar na WhatsApp Business Platform. Ele <strong className="text-ink-100">não pode
                estar pareado por QR ao mesmo tempo</strong>: migrar para a Cloud API desconecta o app do WhatsApp
                Business naquele aparelho.
              </P>
              <Banner tone="warn">
                Se a operação de atendimento hoje depende do celular na mão do time, o caminho mais tranquilo é usar um
                número novo só para os anúncios, e manter os antigos na Evolution. Esta plataforma é multi-linha: os
                dois canais convivem no mesmo painel.
              </Banner>
            </Step>

            <Step n={2} title="Crie o app no Meta for Developers e adicione o produto WhatsApp">
              <P>
                Em <C>developers.facebook.com</C> → Meus apps → Criar app → tipo <strong className="text-ink-100">
                Empresa</strong>, vinculado ao seu Business Manager. Depois, no app, adicione o produto{' '}
                <strong className="text-ink-100">WhatsApp</strong> e conclua o cadastro do número (Embedded Signup ou o
                fluxo manual). No fim disso você tem três coisas: <C>WABA ID</C>, <C>Phone Number ID</C> e um token.
              </P>
            </Step>

            <Step n={3} title="Peça Acesso Avançado às permissões de eventos">
              <P>
                No painel do app → <strong className="text-ink-100">Permissões e recursos</strong>, você precisa de
                Acesso Avançado em:
              </P>
              <Table
                head={['Permissão / recurso', 'Para quê']}
                rows={[
                  [<C key="a">whatsapp_business_management</C>, 'gerenciar a WABA, criar e ler o dataset'],
                  [<C key="b">whatsapp_business_manage_events</C>, 'enviar os eventos de conversão'],
                  ['Nível de acesso à API de Marketing', 'liberar o app na API de Marketing'],
                ]}
              />
              <Banner tone="warn">
                Duas pegadinhas aqui. (a) Se o app já tem Acesso Avançado em <C>whatsapp_business_messaging</C>, a
                aprovação de <C>whatsapp_business_manage_events</C> costuma sair automática depois do pedido. (b) O
                recurso da API de Marketing exige histórico: 1.500 chamadas bem-sucedidas, com menos de 10% de erro, nos
                últimos 15 dias. Peça isso cedo — é o passo que mais atrasa o projeto.
              </Banner>
            </Step>

            <Step n={4} title="Gere um token de sistema que não expire">
              <P>
                Business Manager → Configurações → <strong className="text-ink-100">Usuários do sistema</strong> → crie
                um usuário admin, dê a ele acesso ao app e à WABA, e gere o token marcando as duas permissões do passo
                anterior. Token de usuário comum expira; token de usuário do sistema não — e é esse que a plataforma vai
                guardar.
              </P>
            </Step>

            <Step n={5} title="Crie o dataset de conversões DA WABA">
              <P>
                Este é o passo que quase todo mundo erra: o campo "Dataset / Pixel ID" desta plataforma{' '}
                <strong className="text-ink-100">não é o pixel do seu site</strong>. Tem que ser o dataset da conta do
                WhatsApp Business. Ele se cria por API, e a chamada é idempotente — se já existir, ela devolve o mesmo
                id.
              </P>
              <Pre code={datasetCurl} />
              <P>
                Guarde o <C>id</C> que voltou. Um <C>GET</C> na mesma URL recupera o dataset depois, se você perder o
                número.
              </P>
            </Step>

            <Step n={6} title="Cadastre a linha oficial aqui no painel">
              <P>
                Vá em <strong className="text-ink-100">Admin → Cloud API</strong> e crie a linha com: rótulo,{' '}
                <C>Phone Number ID</C>, <C>WABA ID</C>, o token do passo 4, um <C>Verify Token</C> (qualquer string
                sua) e o <C>App Secret</C> do app. Depois use o botão de assinar webhook — ele registra esta URL na
                Meta e inscreve o campo <C>messages</C>.
              </P>
              <Banner tone="warn">
                O webhook só é aceito em HTTPS público. O endereço que a plataforma vai registrar é{' '}
                <C>{webhookUrl || 'defina PUBLIC_BASE_URL'}</C>
                {publicOk ? '.' : ' — corrija PUBLIC_BASE_URL no .env antes de tentar assinar.'}
              </Banner>
            </Step>

            <Step n={7} title="Aponte o destino do evento">
              <P>
                Na aba <strong className="text-ink-100">Rastreamento</strong>, com a linha da Cloud API selecionada no
                topo: cole o <C>dataset_id</C> do passo 5 no campo Dataset/Pixel, o token no campo da Conversions API, e
                ligue o destino Meta. Cadastre também a regra de palavra-chave que define o momento da conversão — é ela
                que dispara o evento.
              </P>
            </Step>

            <Step n={8} title="Rode o anúncio apontando para essa linha">
              <P>
                No Gerenciador de Anúncios, crie a campanha de mensagens com destino WhatsApp e escolha{' '}
                <strong className="text-ink-100">o número que você acabou de cadastrar</strong>. Anúncio apontado para
                outro número entrega conversa, mas entrega num canal que não tem dataset — e volta ao problema de
                origem.
              </P>
            </Step>

            <Step n={9} title="Teste antes de confiar">
              <P>
                Assim que a primeira conversa entrar, o lead aparece na aba Leads com o <C>ctwa_clid</C> preenchido — e
                o diagnóstico no topo desta página passa a contar. Para validar o outro lado sem esperar um cliente
                real, mande um evento de teste direto e acompanhe em Events Manager → Test Events:
              </P>
              <Pre code={testCurl} note="use um ctwa_clid real; a Meta rejeita clid inventado" />
              <Banner tone="warn">
                O <C>ctwa_clid</C> só vem na <strong>primeira</strong> mensagem de cada número. Para repetir o teste,
                use um celular que nunca falou com essa linha antes — o mesmo número não gera clid de novo.
              </Banner>
            </Step>
          </ol>
        </Section>

        {/* ---- checklist ---- */}
        <Section
          id="checklist"
          title="Checklist ao vivo"
          subtitle="O que já está configurado nesta instalação para o caminho oficial."
        >
          {!cfg ? (
            <p className="text-sm text-ink-500">carregando…</p>
          ) : (
            <div className="space-y-3">
              <Group title="1. A linha na Cloud API" items={linha} />
              <Group title="2. O destino do evento" items={destino} />
              <Banner tone="warn">
                Este checklist olha a linha padrão da <strong>Cloud API</strong> (Admin → Cloud API), não a instância da
                Evolution selecionada no topo da tela. São canais diferentes, com credenciais diferentes.
              </Banner>
            </div>
          )}
        </Section>

        {/* ---- comparativo ---- */}
        <Section id="comparativo" title="Evolution × Cloud API, lado a lado" subtitle="Nenhum dos dois é melhor em tudo.">
          <Table
            head={['', 'Evolution API (QR)', 'Cloud API (oficial)']}
            rows={[
              ['Conectar', 'ler um QR Code, minutos', 'app, WABA, verificação de negócio — dias ou semanas'],
              ['Custo por mensagem', 'zero', 'cobrado por conversa, tabela da Meta'],
              ['Mensagem fria', 'texto livre, sem template', 'só template aprovado fora da janela de 24h'],
              ['Risco de banimento', 'existe — é uso não oficial', 'nenhum, é o canal suportado'],
              ['Recebe ctwa_clid', 'não', 'sim, no objeto referral'],
              ['Devolve conversão para a campanha', 'não', 'sim, via Conversions API'],
              ['Otimização por conversão / ROAS', 'não', 'sim'],
              ['Serve para', 'atendimento, CRM, prospecção ativa', 'anúncios Click to WhatsApp com medição'],
            ]}
          />
          <div className="mt-4">
            <Banner tone="good">
              A recomendação prática: mantenha a Evolution onde ela é boa e coloque a Cloud API só na linha que recebe
              anúncio. Esta plataforma já roda os dois canais em paralelo — o seletor no topo troca de um para o outro.
            </Banner>
          </div>
        </Section>

        {/* ---- erros ---- */}
        <Section id="erros" title="Erros comuns" subtitle="O que costuma acontecer depois que tudo parece configurado.">
          <Table
            head={['Sintoma', 'Causa provável', 'O que fazer']}
            rows={[
              [
                'Lead tem ad_id mas não tem ctwa_clid',
                'o canal é a Evolution — o bloco do anúncio chega, o clid não',
                'migrar a linha de anúncios para a Cloud API (passo a passo acima)',
              ],
              [
                'Disparo recusado: "Contato sem ctwa_clid"',
                'trava proposital: evento sem clid não atribui nada e só sujaria o dataset',
                'usar um lead vindo de anúncio, ou o simulador da aba Leads',
              ],
              [
                'A Meta responde 200, mas nada aparece na campanha',
                'o evento foi para um pixel de site, não para o dataset da WABA',
                'refazer o passo 5 e trocar o Dataset ID em Rastreamento',
              ],
              [
                'Erro de permissão no POST de eventos',
                'token sem whatsapp_business_manage_events, ou sem Acesso Avançado',
                'regerar o token do usuário do sistema com as duas permissões',
              ],
              [
                'Só o primeiro lead do dia tem atribuição',
                'normal: o clid só vem na primeira mensagem de cada número',
                'nada a corrigir — teste sempre com um número novo',
              ],
              [
                'Conversão atribuída ao anúncio errado',
                'o anúncio aponta para um número diferente do cadastrado na linha',
                'conferir o destino da campanha no Gerenciador',
              ],
            ]}
          />
        </Section>

        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-800 bg-ink-900 px-4 py-3">
          <span className="text-[11px] text-ink-500">Referências oficiais:</span>
          <a
            href="https://developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-wa-500 underline underline-offset-2 hover:text-wa-600"
          >
            Conversions API for Business Messaging
          </a>
          <a
            href="https://github.com/evolution-foundation/evolution-api/issues/2645"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-wa-500 underline underline-offset-2 hover:text-wa-600"
          >
            Evolution API · issue #2645
          </a>
          <Button size="sm" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            voltar ao topo
          </Button>
        </div>
      </div>
    </div>
  )
}
