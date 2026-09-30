const BASE = import.meta.env.VITE_API_URL ?? ''

export class ApiError extends Error {}

/** 401: o JWT caiu (expirou, senha mudou, conta desativada). A tela volta pro login. */
export class UnauthorizedError extends ApiError {}

/** 403: logado, mas sem perfil de admin pra essa rota. */
export class ForbiddenError extends ApiError {}

const ACCESS_KEY = 'wa.accessToken'
const REFRESH_KEY = 'wa.refreshToken'

export type AuthUser = {
  id: number
  username: string
  name: string | null
  role: 'admin' | 'user'
  active: boolean
  created_at: string
  last_login_at: string | null
  /** linhas (clientes) que o usuário de operação enxerga; admin vê todas */
  number_ids?: number[]
}

export type TokenPair = {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  user: AuthUser
}

/** Sessao no localStorage: fechar a aba nao desloga, mas o token expira sozinho. */
export const session = {
  access: (): string | null => read(ACCESS_KEY),
  refresh: (): string | null => read(REFRESH_KEY),
  save(pair: Pick<TokenPair, 'access_token' | 'refresh_token'>) {
    write(ACCESS_KEY, pair.access_token)
    write(REFRESH_KEY, pair.refresh_token)
  },
  clear() {
    write(ACCESS_KEY, null)
    write(REFRESH_KEY, null)
  },
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // navegador sem storage: a sessao vive so nesta pagina
  }
}

/** Avisa a aplicacao que a sessao morreu, de qualquer lugar do codigo. */
let onLogout: (() => void) | null = null
export function setLogoutHandler(fn: (() => void) | null) {
  onLogout = fn
}

/** Renova o access com o refresh. Uma renovacao por vez: varias chamadas em
 *  paralelo pegando 401 juntas esperam a mesma promessa. */
let renewing: Promise<boolean> | null = null

async function renew(): Promise<boolean> {
  const refresh_token = session.refresh()
  if (!refresh_token) return false
  renewing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token }),
      })
      if (!res.ok) return false
      session.save((await res.json()) as TokenPair)
      return true
    } catch {
      return false
    } finally {
      renewing = null
    }
  })()
  return renewing
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  const token = session.access()
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    })
  } catch {
    // fetch só rejeita quando a requisição nem sai: backend fora do ar, DNS, CORS
    throw new ApiError(`Não consegui falar com a API (${path}). O backend está no ar?`)
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res = await send(path, init)

  // access expirado: troca pelo refresh e repete uma vez, sem o usuário ver.
  // /api/auth/* fica de fora — 401 ali é senha errada, não sessão vencida.
  if (res.status === 401 && !path.startsWith('/api/auth/') && (await renew())) {
    res = await send(path, init)
  }

  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok) {
    const detail =
      body && typeof body === 'object' && 'detail' in body
        ? String((body as { detail: unknown }).detail)
        : `HTTP ${res.status}`

    // "Not Found" cru é o 404 do FastAPI para rota inexistente — quase sempre
    // container servindo código antigo. Um 404 dos nossos handlers vem com texto
    // próprio ("Prospect nao encontrado") e passa direto.
    if (res.status === 401) {
      if (!path.startsWith('/api/auth/')) {
        session.clear()
        onLogout?.()
      }
      throw new UnauthorizedError(detail)
    }
    if (res.status === 403) throw new ForbiddenError(detail)

    if (res.status === 404 && detail === 'Not Found') {
      throw new ApiError(
        `A rota ${path} não existe nesse backend (404). Se você acabou de atualizar o código, ` +
          'rode `docker compose up --build -d` e recarregue com Cmd+Shift+R.',
      )
    }
    throw new ApiError(detail)
  }
  return body as T
}

/** Download de arquivo (CSV) numa rota autenticada: `<a href>` não manda o
 *  Bearer, então busca com token e entrega o blob pro navegador. */
export async function download(path: string, filename: string): Promise<void> {
  let res = await send(path)
  if (res.status === 401 && (await renew())) res = await send(path)
  if (!res.ok) {
    if (res.status === 401) {
      session.clear()
      onLogout?.()
    }
    throw new ApiError(`Não consegui baixar o arquivo (HTTP ${res.status}).`)
  }
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export type Attribution = {
  ctwa_clid: string | null
  ad_id: string | null
  source_type: string | null
  source_url: string | null
  ad_headline?: string | null
  ad_body?: string | null
  /** app onde o anúncio rodou: instagram | facebook */
  ad_source_app?: string | null
  gclid: string | null
  wbraid: string | null
  gbraid: string | null
  utm: Record<string, string>
}

export type Contact = {
  id: number
  wa_id: string
  wa_number_id: number | null
  phone_e164: string | null
  name: string | null
  first_message: string | null
  created_at: string
  last_seen_at: string
  conversions: number
  attribution: Attribution
  attributable_meta: boolean
  attributable_google: boolean
}

export type ContactDetail = Contact & {
  messages: CrmMessage[]
  conversion_events: Conversion[]
}

export type Dispatch = {
  id: number
  destination: 'meta_capi' | 'google_ads' | 'webhook'
  status: 'ok' | 'error' | 'skipped' | 'pending'
  http_status: number | null
  error: string | null
  request_payload: Record<string, unknown>
  response_body: Record<string, unknown>
  created_at: string
}

export type Conversion = {
  id: number
  contact_id: number
  event_name: string
  event_id: string
  value: number | null
  currency: string
  note: string | null
  is_test: boolean
  source?: 'manual' | 'rule' | 'auto'
  rule_id?: number | null
  created_at: string
  dispatches: Dispatch[]
  contact?: { id: number; wa_id: string; name: string | null }
}

export type ConnectionStatus = {
  number_id?: number
  configured: boolean
  connected: boolean
  phone_number: Record<string, string> | null
  subscribed_apps: { whatsapp_business_api_data?: { name?: string } }[]
  errors: string[]
}

export type ConfigResponse = {
  config: Record<string, unknown>
  webhook_url: string
  enabled_destinations: string[]
  default_number_id: number | null
  overridable_fields: string[]
}

// --- linhas de WhatsApp ---

export type WaNumber = {
  id: number
  label: string
  channel?: string
  phone_number_id: string
  business_account_id: string | null
  verify_token: string | null
  graph_version: string | null
  display_phone_number: string | null
  verified_name: string | null
  quality_rating: string | null
  last_checked_at: string | null
  last_error: string | null
  active: boolean
  is_default: boolean
  note: string | null
  created_at: string
  overrides: Record<string, unknown>
  access_token__set: boolean
  access_token__hint: string
  app_secret__set: boolean
  app_secret__hint: string
  webhook_url: string
  enabled_destinations?: string[]
  outreach_enabled?: boolean
  counts?: { contacts: number; prospects: number; outreach_sent: number; conversions: number }
}

export type Orphans = { contacts: number; prospects: number; searches: number; total: number }

export type Stats = {
  journeys?: number
  whatsapp_clicks?: number
  journey_leads?: number
  numbers: number
  contacts: number
  attributed_contacts: number
  conversions: number
  dispatches: Record<string, number>
  prospects: number
  outreach_sent: number
  prospects_replied: number
  rules?: number
  rule_conversions?: number
}

// --- CRM de prospecção ---

export const STAGES = ['novo', 'contatado', 'respondeu', 'qualificado', 'ganho', 'perdido'] as const
export type Stage = (typeof STAGES)[number]

export const STAGE_LABEL: Record<Stage, string> = {
  novo: 'Novo',
  contatado: 'Contatado',
  respondeu: 'Respondeu',
  qualificado: 'Qualificado',
  ganho: 'Ganho',
  perdido: 'Perdido',
}

export type GeoResult = { label: string; lat: number; lng: number; kind: string | null }

export type ProspectSearch = {
  id: number
  label: string
  wa_number_id: number | null
  terms: string[]
  center: { lat: number; lng: number }
  radius_km: number
  location_label: string | null
  max_per_term: number
  actor: string
  apify_run_id: string | null
  dataset_id: string | null
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  imported: boolean
  error: string | null
  items_found: number
  prospects_new: number
  prospects_dupe: number
  prospects_skipped: number
  cost_usd: number | null
  apify_input: Record<string, unknown>
  created_at: string
  finished_at: string | null
  run_url: string | null
}

export type Outreach = {
  id: number
  prospect_id: number
  wa_number_id: number | null
  prospect_name?: string | null
  kind: 'template' | 'text'
  template_name: string | null
  template_language: string | null
  body_preview: string | null
  to_phone: string | null
  wamid: string | null
  status: 'queued' | 'sent' | 'failed' | 'skipped'
  http_status: number | null
  request_payload: Record<string, unknown>
  response_body: Record<string, unknown>
  error: string | null
  created_at: string
  sent_at: string | null
}

export type Prospect = {
  id: number
  search_id: number | null
  wa_number_id: number | null
  place_id: string | null
  name: string
  category: string | null
  address: string | null
  city: string | null
  state: string | null
  phone_e164: string | null
  phone_raw: string | null
  phone_kind: 'mobile' | 'landline' | 'unknown' | null
  website: string | null
  email: string | null
  rating: number | null
  reviews_count: number | null
  lat: number | null
  lng: number | null
  distance_km: number | null
  maps_url: string | null
  stage: Stage
  note: string | null
  contact_id: number | null
  last_outreach_at: string | null
  replied_at: string | null
  created_at: string
}

export type ProspectDetail = Prospect & {
  outreaches: Outreach[]
  raw: Record<string, unknown>
}

export type Pipeline = {
  stages: Record<Stage, number>
  total: number
  with_mobile: number
  outreach: { sent: number; queued: number; failed: number }
  sent_today: number
}

export type ApifyAccount = {
  configured: boolean
  ok: boolean
  username?: string
  email?: string
  plan?: string
  monthly_credits_usd?: number
  error?: string
}

export type WaTemplate = {
  name: string
  language: string
  status: string
  category: string
  body: string
  placeholders: number
  approved: boolean
}

export type ProspectFilters = {
  stage?: string
  search_id?: number
  number_id?: number
  q?: string
  only_mobile?: boolean
  only_with_phone?: boolean
}

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export const prospectApi = {
  account: () => request<ApifyAccount>('/api/prospect/account'),
  geocode: (q: string) => request<{ results: GeoResult[] }>(`/api/prospect/geocode?q=${encodeURIComponent(q)}`),
  searches: (numberId?: number) =>
    request<ProspectSearch[]>(`/api/prospect/searches${qs({ number_id: numberId })}`),
  createSearch: (payload: Record<string, unknown>) =>
    request<ProspectSearch>('/api/prospect/searches', { method: 'POST', body: JSON.stringify(payload) }),
  syncSearch: (id: number) =>
    request<ProspectSearch>(`/api/prospect/searches/${id}/sync`, { method: 'POST' }),
  abortSearch: (id: number) =>
    request<ProspectSearch>(`/api/prospect/searches/${id}/abort`, { method: 'POST' }),
  deleteSearch: (id: number) => request<void>(`/api/prospect/searches/${id}`, { method: 'DELETE' }),
  prospects: (filters: ProspectFilters = {}) =>
    request<Prospect[]>(`/api/prospect/prospects${qs(filters as Record<string, unknown>)}`),
  prospect: (id: number) => request<ProspectDetail>(`/api/prospect/prospects/${id}`),
  patchProspect: (id: number, patch: Record<string, unknown>) =>
    request<Prospect>(`/api/prospect/prospects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProspect: (id: number) => request<void>(`/api/prospect/prospects/${id}`, { method: 'DELETE' }),
  pipeline: (numberId?: number) => request<Pipeline>(`/api/prospect/pipeline${qs({ number_id: numberId })}`),
  templates: (numberId?: number) =>
    request<WaTemplate[]>(`/api/prospect/templates${qs({ number_id: numberId })}`),
  outreachOne: (id: number, payload: Record<string, unknown>) =>
    request<Outreach>(`/api/prospect/prospects/${id}/outreach`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  outreachBulk: (payload: Record<string, unknown>) =>
    request<{
      queued: number
      skipped: { id: number; name: string; reason: string }[]
      cap: Record<string, number | null>
    }>(
      '/api/prospect/outreach/bulk',
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  outreachLog: (status?: string, numberId?: number) =>
    request<Outreach[]>(`/api/prospect/outreach${qs({ status, number_id: numberId })}`),
  drain: (numberId?: number) =>
    request<{ pending: number }>(`/api/prospect/outreach/drain${qs({ number_id: numberId })}`, {
      method: 'POST',
    }),
  downloadCsv: (filters: ProspectFilters = {}) =>
    download(`/api/prospect/prospects.csv${qs(filters as Record<string, unknown>)}`, 'prospects.csv'),
}

export const numbersApi = {
  list: (channel?: 'cloud' | 'evolution') => request<WaNumber[]>(`/api/numbers${qs({ channel })}`),
  get: (id: number) => request<WaNumber>(`/api/numbers/${id}`),
  create: (payload: Record<string, unknown>) =>
    request<WaNumber>('/api/numbers', { method: 'POST', body: JSON.stringify(payload) }),
  patch: (id: number, patch: Record<string, unknown>) =>
    request<WaNumber>(`/api/numbers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: number, purge = false) =>
    request<void>(`/api/numbers/${id}${qs({ purge })}`, { method: 'DELETE' }),
  status: (id: number) => request<ConnectionStatus>(`/api/numbers/${id}/status`),
  subscribe: (id: number) => request<unknown>(`/api/numbers/${id}/subscribe`, { method: 'POST' }),
  sendTest: (id: number, to: string, body: string) =>
    request<unknown>(`/api/numbers/${id}/send-test`, {
      method: 'POST',
      body: JSON.stringify({ to, body }),
    }),
  templates: (id: number) => request<WaTemplate[]>(`/api/numbers/${id}/templates`),
  orphans: () => request<Orphans>('/api/numbers/orphans'),
  adoptOrphans: (id: number) =>
    request<{ number_id: number; adopted: Record<string, number> }>(
      `/api/numbers/${id}/adopt-orphans`,
      { method: 'POST' },
    ),
}

// --- CRM da linha: as conversas daquele número ---

/** O funil de atendimento: a ordem é a das etapas e das colunas do kanban. */
export const CRM_STAGES = ['novo', 'mql', 'conversando', 'agendado', 'compareceu', 'fechado', 'perdido'] as const
export type CrmStage = (typeof CRM_STAGES)[number]

export const CRM_STAGE_LABEL: Record<CrmStage, string> = {
  novo: 'Novo',
  mql: 'MQL',
  conversando: 'Conversando',
  agendado: 'Agendado',
  compareceu: 'Compareceu',
  fechado: 'Fechado',
  perdido: 'Perdido',
}

/** Nome longo de cada etapa, como aparece no funil. */
export const FUNNEL_LABEL: Record<CrmStage, string> = {
  novo: 'Leads',
  mql: 'Leads MQL',
  conversando: 'Continuaram a conversa',
  agendado: 'Agendamento confirmado',
  compareceu: 'Compareceu na clínica',
  fechado: 'Fechamento',
  perdido: 'Perdido',
}

export type CrmContact = {
  id: number
  wa_id: string
  /** identificador LID; igual ao wa_id quando o telefone da pessoa é desconhecido */
  wa_lid?: string | null
  wa_number_id: number | null
  phone_e164: string | null
  name: string | null
  profile_pic_url: string | null
  stage: CrmStage
  stage_source?: 'manual' | 'auto' | 'rule' | 'ai' | null
  /** quando o lead alcançou cada etapa do funil */
  milestones?: Partial<Record<Exclude<CrmStage, 'novo'>, string | null>>
  deal_value?: number | null
  note: string | null
  origin: 'webhook' | 'sync' | 'simulado' | string
  unread_count: number
  last_message_at: string | null
  last_message_body: string | null
  last_message_from_me: boolean
  first_message: string | null
  created_at: string
  last_seen_at: string
  synced_at: string | null
  conversions: number
  attribution: Attribution
  attributable_meta: boolean
  attributable_google: boolean
  /** de onde o lead veio: canal, campanha, objetivo e o evento que ele pede */
  source: LeadSource
  /** referência à jornada do site (TL_ID) e como a conversa foi ligada a ela */
  journey?: LeadJourneyRef
}

export type LeadChannel = 'meta_ads' | 'google_ads' | 'utm' | 'organic' | 'agenda' | 'simulado'

export type LeadSource = {
  /** chave estável para filtrar e agrupar (`meta:<campaign_id>`, `utm:<campanha>`, `organic`…) */
  key: string
  channel: LeadChannel
  channel_label: string
  platform: 'instagram' | 'facebook' | 'messenger' | null
  platform_label: string | null
  ad_id: string | null
  ad_name: string | null
  ad_headline: string | null
  adset_name: string | null
  campaign_id: string | null
  campaign_name: string | null
  /** de onde saiu o nome da campanha: Marketing API, preenchido à mão ou utm_campaign */
  campaign_from: 'meta' | 'manual' | 'utm' | null
  objective: string | null
  objective_label: string | null
  optimization_goal: string | null
  /** pending = anúncio ainda sem campanha consultada */
  campaign_status: 'resolved' | 'error' | 'manual' | 'pending' | null
  campaign_error: string | null
  suggested_event: string
  suggested_reason: string
  utm: Record<string, string>
}

/** Sentinela: o backend troca pelo evento que o objetivo da campanha pede. */
export const OBJECTIVE_EVENT = '__objective__'

export type CampaignGroup = {
  key: string
  channel: LeadChannel
  channel_label: string
  platform: LeadSource['platform']
  campaign_name: string | null
  campaign_id: string | null
  objective: string | null
  objective_label: string | null
  suggested_event: string
  ad_ids: string[]
  contacts: number
  won: number
  with_conversion: number
}

export type CampaignOverview = {
  has_ads_token: boolean
  groups: CampaignGroup[]
  objectives: { value: string; label: string; event: string | null; default_event: string | null }[]
}

export type CampaignResolveResult = {
  ads: number
  checked: number
  resolved: number
  errors: string[]
  has_token: boolean
}

export type CrmMessage = {
  id: number
  direction: string
  type: string | null
  body: string | null
  sent_at: string
  /** id da mensagem no WhatsApp */
  wamid?: string | null
  /** tem payload cru guardado — o botão "payload" da conversa busca sob demanda */
  has_payload?: boolean
}

/** O que chegou de verdade numa mensagem: o objeto cru e o POST inteiro do webhook.
 *  Vem só quando pedido (`crmApi.messagePayload`) porque anexo carrega miniatura
 *  em base64 e isso não pode viajar junto com a conversa toda. */
export type MessagePayload = {
  id: number
  contact_id: number
  wamid: string | null
  direction: string
  type: string | null
  body: string | null
  sent_at: string
  raw: Record<string, unknown>
  /** O que o sistema lê do anúncio nesse payload (null = nenhum bloco de anúncio). */
  ad?: {
    ctwa_clid: string | null
    source_id: string | null
    source_url: string | null
    headline: string | null
  } | null
  /** Bloco de anúncio em mensagem enviada pela própria linha: não conta. */
  ad_ignored_from_me?: boolean
  webhook: {
    id: number
    summary: string | null
    created_at: string
    instance: string | null
    wa_number_id: number | null
    payload: unknown
  } | null
}

export type CrmContactDetail = CrmContact & {
  messages: CrmMessage[]
  conversion_events: Conversion[]
}

export type CrmPipeline = {
  stages: Record<CrmStage, number>
  total: number
  attributed: number
  unread: number
  from_sync: number
}

export type CrmFilters = {
  number_id?: number
  stage?: string
  q?: string
  only_attributed?: boolean
  order?: 'last_message' | 'created' | 'name'
}

export type CrmSyncResult = {
  number_id: number
  chats: number
  contacts: number
  created: number
  updated: number
  messages: number
  skipped: number
  errors: string[]
}

/** Cursor de mudança do CRM. A tela compara `cursor` com o anterior: igual, nada
 *  mudou; diferente, recarrega. É o que sustenta a atualização automática. */
export type CrmActivity = {
  contacts: number
  messages: number
  last_message_id: number
  unread: number
  conversions: number
  last_activity_at: string | null
  cursor: string
}

export const crmApi = {
  stages: () => request<{ value: CrmStage; label: string }[]>('/api/crm/stages'),
  activity: (numberId?: number) =>
    request<CrmActivity>(`/api/crm/activity${qs({ number_id: numberId })}`),
  contacts: (filters: CrmFilters = {}) =>
    request<CrmContact[]>(`/api/crm/contacts${qs(filters as Record<string, unknown>)}`),
  pipeline: (numberId?: number) =>
    request<CrmPipeline>(`/api/crm/pipeline${qs({ number_id: numberId })}`),
  contact: (id: number) => request<CrmContactDetail>(`/api/crm/contacts/${id}`),
  patch: (id: number, patch: Record<string, unknown>) =>
    request<CrmContact>(`/api/crm/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  sync: (numberId: number) =>
    request<CrmSyncResult>(`/api/crm/sync${qs({ number_id: numberId })}`, { method: 'POST' }),
  syncMessages: (id: number) =>
    request<{ fetched: number; saved: number }>(`/api/crm/contacts/${id}/messages/sync`, {
      method: 'POST',
    }),
  messagePayload: (messageId: number) =>
    request<MessagePayload>(`/api/crm/messages/${messageId}/payload`),
  reply: (id: number, text: string) =>
    request<{ sent: boolean }>(`/api/crm/contacts/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  campaigns: (numberId?: number) =>
    request<CampaignOverview>(`/api/crm/campaigns${qs({ number_id: numberId })}`),
  resolveCampaigns: (numberId?: number, force = false) =>
    request<CampaignResolveResult>(`/api/crm/campaigns/resolve${qs({ number_id: numberId, force })}`, {
      method: 'POST',
    }),
  /** Campanha preenchida à mão para um anúncio. Tudo vazio desfaz o manual. */
  setCampaign: (
    adId: string,
    data: { campaign_name?: string; adset_name?: string; ad_name?: string; objective?: string },
  ) =>
    request<unknown>(`/api/crm/campaigns/${encodeURIComponent(adId)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
}

// --- instâncias da Evolution API (a "linha" da tela principal) ---

export type EvoInstance = {
  id: number
  label: string
  channel: string
  instance: string | null
  base_url: string | null
  state: string | null
  owner_jid: string | null
  display_phone_number: string | null
  verified_name: string | null
  last_checked_at: string | null
  last_error: string | null
  active: boolean
  is_default: boolean
  note: string | null
  created_at: string
  webhook_url: string
  /** a mesma rota pelo endereço público — só difere quando a entrega vai por rede interna */
  webhook_public_url?: string
  api_key__set: boolean
  api_key__hint: string
  meta_dataset_id: string
  meta_test_event_code: string
  meta_page_id: string
  meta_waba_id: string
  meta_capi_token__set: boolean
  meta_capi_token__hint: string
  meta_ads_token__set?: boolean
  meta_ads_token__hint?: string
  /** objetivo → evento que a linha sobrescreve do mapa padrão */
  objective_events?: Record<string, string>
  enabled_destinations: string[]
  counts: { contacts?: number; conversions?: number; rules?: number }
}

export type EvoStatus = {
  number_id: number
  configured: boolean
  connected: boolean
  state: string | null
  owner_jid?: string | null
  profile_name?: string | null
  errors: string[]
  webhook_url: string
  webhook_public_url?: string
  webhook_configured?: string | null
  webhook_matches?: boolean
  webhook_error?: string
}

/** Uma instância que existe na Evolution — `registered` diz se já tem linha aqui. */
export type EvoAvailable = {
  name: string
  state: string | null
  owner_jid: string | null
  profile_name: string | null
  registered: boolean
}

export type EvoQr = {
  base64?: string | null
  code?: string | null
  pairing_code?: string | null
  state?: string | null
}

export type EvoDefaults = {
  base_url: string
  api_key__set: boolean
  webhook_base: string
  webhook_callback_base?: string
  events: { name: string; label: string; accepts_value: boolean }[]
  webhook_events: string[]
}

export const evolutionApi = {
  list: () => request<EvoInstance[]>('/api/evolution/instances'),
  defaults: () => request<EvoDefaults>('/api/evolution/defaults'),
  create: (payload: Record<string, unknown>) =>
    request<EvoInstance>('/api/evolution/instances', { method: 'POST', body: JSON.stringify(payload) }),
  patch: (id: number, patch: Record<string, unknown>) =>
    request<EvoInstance>(`/api/evolution/instances/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: number, purge = false) =>
    request<void>(`/api/evolution/instances/${id}${qs({ purge })}`, { method: 'DELETE' }),
  /** Instâncias que existem na Evolution. URL/apikey opcionais: o formulário
   *  precisa consultar antes de a linha existir; sem elas o backend usa as globais. */
  available: (baseUrl?: string, apiKey?: string) =>
    request<EvoAvailable[]>(`/api/evolution/available${qs({ base_url: baseUrl, api_key: apiKey })}`),
  provision: (id: number) =>
    request<{ created: boolean; instance: string; state?: string | null }>(
      `/api/evolution/instances/${id}/provision`,
      { method: 'POST' },
    ),
  status: (id: number) => request<EvoStatus>(`/api/evolution/instances/${id}/status`),
  connect: (id: number) => request<EvoQr>(`/api/evolution/instances/${id}/connect`, { method: 'POST' }),
  setWebhook: (id: number) =>
    request<{ webhook_url: string; events: string[]; response: unknown }>(
      `/api/evolution/instances/${id}/webhook`,
      { method: 'POST' },
    ),
  sendTest: (id: number, to: string, body: string) =>
    request<unknown>(`/api/evolution/instances/${id}/send-test`, {
      method: 'POST',
      body: JSON.stringify({ to, body }),
    }),
  simulate: (id: number, payload: Record<string, unknown>) =>
    request<{ summary: string; contact_ids: number[]; rules: unknown[] }>(
      `/api/evolution/instances/${id}/simulate`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
}

// --- regras de palavra-chave ---

export type MatchMode = 'broad' | 'exact'
export type ValueMode = 'none' | 'fixed' | 'extract'
export type RuleDirection = 'attendant' | 'customer' | 'any'

export type KeywordRule = {
  id: number
  wa_number_id: number | null
  event_name: string
  keyword: string
  match_mode: MatchMode
  direction: RuleDirection
  value_mode: ValueMode
  value_fixed: number | null
  currency: string
  require_attribution: boolean
  once_per_contact: boolean
  is_test: boolean
  active: boolean
  /** etapa do funil para onde o lead avança quando a regra casa */
  set_stage: string | null
  hits: number
  last_fired_at: string | null
  created_at: string
}

export type RuleOption = { value: string; label: string; help: string }

export type RuleCatalog = {
  events: { name: string; label: string; accepts_value: boolean }[]
  match_modes: RuleOption[]
  value_modes: RuleOption[]
  directions: RuleOption[]
  stages: { value: string; label: string }[]
}

export type SimulationResult = {
  event_name: string
  fires: boolean
  matched: boolean
  value: number | null
  currency: string
  reason: string
  value_note: string
  normalized_text: string
  normalized_keyword: string
  direction_label: string
}

export const rulesApi = {
  catalog: () => request<RuleCatalog>('/api/rules/catalog'),
  list: (numberId?: number) => request<KeywordRule[]>(`/api/rules${qs({ number_id: numberId })}`),
  create: (payload: Record<string, unknown>) =>
    request<KeywordRule>('/api/rules', { method: 'POST', body: JSON.stringify(payload) }),
  patch: (id: number, patch: Record<string, unknown>) =>
    request<KeywordRule>(`/api/rules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: number) => request<void>(`/api/rules/${id}`, { method: 'DELETE' }),
  simulate: (payload: Record<string, unknown>) =>
    request<SimulationResult>('/api/rules/simulate', { method: 'POST', body: JSON.stringify(payload) }),
}

// --- login e usuários ---

export const authApi = {
  login: (username: string, password: string) =>
    request<TokenPair>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<AuthUser>('/api/auth/me'),
  changePassword: (current_password: string, new_password: string) =>
    request<TokenPair>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ current_password, new_password }),
    }),
  users: () => request<AuthUser[]>('/api/auth/users'),
  createUser: (payload: { username: string; password: string; name?: string; role: string; number_ids?: number[] }) =>
    request<AuthUser>('/api/auth/users', { method: 'POST', body: JSON.stringify(payload) }),
  patchUser: (id: number, patch: Record<string, unknown>) =>
    request<AuthUser>(`/api/auth/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteUser: (id: number) => request<void>(`/api/auth/users/${id}`, { method: 'DELETE' }),
}

export const api = {
  stats: (numberId?: number) => request<Stats>(`/api/stats${qs({ number_id: numberId })}`),
  getConfig: () => request<ConfigResponse>('/api/config'),
  putConfig: (patch: Record<string, unknown>) =>
    request<ConfigResponse>('/api/config', { method: 'PUT', body: JSON.stringify(patch) }),
  connectionStatus: (numberId?: number) =>
    request<ConnectionStatus>(`/api/connection/status${qs({ number_id: numberId })}`),
  subscribe: (numberId?: number) =>
    request<unknown>(`/api/connection/subscribe${qs({ number_id: numberId })}`, { method: 'POST' }),
  sendTest: (to: string, body: string, numberId?: number) =>
    request<unknown>(`/api/connection/send-test${qs({ number_id: numberId })}`, {
      method: 'POST',
      body: JSON.stringify({ to, body }),
    }),
  contacts: (onlyAttributed = false, numberId?: number) =>
    request<Contact[]>(`/api/contacts${qs({ only_attributed: onlyAttributed, number_id: numberId })}`),
  contact: (id: number) => request<ContactDetail>(`/api/contacts/${id}`),
  simulate: (payload: Record<string, unknown>, numberId?: number) =>
    request<unknown>(`/api/contacts/simulate${qs({ number_id: numberId })}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  conversions: (numberId?: number) =>
    request<Conversion[]>(`/api/conversions${qs({ number_id: numberId })}`),
  fire: (payload: Record<string, unknown>) =>
    request<Conversion>('/api/conversions', { method: 'POST', body: JSON.stringify(payload) }),
  preview: (payload: Record<string, unknown>) =>
    request<Record<string, unknown>>('/api/conversions/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  retry: (id: number) => request<Conversion>(`/api/conversions/${id}/retry`, { method: 'POST' }),
  webhookLogs: (numberId?: number) =>
    request<
      {
        id: number
        summary: string
        created_at: string
        wa_number_id: number | null
        phone_number_id: string | null
        payload: unknown
      }[]
    >(`/api/webhook-logs${qs({ number_id: numberId })}`),
}

export const DESTINATION_LABEL: Record<string, string> = {
  meta_capi: 'Meta CAPI',
  google_ads: 'Google Ads',
  webhook: 'Webhook',
}

/* -------------------------------------------------------------------------- */
/*  jornada do lead: site (TL_ID) -> WhatsApp -> lead                          */
/* -------------------------------------------------------------------------- */

export type MatchMethod = 'transaction_id' | 'protocol' | 'temporal' | 'probabilistic' | 'manual'

export type Touch = { source?: string; medium?: string; campaign?: string; content?: string; term?: string }

export type JourneyOrigin = {
  channel: 'google_ads' | 'meta_ads' | 'tiktok_ads' | 'organic' | 'social' | 'referral' | 'utm' | 'direct'
  label: string
}

export type LeadJourneyRef = {
  transaction_id: string | null
  visitor_id: string | null
  session_id: string | null
  first_utm: Touch
  last_utm: Touch
  fbp: string | null
  fbc: string | null
  ttclid: string | null
  landing_page: string | null
  page_url: string | null
  match_method: MatchMethod | null
  match_label: string | null
  match_score: number | null
  whatsapp_arrived_at: string | null
}

export type JourneyLead = LeadJourneyRef & {
  id: number
  name: string | null
  wa_id: string
  phone_e164: string | null
  stage: CrmStage
  wa_number_id: number | null
  created_at: string
}

export type JourneySummary = {
  transaction_id: string
  visitor_id: string | null
  session_ids: string[]
  wa_number_id: number | null
  started_at: string
  last_event_at: string
  events: number
  page_views: number
  landing_page: string | null
  hostname: string | null
  pages: string[]
  first_touch: Touch
  last_touch: Touch
  origin: JourneyOrigin
  first_origin: JourneyOrigin
  click_ids: Record<string, string>
  ga: Record<string, string>
  clicked_whatsapp_at: string | null
  whatsapp_clicks: number
  protocol: string | null
  ip: string | null
  user_agent: string | null
}

export type JourneyRow = JourneySummary & { lead: JourneyLead | null }

export type JourneyEvent = {
  id: number
  event_id: string | null
  event_name: string
  label: string
  event_time: string
  session_id: string | null
  page_url: string | null
  page_path: string | null
  page_title: string | null
  page_referrer: string | null
  utm: Touch
  click_ids: Record<string, string>
  props: Record<string, unknown>
  protocol: string | null
}

export type JourneyDetail = {
  summary: (JourneySummary & { events: number }) | null
  events: JourneyEvent[]
  lead: JourneyLead | null
  answers: { q: string; a: string | null; how: string }[]
}

export type JourneyOverview = {
  days: number
  journeys: number
  visitors: number
  page_views: number
  whatsapp_clicks: number
  matched_leads: number
  conversations: number
  match_rate: number | null
  click_to_lead: number | null
  events_by_name: Record<string, number>
  by_origin: { label: string; channel: JourneyOrigin['channel']; journeys: number; clicks: number; leads: number }[]
  by_method: { method: MatchMethod; label: string; leads: number }[]
  landing_pages: { page: string; journeys: number }[]
  daily: { day: string; journeys: number; clicks: number; leads: number }[]
}

export type TagSetup = {
  number_id: number
  site_key: string
  script_url: string
  collect_url: string
  snippet: string
  match_window_seconds: number
  last_event_at?: string | null
  last_event_host?: string | null
  last_event_url?: string | null
}

export type JourneyFilters = {
  number_id?: number
  status?: 'all' | 'lead' | 'clicked' | 'browsing'
  q?: string
  days?: number
}

export const journeysApi = {
  overview: (numberId?: number, days = 30) =>
    request<JourneyOverview>(`/api/journeys/overview${qs({ number_id: numberId, days })}`),
  list: (filters: JourneyFilters = {}) => request<JourneyRow[]>(`/api/journeys${qs(filters)}`),
  get: (tl: string, numberId?: number) =>
    request<JourneyDetail>(`/api/journeys/${encodeURIComponent(tl)}${qs({ number_id: numberId })}`),
  forContact: (contactId: number) => request<JourneyDetail>(`/api/journeys/contact/${contactId}`),
  link: (contactId: number, transaction_id: string) =>
    request<JourneyDetail>(`/api/journeys/contact/${contactId}/link`, {
      method: 'POST',
      body: JSON.stringify({ transaction_id }),
    }),
  unlink: (contactId: number) =>
    request<{ ok: boolean }>(`/api/journeys/contact/${contactId}/link`, { method: 'DELETE' }),
  setup: (numberId: number) => request<TagSetup>(`/api/journeys/setup${qs({ number_id: numberId })}`),
  rotateKey: (numberId: number) => request<TagSetup>(`/api/journeys/setup/${numberId}/rotate`, { method: 'POST' }),
  simulate: (payload: Record<string, unknown>) =>
    request<{ transaction_id: string; protocol: string; contact_ids?: number[]; summary?: string }>(
      '/api/journeys/simulate',
      { method: 'POST', body: JSON.stringify(payload) },
    ),
}

export const MATCH_TONE: Record<MatchMethod, 'good' | 'info' | 'warn' | 'neutral'> = {
  transaction_id: 'good',
  protocol: 'good',
  temporal: 'info',
  probabilistic: 'warn',
  manual: 'neutral',
}

/** Remove a referência técnica (`tl=...` / protocolo) do texto mostrado no chat. */
export function stripJourneyRef(text: string | null): { text: string | null; ref: string | null } {
  if (!text) return { text, ref: null }
  const tl = text.match(/(?<![A-Za-z0-9_])tl\s*[=:]\s*([A-Za-z0-9][A-Za-z0-9_-]{7,63})/i)
  const protocol = text.match(/\bTL-[A-Z0-9]{6}\b/)
  if (!tl && !protocol) return { text, ref: null }
  const cleaned = text
    .replace(/(?<![A-Za-z0-9_])tl\s*[=:]\s*[A-Za-z0-9][A-Za-z0-9_-]{7,63}/gi, '')
    .replace(/\(?\s*(?:protocolo\s*:?\s*)?\bTL-[A-Z0-9]{6}\b\s*\)?/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: cleaned, ref: tl ? tl[1] : protocol![0] }
}

/* -------------------------------------------------------------------------- */
/*  atendimento: funil, tempo de resposta e análise com IA                      */
/* -------------------------------------------------------------------------- */

export type FunnelStep = {
  stage: CrmStage
  label: string
  count: number
  from_start: number | null
  from_previous: number | null
  lost_here: number
}

export type FunnelData = {
  days: number
  total: number
  steps: FunnelStep[]
  revenue: number
  current: { stage: CrmStage; label: string; count: number }[]
  lost: number
  closed_with_value: number
  avg_ticket: number | null
  by_origin: { label: string; total: number; steps: FunnelStep[]; revenue: number }[]
  timing: { stage: CrmStage; label: string; median_days: number | null; count: number }[]
}

export type TimeSummary = {
  count: number
  avg_seconds: number | null
  median_seconds: number | null
  p90_seconds: number | null
}

export type ResponseTimes = {
  days: number
  responses: TimeSummary
  first_response: TimeSummary
  within_5min: number | null
  unanswered: number
  buckets: { label: string; count: number; share: number | null }[]
  by_hour: { hour: number; count: number; median_seconds: number | null }[]
  by_weekday: { day: string; count: number; median_seconds: number | null }[]
  by_day: { day: string; count: number; median_seconds: number; avg_seconds: number }[]
  waiting_now: { contact_id: number; since: string; seconds: number; name: string | null; stage: CrmStage | null }[]
  waiting_now_count: number
}

export type AiAnalysis = {
  id: number
  contact_id: number
  status: 'ok' | 'error'
  error: string | null
  model: string | null
  created_at: string
  message_count: number
  /** chegou mensagem depois da análise */
  stale: boolean
  summary: string | null
  sentiment: 'positivo' | 'neutro' | 'negativo' | null
  temperature: 'quente' | 'morno' | 'frio' | null
  is_mql: boolean | null
  mql_reason: string | null
  suggested_stage: CrmStage | null
  suggested_stage_label: string | null
  stage_reason: string | null
  applied_stage: CrmStage | null
  score: number | null
  criteria: { key: string; label: string; score: number | null }[]
  strengths: string[]
  improvements: string[]
  objections: { key: string; label: string }[]
  objection_notes: string | null
  next_action: string | null
  input_tokens: number | null
  output_tokens: number | null
}

export type ContactAttendance = {
  response: TimeSummary & { first_response_seconds: number | null; waiting_since: string | null }
  analysis: AiAnalysis | null
  stage: CrmStage
}

export type AiConfig = {
  configured: boolean
  /** quem analisa: Claude (chave da Anthropic) ou, sem ela, o Gemini do .env */
  provider: 'claude' | 'gemini' | null
  anthropic_configured: boolean
  gemini_configured: boolean
  key_hint: string
  model: string | null
  effort: string
  auto_apply_stage: boolean
  criteria: { key: string; label: string }[]
}

export type AiOverview = {
  days: number
  analyzed: number
  with_errors: number
  avg_score: number | null
  mql_rate: number | null
  criteria: { key: string; label: string; avg: number | null }[]
  temperature: { value: string; count: number }[]
  sentiment: { value: string; count: number }[]
  objections: { key: string; label: string; count: number }[]
  top_improvements: { text: string; count: number }[]
  items: (AiAnalysis & { name: string | null; stage: CrmStage | null })[]
}

export type BatchStatus = {
  running: boolean
  total: number
  done: number
  errors: number
  last_error?: string | null
  started_at?: string
  finished_at?: string | null
}

export const attendanceApi = {
  funnel: (numberId?: number, days = 30) =>
    request<FunnelData>(`/api/attendance/funnel${qs({ number_id: numberId, days })}`),
  responseTimes: (numberId?: number, days = 30) =>
    request<ResponseTimes>(`/api/attendance/response-times${qs({ number_id: numberId, days })}`),
  contact: (contactId: number) => request<ContactAttendance>(`/api/attendance/contact/${contactId}`),
  analyze: (contactId: number) =>
    request<{ analysis: AiAnalysis; stage: CrmStage }>(`/api/attendance/contact/${contactId}/analyze`, {
      method: 'POST',
    }),
  applyStage: (contactId: number, stage: CrmStage) =>
    request<{ stage: CrmStage }>(`/api/attendance/contact/${contactId}/apply-stage`, {
      method: 'POST',
      body: JSON.stringify({ stage }),
    }),
  aiConfig: () => request<AiConfig>('/api/attendance/ai-config'),
  saveAiConfig: (patch: { anthropic_api_key?: string; auto_apply_stage?: boolean }) =>
    request<AiConfig>('/api/attendance/ai-config', { method: 'PUT', body: JSON.stringify(patch) }),
  aiOverview: (numberId?: number, days = 30) =>
    request<AiOverview>(`/api/attendance/ai-overview${qs({ number_id: numberId, days })}`),
  batch: (numberId: number | undefined, limit: number) =>
    request<BatchStatus>('/api/attendance/analyze-batch', {
      method: 'POST',
      body: JSON.stringify({ number_id: numberId ?? null, limit, only_stale: true }),
    }),
  batchStatus: (numberId?: number) =>
    request<BatchStatus>(`/api/attendance/analyze-batch${qs({ number_id: numberId })}`),
}

/** "4 min", "1,5 h", "2 d" — duração legível a partir de segundos. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 86400) return `${(seconds / 3600).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`
  return `${(seconds / 86400).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} d`
}
