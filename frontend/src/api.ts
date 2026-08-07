const BASE = import.meta.env.VITE_API_URL ?? ''

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
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
