import { useEffect, useState } from 'react'

import { api, type ConfigResponse } from '../api'
import { Banner, Button, Card, Field, Input, Toggle } from '../ui'

type FieldDef = { key: string; label: string; hint?: string; secret?: boolean }

const META: FieldDef[] = [
  {
    key: 'meta_dataset_id',
    label: 'Dataset / Pixel ID',
    hint: 'Events Manager > sua fonte de dados > Configurações. Para CTWA use o dataset ligado à conta de anúncios.',
  },
  {
    key: 'meta_capi_token',
    label: 'Access Token da Conversions API',
    hint: 'Events Manager > Configurações > Gerar token de acesso.',
    secret: true,
  },
  {
    key: 'meta_test_event_code',
    label: 'Test Event Code',
    hint: 'Events Manager > Test Events. Usado só quando o disparo está em "modo teste".',
  },
]

const GOOGLE: FieldDef[] = [
  { key: 'google_customer_id', label: 'Customer ID', hint: 'Só números, sem traços.' },
  { key: 'google_login_customer_id', label: 'Login Customer ID (MCC)', hint: 'Opcional — só se acessa via central.' },
  {
    key: 'google_conversion_action_id',
    label: 'Conversion Action ID',
    hint: 'Ferramentas > Conversões > a ação (tipo "Importar"). O ID está na URL (ctId).',
  },
  { key: 'google_developer_token', label: 'Developer Token', secret: true },
  { key: 'google_client_id', label: 'OAuth Client ID' },
  { key: 'google_client_secret', label: 'OAuth Client Secret', secret: true },
  { key: 'google_refresh_token', label: 'Refresh Token', secret: true },
]

const WEBHOOK: FieldDef[] = [
  { key: 'webhook_url', label: 'URL de destino', hint: 'n8n, Make, GTM server-side, seu backend…' },
  {
    key: 'webhook_secret',
    label: 'Secret (HMAC)',
    hint: 'Se preenchido, assina o corpo em X-Signature-256 (sha256=…).',
    secret: true,
  },
]

function Section({
  title,
  subtitle,
  enabledKey,
  fields,
  cfg,
  draft,
  setDraft,
}: {
  title: string
  subtitle: string
  enabledKey: string
  fields: FieldDef[]
  cfg: ConfigResponse
  draft: Record<string, unknown>
  setDraft: (d: Record<string, unknown>) => void
}) {
  const enabled = Boolean(draft[enabledKey] ?? cfg.config[enabledKey])
  return (
    <Card
      title={title}
      subtitle={subtitle}
      actions={
        <Toggle
          checked={enabled}
          onChange={(v) => setDraft({ ...draft, [enabledKey]: v })}
          label={enabled ? 'ativo' : 'inativo'}
        />
      }
    >
      <div className="space-y-4">
        {fields.map((f) => {
          const isSet = Boolean(cfg.config[`${f.key}__set`])
          const hintText = cfg.config[`${f.key}__hint`]
          return (
            <Field
              key={f.key}
              label={f.label}
              hint={f.secret && isSet ? `Salvo (${String(hintText)}). ${f.hint ?? ''}` : f.hint}
            >
              <Input
                type={f.secret ? 'password' : 'text'}
                value={String(draft[f.key] ?? '')}
                placeholder={f.secret && isSet ? '•••••••• (mantém o atual)' : ''}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
            </Field>
          )
        })}
      </div>
    </Card>
  )
}

export default function Destinations({ onChanged }: { onChanged: () => void }) {
  const [cfg, setCfg] = useState<ConfigResponse | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const data = await api.getConfig()
    setCfg(data)
    const nonSecret = [...META, ...GOOGLE, ...WEBHOOK].filter((f) => !f.secret)
    setDraft({
      meta_capi_enabled: data.config.meta_capi_enabled,
      google_ads_enabled: data.config.google_ads_enabled,
      webhook_enabled: data.config.webhook_enabled,
      default_event_name: data.config.default_event_name,
      default_currency: data.config.default_currency,
      ...Object.fromEntries(nonSecret.map((f) => [f.key, String(data.config[f.key] ?? '')])),
    })
  }

  useEffect(() => {
    void load()
  }, [])

  if (!cfg) return <p className="text-sm text-ink-500">carregando…</p>

  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await api.putConfig(draft)
      await load()
      onChanged()
      setMsg({ tone: 'good', text: 'Destinos salvos.' })
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-ink-500">
          Destinos ativos são usados quando você dispara sem escolher nada. Na tela de Leads dá pra sobrescrever
          por disparo.
        </p>
        <Button variant="primary" onClick={save} disabled={busy}>
          {busy ? 'salvando…' : 'Salvar destinos'}
        </Button>
      </div>

      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <div className="grid gap-5 lg:grid-cols-2">
        <Section
          title="Meta Conversions API"
          subtitle="action_source=business_messaging + ctwa_clid. É o caminho oficial para atribuir conversa a campanha."
          enabledKey="meta_capi_enabled"
          fields={META}
          cfg={cfg}
          draft={draft}
          setDraft={setDraft}
        />
        <Section
          title="Webhook genérico"
          subtitle="Repassa o evento completo, com toda a atribuição, para uma URL sua."
          enabledKey="webhook_enabled"
          fields={WEBHOOK}
          cfg={cfg}
          draft={draft}
          setDraft={setDraft}
        />
        <Section
          title="Google Ads — conversões offline"
          subtitle="uploadClickConversions via gclid/wbraid. Exige que a landing embuta o clique no link do wa.me."
          enabledKey="google_ads_enabled"
          fields={GOOGLE}
          cfg={cfg}
          draft={draft}
          setDraft={setDraft}
        />
        <Card title="Padrões" subtitle="Usados quando o disparo não especifica.">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Evento padrão">
              <Input
                value={String(draft.default_event_name ?? '')}
                onChange={(e) => setDraft({ ...draft, default_event_name: e.target.value })}
              />
            </Field>
            <Field label="Moeda padrão">
              <Input
                value={String(draft.default_currency ?? '')}
                onChange={(e) => setDraft({ ...draft, default_currency: e.target.value })}
              />
            </Field>
          </div>
        </Card>
      </div>
    </div>
  )
}
