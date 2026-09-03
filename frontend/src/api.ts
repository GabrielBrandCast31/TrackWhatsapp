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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
  messages: { id: number; direction: string; type: string | null; body: string | null; sent_at: string }[]
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

export const CRM_STAGES = ['novo', 'atendendo', 'qualificado', 'ganho', 'perdido'] as const
export type CrmStage = (typeof CRM_STAGES)[number]

export const CRM_STAGE_LABEL: Record<CrmStage, string> = {
  novo: 'Novo',
  atendendo: 'Atendendo',
  qualificado: 'Qualificado',
  ganho: 'Ganho',
  perdido: 'Perdido',
}

export type CrmContact = {
  id: number
  wa_id: string
  wa_number_id: number | null
  phone_e164: string | null
  name: string | null
  profile_pic_url: string | null
  stage: CrmStage
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
}

export type CrmMessage = {
  id: number
  direction: string
  type: string | null
  body: string | null
  sent_at: string
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

export const crmApi = {
  stages: () => request<{ value: CrmStage; label: string }[]>('/api/crm/stages'),
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
  reply: (id: number, text: string) =>
    request<{ sent: boolean }>(`/api/crm/contacts/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ text }),
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
  api_key__set: boolean
  api_key__hint: string
  meta_dataset_id: string
  meta_test_event_code: string
  meta_capi_token__set: boolean
  meta_capi_token__hint: string
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
  createUser: (payload: { username: string; password: string; name?: string; role: string }) =>
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
