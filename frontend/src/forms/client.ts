// Tipos e chamadas dos formulários de captação. Os nomes seguem os do
// BrandCastERP, de onde as telas vieram, para as duas bases lerem igual.
import { request } from '../api'

export type LeadFormFieldType =
  | 'text' | 'email' | 'phone' | 'textarea' | 'number' | 'date' | 'url'
  | 'choice' | 'multi' | 'select' | 'rating'

export interface LeadFormField {
  id: string
  label: string
  type: LeadFormFieldType
  required: boolean
  options: string[]
  placeholder: string
  help: string
}

export interface LeadFormTheme {
  primary: string
  bg: string
  text: string
  button: string
  font: 'sans' | 'serif' | 'mono'
  radius: 'none' | 'md' | 'xl' | 'full'
  gradient: boolean
}

export interface LeadFormSettings {
  layout: 'step' | 'page'
  show_cover: boolean
  cover_button: string
  show_progress: boolean
  show_branding: boolean
  branding_text: string
  logo_size: number
  consent_enabled: boolean
  consent_text: string
  redirect_url: string
  redirect_delay: number
  webhook_url: string
  /** ao terminar, abre o WhatsApp da linha com a mensagem pronta e o TL_ID */
  whatsapp_redirect: boolean
  whatsapp_phone: string
  whatsapp_message: string
  /** carrega a tag de jornada da linha na página pública */
  track_journey: boolean
}

export interface LeadForm {
  id: number
  slug: string
  wa_number_id: number | null
  number_label: string | null
  title: string
  headline: string
  description: string
  fields: LeadFormField[]
  theme: LeadFormTheme
  settings: LeadFormSettings
  thank_you: string
  whatsapp_notify: string
  create_lead: boolean
  active: boolean
  views: number
  responses: number
  pixel_id: string
  /** nunca volta preenchido: só `capi_token__set` diz se existe */
  capi_token: string
  capi_token__set?: boolean
  logo_url: string
  created_at: string | null
}

export interface LeadFormResponse {
  id: number
  answers: Record<string, string>
  contact_id: number | null
  transaction_id: string | null
  created_at: string | null
}

export interface FormFramework {
  id: string
  name: string
  subtitle: string
  best_for: string
  watch_out: string
  stages: { key: string; name: string; goal: string }[]
  questions: number
}

export interface FormAiDraft {
  title: string
  headline: string
  description: string
  thank_you: string
  fields: LeadFormField[]
  framework: string
  framework_name: string
  /** "ia" = escrito pelo Gemini; "modelo" = veio do template do método */
  source: 'ia' | 'modelo'
  ai_error?: string | null
}

export interface FormAiInput {
  framework: string
  number_id?: number | null
  business?: string
  offer?: string
  audience?: string
  tone?: string
  questions?: number
  notes?: string
}

/** Linha (cliente) dona do formulário — o "cliente" do ERP. */
export interface FormLine {
  id: number
  name: string
}

const qs = (numberId?: number) => (numberId ? `?number_id=${numberId}` : '')

export const listForms = async (numberId?: number) => ({
  forms: await request<LeadForm[]>(`/api/forms${qs(numberId)}`),
})
export const createForm = (f: Record<string, unknown>) =>
  request<LeadForm>('/api/forms', { method: 'POST', body: JSON.stringify(f) })
export const updateForm = (id: number, f: Record<string, unknown>) =>
  request<LeadForm>(`/api/forms/${id}`, { method: 'PATCH', body: JSON.stringify(f) })
export const deleteForm = (id: number) => request<void>(`/api/forms/${id}`, { method: 'DELETE' })
export const listFormFrameworks = () =>
  request<{ frameworks: FormFramework[]; min_questions: number; max_questions: number; ai_available: boolean }>(
    '/api/forms/frameworks',
  )
export const generateFormWithAi = (p: FormAiInput) =>
  request<FormAiDraft>('/api/forms/ai-generate', { method: 'POST', body: JSON.stringify(p) })
export const listFormResponses = async (id: number) => ({
  responses: await request<LeadFormResponse[]>(`/api/forms/${id}/responses`),
})
export const contactFormResponses = (contactId: number) =>
  request<{ id: number; form_id: number; form_title: string; created_at: string; answers: { label: string; value: string }[] }[]>(
    `/api/forms/contact/${contactId}`,
  )
