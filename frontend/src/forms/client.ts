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
  /** código de Test Events do Meta: preenchido, a CAPI envia o Lead como teste */
  meta_test_event_code: string
  /** ao terminar, abre o WhatsApp da linha com a mensagem pronta e o TL_ID */
  whatsapp_redirect: boolean
  whatsapp_phone: string
  whatsapp_message: string
  /** carrega a tag de jornada da linha na página pública */
  track_journey: boolean
  /** Google Sheets via Apps Script: uma linha por resposta */
  sheets_enabled: boolean
  /** URL do app da Web (termina em /exec) */
  sheets_url: string
  /** aba da planilha (criada se não existir) */
  sheets_tab: string
  /** conferido pelo script — vai embutido no código que você cola na planilha */
  sheets_secret: string
}

export type QualOp = 'is_any' | 'is_none' | 'contains' | 'not_contains' | 'gte' | 'lte' | 'filled' | 'empty'

/** Uma regra de qualificação sobre a resposta de uma pergunta. */
export interface QualRule {
  id: string
  field_id: string
  op: QualOp
  /** opções (is_any/is_none) ou termos (contains/not_contains) */
  values: string[]
  /** referência numérica (gte/lte) */
  value: string
  /** pontos no modo "score" */
  points: number
}

export interface LeadFormQualification {
  enabled: boolean
  /** all = todas as regras · any = qualquer uma · score = soma de pontos >= min_score */
  mode: 'all' | 'any' | 'score'
  min_score: number
  rules: QualRule[]
  /** manda o evento ao Meta (CAPI + Pixel) quando qualifica */
  send_event: boolean
  event_name: string
  /** leva o card do CRM para MQL */
  move_to_mql: boolean
  /** aviso no WhatsApp só para lead qualificado */
  notify_only_qualified: boolean
}

export interface QualSimulation {
  total: number
  qualified: number
  has_rules: boolean
  rules: { id: string; matched: number; text: string }[]
  fields: { field_id: string; label: string; answered: number; options: { value: string; count: number; qualified: number }[] }[]
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
  /** quem começou a preencher e não enviou */
  partials: number
  pixel_id: string
  /** nunca volta preenchido: só `capi_token__set` diz se existe */
  capi_token: string
  capi_token__set?: boolean
  logo_url: string
  qualification: LeadFormQualification
  /** respostas classificadas como qualificadas */
  qualified: number
  created_at: string | null
}

export interface LeadFormResponse {
  id: number
  answers: Record<string, string>
  contact_id: number | null
  transaction_id: string | null
  created_at: string | null
  /** null = sem critério na hora do envio */
  qualified: boolean | null
  qualified_source: 'auto' | 'manual' | null
  qualification: { score?: number; matched?: string[]; failed?: string[] }
  qualified_at: string | null
  /** evento QualifiedLead no Meta */
  ql_event_status: 'sent' | 'failed' | 'skipped' | null
  ql_event_error: string | null
  ql_event_at: string | null
  /** linha na planilha do Google Sheets */
  sheets_status: 'sent' | 'failed' | null
  sheets_error: string | null
}

/** Preenchimento abandonado: respostas até onde a pessoa chegou. */
export interface LeadFormPartial {
  id: number
  answers: Record<string, string>
  /** última pergunta alcançada (0 = a primeira) */
  step: number
  transaction_id: string | null
  created_at: string | null
  updated_at: string | null
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
/** Manda o aviso de novo lead com respostas de exemplo (usa o que está na tela, mesmo sem salvar). */
export const testFormNotify = (p: { wa_number_id: number; phone: string; title: string; fields: LeadFormField[] }) =>
  request<{ ok: boolean }>('/api/forms/test-notify', { method: 'POST', body: JSON.stringify(p) })
export const listFormPartials =(id: number) => request<LeadFormPartial[]>(`/api/forms/${id}/partials`)
export const deleteFormPartial = (id: number, partialId: number) =>
  request<void>(`/api/forms/${id}/partials/${partialId}`, { method: 'DELETE' })
export const contactFormResponses =(contactId: number) =>
  request<{ id: number; form_id: number; form_title: string; created_at: string; answers: { label: string; value: string }[] }[]>(
    `/api/forms/contact/${contactId}`,
  )
/** Classifica a resposta na mão. `null` volta para os critérios automáticos. */
export const setResponseQualification = (formId: number, responseId: number, qualified: boolean | null) =>
  request<LeadFormResponse>(`/api/forms/${formId}/responses/${responseId}/qualification`, {
    method: 'PATCH', body: JSON.stringify({ qualified }),
  })
/** Testa critérios (mesmo sem salvar) contra as respostas já recebidas. */
export const simulateQualification = (formId: number, qualification: LeadFormQualification, fields: LeadFormField[]) =>
  request<QualSimulation>(`/api/forms/${formId}/qualification/simulate`, {
    method: 'POST', body: JSON.stringify({ qualification, fields }),
  })
/** Reclassifica as respostas automáticas com os critérios salvos (sem disparar evento). */
export const reapplyQualification = (formId: number) =>
  request<{ evaluated: number; changed: number }>(`/api/forms/${formId}/qualification/reapply`, { method: 'POST' })
/** Apps Script pronto para colar na planilha, com o segredo do formulário. */
export const getSheetsScript = (secret: string) =>
  request<{ script: string }>(`/api/forms/sheets-script?secret=${encodeURIComponent(secret)}`)
/** Grava uma linha de teste com o que está na tela (mesmo sem salvar). */
export const testSheets = (p: { wa_number_id: number; url: string; secret: string; tab: string; title: string; fields: LeadFormField[] }) =>
  request<{ ok: boolean; row?: number }>('/api/forms/sheets-test', { method: 'POST', body: JSON.stringify(p) })
/** Reenvia uma resposta para a planilha. */
export const resendToSheets = (formId: number, responseId: number) =>
  request<LeadFormResponse>(`/api/forms/${formId}/responses/${responseId}/sheets`, { method: 'POST' })
