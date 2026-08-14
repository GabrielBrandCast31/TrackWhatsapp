import { useEffect, useState } from 'react'

import { api, prospectApi, type ApifyAccount, type GeoResult, type ProspectSearch } from '../api'
import { Badge, Banner, Button, Card, Empty, Field, Input, Json, Select, Toggle, when } from '../ui'

const RADIUS_PRESETS = [1, 2, 5, 10, 20, 40]

const STAR_OPTIONS = [
  { value: '', label: 'Qualquer nota' },
  { value: 'three', label: '3+ estrelas' },
  { value: 'threeAndHalf', label: '3,5+ estrelas' },
  { value: 'four', label: '4+ estrelas' },
  { value: 'fourAndHalf', label: '4,5+ estrelas' },
]

const WEBSITE_OPTIONS = [
  { value: 'allPlaces', label: 'Com ou sem site' },
  { value: 'withoutWebsite', label: 'Só quem NÃO tem site' },
  { value: 'withWebsite', label: 'Só quem tem site' },
]

function StatusBadge({ s }: { s: ProspectSearch }) {
  if (s.status === 'running' || s.status === 'queued') return <Badge tone="info">varrendo…</Badge>
  if (s.status === 'failed') return <Badge tone="bad">falhou</Badge>
  if (!s.imported) return <Badge tone="warn">importando</Badge>
  return <Badge tone="good">pronta</Badge>
}

function ApifyConfig({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [account, setAccount] = useState<ApifyAccount | null>(null)
  const [token, setToken] = useState('')
  const [actor, setActor] = useState('compass/crawler-google-places')
  const [language, setLanguage] = useState('pt-BR')
  const [tokenSet, setTokenSet] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = async () => {
    setAccount(await prospectApi.account().catch(() => null))
    const { config } = await api.getConfig()
    setActor(String(config.apify_actor ?? 'compass/crawler-google-places'))
    setLanguage(String(config.prospect_language ?? 'pt-BR'))
    setTokenSet(Boolean(config.apify_token__set))
  }

  useEffect(() => {
    void load()
  }, [])

  const save = async () => {
    setErr(null)
    try {
      await api.putConfig({ apify_token: token, apify_actor: actor, prospect_language: language })
      setToken('')
      setMsg('Configuração salva.')
      setTimeout(() => setMsg(null), 2500)
      await load()
      onSaved()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <Card
      title="Conta Apify"
      subtitle={
        account?.ok
          ? `${account.username} · plano ${account.plan} · US$ ${account.monthly_credits_usd}/mês de crédito`
          : (account?.error ?? 'verificando…')
      }
      actions={
        <>
          {account?.ok ? <Badge tone="good">conectado</Badge> : <Badge tone="bad">sem conexão</Badge>}
          <Button size="sm" onClick={() => setOpen(!open)}>
            {open ? 'fechar' : 'configurar'}
          </Button>
        </>
      }
    >
      {open ? (
        <div className="space-y-3">
          <Field
            label="Token do Apify"
            hint={
              tokenSet
                ? 'Já existe um token salvo. Deixe vazio para manter o atual.'
                : 'Console do Apify → Settings → Integrations → API token.'
            }
          >
            <Input
              type="password"
              placeholder={tokenSet ? '•••••••• (mantido)' : 'apify_api_...'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Actor" hint="O padrão faz busca por raio no Google Maps.">
              <Input value={actor} onChange={(e) => setActor(e.target.value)} />
            </Field>
            <Field label="Idioma dos resultados">
              <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="pt-BR">Português (Brasil)</option>
                <option value="es">Espanhol</option>
                <option value="en">Inglês</option>
              </Select>
            </Field>
          </div>
          {err && <Banner tone="bad">{err}</Banner>}
          {msg && <Banner tone="good">{msg}</Banner>}
          <Button variant="primary" size="sm" onClick={() => void save()}>
            Salvar
          </Button>
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-ink-500">
          A varredura roda no Apify e é cobrada por lugar encontrado. A busca de teste que validou esse
          fluxo custou <span className="font-mono text-ink-300">US$ 0,04</span> para 8 lugares — dá algumas
          centenas de prospects dentro do crédito gratuito. Use o campo{' '}
          <span className="font-mono text-ink-300">Quantidade por termo</span> como trava de gasto.
        </p>
      )}
    </Card>
  )
}

function NewSearch({ onCreated }: { onCreated: () => void }) {
  const [address, setAddress] = useState('')
  const [candidates, setCandidates] = useState<GeoResult[]>([])
  const [center, setCenter] = useState<GeoResult | null>(null)
  const [terms, setTerms] = useState('')
  const [radius, setRadius] = useState(5)
  const [maxPerTerm, setMaxPerTerm] = useState(60)
  const [skipClosed, setSkipClosed] = useState(true)
  const [minStars, setMinStars] = useState('')
  const [website, setWebsite] = useState('allPlaces')
  const [scrapeContacts, setScrapeContacts] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const termList = terms
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean)

  const locate = async () => {
    setErr(null)
    setBusy(true)
    try {
      const { results } = await prospectApi.geocode(address)
      setCandidates(results)
      setCenter(results[0] ?? null)
      if (results.length === 0) setErr('Nenhum lugar encontrado para esse endereço.')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const start = async () => {
    if (!center || termList.length === 0) return
    setErr(null)
    setBusy(true)
    try {
      await prospectApi.createSearch({
        terms: termList,
        lat: center.lat,
        lng: center.lng,
        radius_km: radius,
        location_label: address || center.label,
        max_per_term: maxPerTerm,
        skip_closed: skipClosed,
        min_stars: minStars,
        website,
        scrape_contacts: scrapeContacts,
      })
      setTerms('')
      onCreated()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Nova varredura"
      subtitle="Um ponto no mapa, um raio e o que você procura. O resto vira prospect no CRM."
    >
      <div className="space-y-4">
        <div>
          <Field label="Centro do raio" hint="Endereço, bairro ou cidade. O geocoder é o OpenStreetMap.">
            <div className="flex gap-2">
              <Input
                placeholder="Av. Paulista 1000, São Paulo"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void locate()
                }}
              />
              <Button onClick={() => void locate()} disabled={busy || address.trim().length < 3}>
                localizar
              </Button>
            </div>
          </Field>

          {candidates.length > 0 && (
            <ul className="mt-2 space-y-1">
              {candidates.map((c) => (
                <li key={`${c.lat},${c.lng}`}>
                  <button
                    onClick={() => setCenter(c)}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                      center?.lat === c.lat && center?.lng === c.lng
                        ? 'border-wa-500 bg-wa-900/40 text-ink-100'
                        : 'border-ink-800 bg-ink-850 text-ink-300 hover:border-ink-500'
                    }`}
                  >
                    <span className="block truncate">{c.label}</span>
                    <span className="mt-0.5 block font-mono text-[11px] text-ink-500">
                      {c.lat.toFixed(5)}, {c.lng.toFixed(5)}
                      {c.kind ? ` · ${c.kind}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Field
          label="O que procurar"
          hint="Um termo por linha ou separados por vírgula. Termos distintos custam uma varredura cada."
        >
          <Input
            placeholder="clínica odontológica, pet shop, academia"
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
          />
        </Field>

        <div>
          <span className="mb-2 block text-xs font-medium text-ink-300">Raio: {radius} km</span>
          <div className="flex flex-wrap gap-2">
            {RADIUS_PRESETS.map((r) => (
              <button
                key={r}
                onClick={() => setRadius(r)}
                className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                  radius === r
                    ? 'border-wa-500 bg-wa-900/50 text-wa-500'
                    : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-500'
                }`}
              >
                {r} km
              </button>
            ))}
          </div>
          <input
            type="range"
            min={1}
            max={50}
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
            className="mt-3 w-full accent-wa-500"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Quantidade por termo" hint="Trava de gasto.">
            <Input
              type="number"
              min={1}
              max={500}
              value={maxPerTerm}
              onChange={(e) => setMaxPerTerm(Number(e.target.value))}
            />
          </Field>
          <Field label="Nota mínima">
            <Select value={minStars} onChange={(e) => setMinStars(e.target.value)}>
              {STAR_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Site" hint="Sem site costuma ser lead mais quente pra agência.">
            <Select value={website} onChange={(e) => setWebsite(e.target.value)}>
              {WEBSITE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap gap-5">
          <Toggle checked={skipClosed} onChange={setSkipClosed} label="Ignorar lugares fechados" />
          <Toggle
            checked={scrapeContacts}
            onChange={setScrapeContacts}
            label="Buscar e-mail no site (custa mais por lugar)"
          />
        </div>

        {center && (
          <p className="text-xs leading-relaxed text-ink-500">
            Vai varrer{' '}
            <span className="text-ink-300">
              {termList.length || 0} termo(s) × até {maxPerTerm} lugares
            </span>{' '}
            num raio de {radius} km em torno de{' '}
            <span className="font-mono text-ink-300">
              {center.lat.toFixed(4)}, {center.lng.toFixed(4)}
            </span>
            .
          </p>
        )}

        {err && <Banner tone="bad">{err}</Banner>}

        <Button variant="primary" disabled={busy || !center || termList.length === 0} onClick={() => void start()}>
          {busy ? 'iniciando…' : 'Iniciar varredura'}
        </Button>
        {!center && <p className="text-xs text-ink-500">Localize um endereço primeiro para fixar o centro.</p>}
      </div>
    </Card>
  )
}

export default function Prospecting({ onChanged }: { onChanged: () => void }) {
  const [searches, setSearches] = useState<ProspectSearch[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)

  const load = async () => {
    const rows = await prospectApi.searches().catch(() => [])
    setSearches(rows)
    onChanged()
    return rows
  }

  useEffect(() => {
    void load()
  }, [])

  // enquanto alguma varredura estiver rodando, o backend sincroniza sozinho a
  // cada listagem — basta a tela reconsultar.
  const anyRunning = searches.some((s) => s.status === 'running' || s.status === 'queued')
  useEffect(() => {
    if (!anyRunning) return
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [anyRunning])

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <ApifyConfig onSaved={() => void load()} />
        <NewSearch onCreated={() => void load()} />
      </div>

      <Card
        title="Varreduras"
        subtitle={`${searches.length} no histórico. O resultado entra no CRM sem duplicar quem já estava lá.`}
        actions={
          <Button size="sm" onClick={() => void load()}>
            atualizar
          </Button>
        }
      >
        {searches.length === 0 ? (
          <Empty>Nenhuma varredura ainda. Crie a primeira ao lado.</Empty>
        ) : (
          <ul className="divide-y divide-ink-800">
            {searches.map((s) => (
              <li key={s.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-100">{s.label}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-ink-500">
                      {when(s.created_at)}
                      {s.cost_usd != null && ` · US$ ${s.cost_usd.toFixed(4)}`}
                    </p>
                  </div>
                  <StatusBadge s={s} />
                </div>

                {s.imported && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone="good">{s.prospects_new} novos</Badge>
                    {s.prospects_dupe > 0 && <Badge>{s.prospects_dupe} já tinha</Badge>}
                    {s.prospects_skipped > 0 && (
                      <Badge tone="warn">{s.prospects_skipped} fora do raio/fechado</Badge>
                    )}
                    <Badge>{s.items_found} do Google</Badge>
                  </div>
                )}

                {s.error && (
                  <div className="mt-2">
                    <Banner tone="bad">{s.error}</Banner>
                  </div>
                )}

                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                    {expanded === s.id ? 'ocultar input' : 'ver input'}
                  </Button>
                  <Button
                    size="sm"
                    onClick={async () => {
                      await prospectApi.syncSearch(s.id)
                      await load()
                    }}
                  >
                    sincronizar
                  </Button>
                  {(s.status === 'running' || s.status === 'queued') && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={async () => {
                        await prospectApi.abortSearch(s.id)
                        await load()
                      }}
                    >
                      abortar
                    </Button>
                  )}
                  {s.run_url && (
                    <a
                      href={s.run_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 text-xs text-ink-300 hover:border-ink-500"
                    >
                      run no Apify
                    </a>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      await prospectApi.deleteSearch(s.id)
                      await load()
                    }}
                  >
                    apagar
                  </Button>
                </div>

                {expanded === s.id && (
                  <div className="mt-2">
                    <Json value={s.apify_input} max={240} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
