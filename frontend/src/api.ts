const BASE = import.meta.env.VITE_API_URL ?? ''

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    // fetch só rejeita quando a requisição nem sai: backend fora do ar, DNS, CORS
    throw new ApiError(`Não consegui falar com a API (${path}). O backend está no ar?`)
  }

  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok) {
    // 404 numa rota da API quase sempre é container servindo código antigo — o
    // "Not Found" cru não diz isso pra ninguém.
    if (res.status === 404) {
      throw new ApiError(
        `A rota ${path} não existe nesse backend (404). Se você acabou de atualizar o código, ` +
          'rode `docker compose up --build -d` e recarregue a página com Cmd+Shift+R.',
      )
    }
    const detail =
      body && typeof body === 'object' && 'detail' in body
        ? String((body as { detail: unknown }).detail)
        : `HTTP ${res.status}`
    throw new ApiError(detail)
  }
  return body as T
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
  created_at: string
  dispatches: Dispatch[]
  contact?: { id: number; wa_id: string; name: string | null }
}

export type ConnectionStatus = {
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
}

export type Stats = {
  contacts: number
  attributed_contacts: number
  conversions: number
  dispatches: Record<string, number>
  prospects: number
  outreach_sent: number
  prospects_replied: number
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
  searches: () => request<ProspectSearch[]>('/api/prospect/searches'),
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
  pipeline: () => request<Pipeline>('/api/prospect/pipeline'),
  templates: () => request<WaTemplate[]>('/api/prospect/templates'),
  outreachOne: (id: number, payload: Record<string, unknown>) =>
    request<Outreach>(`/api/prospect/prospects/${id}/outreach`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  outreachBulk: (payload: Record<string, unknown>) =>
    request<{ queued: number; skipped: { id: number; name: string; reason: string }[]; cap: number }>(
      '/api/prospect/outreach/bulk',
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  outreachLog: (status?: string) =>
    request<Outreach[]>(`/api/prospect/outreach${qs({ status })}`),
  drain: () => request<{ pending: number }>('/api/prospect/outreach/drain', { method: 'POST' }),
  csvUrl: (filters: ProspectFilters = {}) =>
    `${BASE}/api/prospect/prospects.csv${qs(filters as Record<string, unknown>)}`,
}

export const api = {
  stats: () => request<Stats>('/api/stats'),
  getConfig: () => request<ConfigResponse>('/api/config'),
  putConfig: (patch: Record<string, unknown>) =>
    request<ConfigResponse>('/api/config', { method: 'PUT', body: JSON.stringify(patch) }),
  connectionStatus: () => request<ConnectionStatus>('/api/connection/status'),
  subscribe: () => request<unknown>('/api/connection/subscribe', { method: 'POST' }),
  sendTest: (to: string, body: string) =>
    request<unknown>('/api/connection/send-test', { method: 'POST', body: JSON.stringify({ to, body }) }),
  contacts: (onlyAttributed = false) =>
    request<Contact[]>(`/api/contacts?only_attributed=${onlyAttributed}`),
  contact: (id: number) => request<ContactDetail>(`/api/contacts/${id}`),
  simulate: (payload: Record<string, unknown>) =>
    request<unknown>('/api/contacts/simulate', { method: 'POST', body: JSON.stringify(payload) }),
  conversions: () => request<Conversion[]>('/api/conversions'),
  fire: (payload: Record<string, unknown>) =>
    request<Conversion>('/api/conversions', { method: 'POST', body: JSON.stringify(payload) }),
  preview: (payload: Record<string, unknown>) =>
    request<Record<string, unknown>>('/api/conversions/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  retry: (id: number) => request<Conversion>(`/api/conversions/${id}/retry`, { method: 'POST' }),
  webhookLogs: () =>
    request<{ id: number; summary: string; created_at: string; payload: unknown }[]>('/api/webhook-logs'),
}

export const DESTINATION_LABEL: Record<string, string> = {
  meta_capi: 'Meta CAPI',
  google_ads: 'Google Ads',
  webhook: 'Webhook',
}
