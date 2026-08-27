import { useEffect, useState } from 'react'

import {
  DESTINATION_LABEL,
  numbersApi,
  type ConnectionStatus,
  type Orphans,
  type WaNumber,
} from '../api'
import { Badge, Banner, Button, Card, Copy, Empty, Field, Input, Textarea, when } from '../ui'

/** Credenciais da Cloud API: identidade da linha, uma por número. */
const CREDENTIAL_FIELDS: { key: string; label: string; hint?: string; secret?: boolean }[] = [
  {
    key: 'phone_number_id',
    label: 'Phone Number ID',
    hint: 'Meta for Developers > WhatsApp > API Setup. É o ID numérico, não o telefone.',
  },
  {
    key: 'access_token',
    label: 'Access Token',
    hint: 'Token permanente do System User com whatsapp_business_messaging.',
    secret: true,
  },
  {
    key: 'business_account_id',
    label: 'WhatsApp Business Account ID (WABA)',
    hint: 'Necessário para assinar webhooks e listar os templates desta linha.',
  },
  {
    key: 'verify_token',
    label: 'Verify Token',
    hint: 'Você inventa. Cole o mesmo valor no webhook desta linha, no painel da Meta.',
  },
  {
    key: 'app_secret',
    label: 'App Secret',
    hint: 'Valida o X-Hub-Signature-256. Em branco, a assinatura desta linha não é conferida.',
    secret: true,
  },
]

/** Destinos que a linha pode ter só pra ela. Em branco = herda o global de Destinos. */
const OVERRIDE_FIELDS: { key: string; label: string; hint?: string; secret?: boolean }[] = [
  { key: 'meta_dataset_id', label: 'Meta Pixel / Dataset ID' },
  { key: 'meta_capi_token', label: 'Meta CAPI Token', secret: true },
  { key: 'meta_test_event_code', label: 'Código de evento de teste' },
  { key: 'google_customer_id', label: 'Google Ads Customer ID', hint: 'Sem traços.' },
  { key: 'google_conversion_action_id', label: 'Google Conversion Action ID' },
  { key: 'webhook_url', label: 'Webhook de saída (URL)' },
  { key: 'webhook_secret', label: 'Webhook de saída (segredo)', secret: true },
  { key: 'outreach_template_name', label: 'Template padrão da abordagem' },
]

const OVERRIDE_TOGGLES: { key: string; label: string; hint: string }[] = [
  { key: 'meta_capi_enabled', label: 'Meta CAPI', hint: 'Envia conversões desta linha para o Meta.' },
  { key: 'google_ads_enabled', label: 'Google Ads', hint: 'Envia conversões offline desta linha.' },
  { key: 'webhook_enabled', label: 'Webhook de saída', hint: 'Repassa a conversão para sua URL.' },
  {
    key: 'outreach_enabled',
    label: 'Abordagem ativa',
    hint: 'Libera o disparo em massa por esta linha. Desligado, a fila desta linha fica parada.',
  },
]

type Draft = Record<string, string>

function credentialDraft(n: WaNumber | null): Draft {
  return {
    label: n?.label ?? '',
    phone_number_id: n?.phone_number_id ?? '',
    business_account_id: n?.business_account_id ?? '',
    verify_token: n?.verify_token ?? '',
    graph_version: n?.graph_version ?? '',
    access_token: '',
    app_secret: '',
    note: n?.note ?? '',
  }
}

function overrideDraft(n: WaNumber | null): Draft {
  const out: Draft = {}
  for (const f of OVERRIDE_FIELDS) {
    const raw = n?.overrides?.[f.key]
    out[f.key] = f.secret ? '' : raw === undefined || raw === null ? '' : String(raw)
  }
  out.outreach_daily_cap = n?.overrides?.outreach_daily_cap
    ? String(n.overrides.outreach_daily_cap)
    : ''
  out.outreach_throttle_seconds = n?.overrides?.outreach_throttle_seconds
    ? String(n.overrides.outreach_throttle_seconds)
    : ''
  return out
}

function StatusBadges({ n, status }: { n: WaNumber; status?: ConnectionStatus }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {n.is_default && <Badge tone="good">padrão</Badge>}
      {!n.active && <Badge tone="bad">inativa</Badge>}
      {status && <Badge tone={status.connected ? 'good' : 'bad'}>{status.connected ? 'número ativo' : 'sem conexão'}</Badge>}
      {n.quality_rating && <Badge tone="neutral">qualidade {n.quality_rating.toLowerCase()}</Badge>}
      {(n.enabled_destinations ?? []).map((d) => (
        <Badge key={d} tone="neutral">
          {DESTINATION_LABEL[d] ?? d}
        </Badge>
      ))}
      {n.outreach_enabled && <Badge tone="warn">abordagem ligada</Badge>}
    </div>
  )
}

function NumberEditor({
  number,
  onSaved,
  onCancel,
}: {
  number: WaNumber | null
  onSaved: () => void
  onCancel: () => void
}) {
  const [creds, setCreds] = useState<Draft>(() => credentialDraft(number))
  const [over, setOver] = useState<Draft>(() => overrideDraft(number))
  const [toggles, setToggles] = useState<Record<string, boolean | undefined>>(
    () =>
      Object.fromEntries(
        OVERRIDE_TOGGLES.map((t) => [t.key, number?.overrides?.[t.key] as boolean | undefined]),
      ) as Record<string, boolean | undefined>,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setCreds(credentialDraft(number))
    setOver(overrideDraft(number))
    setToggles(
      Object.fromEntries(
        OVERRIDE_TOGGLES.map((t) => [t.key, number?.overrides?.[t.key] as boolean | undefined]),
      ) as Record<string, boolean | undefined>,
    )
  }, [number])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const overrides: Record<string, unknown> = { ...over }
      for (const [key, value] of Object.entries(toggles)) {
        // undefined = não sobrescreve; o backend apaga a chave e a linha volta a herdar
        overrides[key] = value === undefined ? '' : value
      }
      const payload = { ...creds, overrides }
      if (number) await numbersApi.patch(number.id, payload)
      else await numbersApi.create(payload)
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const secretPlaceholder = (key: string) => {
    if (key === 'access_token' && number?.access_token__set) return `•••• ${number.access_token__hint}`
    if (key === 'app_secret' && number?.app_secret__set) return `•••• ${number.app_secret__hint}`
    const hint = number?.overrides?.[`${key}__hint`]
    return number?.overrides?.[`${key}__set`] ? `•••• ${String(hint ?? '')}` : ''
  }

  return (
    <Card
      title={number ? `Editar ${number.label}` : 'Nova linha de WhatsApp'}
      subtitle="Campos de segredo em branco mantêm o valor já salvo."
      actions={
        <>
          <Button size="sm" onClick={onCancel}>
            cancelar
          </Button>
          <Button size="sm" variant="primary" onClick={save} disabled={busy}>
            {busy ? 'salvando…' : 'Salvar'}
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <p className="text-[11px] uppercase tracking-wide text-ink-500">Identificação</p>
          <Field label="Nome da linha" hint="Como você reconhece esse número. Ex.: Clínica Vida, Loja Centro.">
            <Input value={creds.label} onChange={(e) => setCreds({ ...creds, label: e.target.value })} />
          </Field>
          {CREDENTIAL_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              hint={f.hint}
            >
              <Input
                type={f.secret ? 'password' : 'text'}
                value={creds[f.key] ?? ''}
                placeholder={f.secret ? secretPlaceholder(f.key) : ''}
                onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })}
              />
            </Field>
          ))}
          <Field label="Observação" hint="Opcional — quem é o cliente, contrato, o que quiser.">
            <Textarea
              rows={2}
              value={creds.note}
              onChange={(e) => setCreds({ ...creds, note: e.target.value })}
            />
          </Field>
        </div>

        <div className="space-y-4">
          <p className="text-[11px] uppercase tracking-wide text-ink-500">
            Destinos desta linha — em branco herda o global
          </p>
          {OVERRIDE_TOGGLES.map((t) => (
            <div key={t.key} className="rounded-lg border border-ink-800 bg-ink-850 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-ink-100">{t.label}</p>
                  <p className="mt-0.5 text-xs text-ink-500">{t.hint}</p>
                </div>
                <select
                  value={toggles[t.key] === undefined ? 'herda' : toggles[t.key] ? 'on' : 'off'}
                  onChange={(e) =>
                    setToggles({
                      ...toggles,
                      [t.key]: e.target.value === 'herda' ? undefined : e.target.value === 'on',
                    })
                  }
                  className="rounded-lg border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-100"
                >
                  <option value="herda">herda global</option>
                  <option value="on">ligado</option>
                  <option value="off">desligado</option>
                </select>
              </div>
            </div>
          ))}
          {OVERRIDE_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <Input
                type={f.secret ? 'password' : 'text'}
                value={over[f.key] ?? ''}
                placeholder={f.secret ? secretPlaceholder(f.key) : 'herda o global'}
                onChange={(e) => setOver({ ...over, [f.key]: e.target.value })}
              />
            </Field>
          ))}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cap diário de abordagens" hint="Só desta linha.">
              <Input
                value={over.outreach_daily_cap ?? ''}
                placeholder="herda"
                onChange={(e) => setOver({ ...over, outreach_daily_cap: e.target.value })}
              />
            </Field>
            <Field label="Intervalo entre disparos (s)">
              <Input
                value={over.outreach_throttle_seconds ?? ''}
                placeholder="herda"
                onChange={(e) => setOver({ ...over, outreach_throttle_seconds: e.target.value })}
              />
            </Field>
          </div>
        </div>
      </div>
      {error && (
        <div className="mt-4">
          <Banner tone="bad">{error}</Banner>
        </div>
      )}
    </Card>
  )
}

function NumberRow({
  n,
  selected,
  onSelect,
  onEdit,
  onChanged,
}: {
  n: WaNumber
  selected: boolean
  onSelect: () => void
  onEdit: () => void
  onChanged: () => void
}) {
  const [status, setStatus] = useState<ConnectionStatus | undefined>()
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState('')

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name)
    setMsg(null)
    try {
      await fn()
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <li
      className={`rounded-xl border p-4 transition-colors ${
        selected ? 'border-wa-500/60 bg-ink-850' : 'border-ink-800 bg-ink-900'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={onSelect} className="text-sm font-semibold text-ink-100 hover:text-wa-500">
              {n.label}
            </button>
            <StatusBadges n={n} status={status} />
          </div>
          <p className="mt-1 font-mono text-xs text-ink-500">
            {n.display_phone_number ?? '—'} · id {n.phone_number_id}
            {n.verified_name ? ` · ${n.verified_name}` : ''}
          </p>
          {n.counts && (
            <p className="mt-1.5 text-xs text-ink-500">
              {n.counts.contacts} lead(s) · {n.counts.prospects} prospect(s) · {n.counts.outreach_sent}{' '}
              abordagem(ns) · {n.counts.conversions} conversão(ões)
            </p>
          )}
          {n.last_error && <p className="mt-1.5 text-xs text-amber-300">{n.last_error}</p>}
          {n.last_checked_at && (
            <p className="mt-1 text-[11px] text-ink-600">conferido {when(n.last_checked_at)}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onSelect}>
            {selected ? 'em uso' : 'usar'}
          </Button>
          <Button size="sm" onClick={onEdit}>
            editar
          </Button>
          <Button
            size="sm"
            onClick={() =>
              run('status', async () => {
                const s = await numbersApi.status(n.id)
                setStatus(s)
                onChanged()
              })
            }
            disabled={busy === 'status'}
          >
            {busy === 'status' ? 'testando…' : 'testar'}
          </Button>
          <Button
            size="sm"
            onClick={() =>
              run('sub', async () => {
                await numbersApi.subscribe(n.id)
                setMsg({ tone: 'good', text: 'App assinado nos webhooks deste WABA.' })
              })
            }
            disabled={busy === 'sub'}
          >
            assinar webhook
          </Button>
          {!n.is_default && (
            <Button
              size="sm"
              onClick={() =>
                run('default', async () => {
                  await numbersApi.patch(n.id, { is_default: true })
                  onChanged()
                })
              }
            >
              tornar padrão
            </Button>
          )}
          <Button
            size="sm"
            onClick={() =>
              run('active', async () => {
                await numbersApi.patch(n.id, { active: !n.active })
                onChanged()
              })
            }
          >
            {n.active ? 'desativar' : 'ativar'}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-lg border border-ink-800 bg-ink-950 px-3 py-2">
        <span className="shrink-0 text-[11px] uppercase tracking-wide text-ink-600">webhook</span>
        <code className="flex-1 truncate font-mono text-xs text-wa-500">{n.webhook_url}</code>
        <Copy text={n.webhook_url} />
      </div>

      {status?.errors && status.errors.length > 0 && (
        <ul className="mt-2 space-y-1">
          {status.errors.map((e) => (
            <li key={e} className="text-xs leading-relaxed text-amber-300">
              • {e}
            </li>
          ))}
        </ul>
      )}
      {msg && (
        <div className="mt-3">
          <Banner tone={msg.tone}>{msg.text}</Banner>
        </div>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-ink-500 hover:text-ink-300">
          remover esta linha
        </summary>
        <div className="mt-2 space-y-2 rounded-lg border border-red-900/50 bg-red-950/20 p-3">
          <p className="text-xs leading-relaxed text-ink-300">
            Digite <code className="font-mono text-red-300">{n.label}</code> para confirmar. Os leads e
            prospects desta linha ficam guardados sem dono (visíveis em “Todas as linhas”) — a menos que
            você escolha apagar tudo.
          </p>
          <Input value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={confirmDelete !== n.label || busy === 'del'}
              onClick={() =>
                run('del', async () => {
                  await numbersApi.remove(n.id, false)
                  onChanged()
                })
              }
            >
              remover, manter a base
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={confirmDelete !== n.label || busy === 'purge'}
              onClick={() =>
                run('purge', async () => {
                  await numbersApi.remove(n.id, true)
                  onChanged()
                })
              }
            >
              remover e apagar leads e prospects
            </Button>
          </div>
        </div>
      </details>
    </li>
  )
}

export default function Numbers({ onChanged }: { onChanged: () => void }) {
  // esta tela e da Cloud API: tem lista propria, e nao a do seletor da Evolution
  const [numbers, setNumbers] = useState<WaNumber[]>([])
  const [selectedId, setSelectedId] = useState<number | undefined>(undefined)
  const [editing, setEditing] = useState<WaNumber | null | undefined>(undefined)
  const [orphans, setOrphans] = useState<Orphans | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = async () => {
    setNumbers(await numbersApi.list('cloud').catch(() => []))
    setOrphans(await numbersApi.orphans().catch(() => null))
    onChanged()
  }

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <div className="space-y-5">
      {editing !== undefined && (
        <NumberEditor
          number={editing}
          onSaved={() => {
            setEditing(undefined)
            void refresh()
          }}
          onCancel={() => setEditing(undefined)}
        />
      )}

      <Card
        title="Linhas de WhatsApp"
        subtitle="Cada linha tem credenciais, base de leads e destinos de conversão próprios."
        actions={
          <Button variant="primary" size="sm" onClick={() => setEditing(null)}>
            adicionar número
          </Button>
        }
      >
        {numbers.length === 0 ? (
          <Empty>
            Nenhuma linha cadastrada. Adicione o primeiro número com o Phone Number ID e o Access Token
            da Cloud API.
          </Empty>
        ) : (
          <ul className="space-y-3">
            {numbers.map((n) => (
              <NumberRow
                key={n.id}
                n={n}
                selected={n.id === selectedId}
                onSelect={() => setSelectedId(n.id)}
                onEdit={() => setEditing(n)}
                onChanged={() => void refresh()}
              />
            ))}
          </ul>
        )}
      </Card>

      {orphans && orphans.total > 0 && (
        <Card
          title="Registros sem linha"
          subtitle="Base que existia antes do multi-número, ou que sobrou de uma linha removida."
        >
          <p className="text-xs leading-relaxed text-ink-300">
            {orphans.contacts} lead(s), {orphans.prospects} prospect(s) e {orphans.searches} varredura(s)
            estão sem dono. Eles só aparecem na visão “Todas as linhas”. Escolha para qual linha eles vão:
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {numbers.map((n) => (
              <Button
                key={n.id}
                size="sm"
                onClick={async () => {
                  const res = await numbersApi.adoptOrphans(n.id)
                  setMsg(
                    `${res.adopted.contacts} lead(s) e ${res.adopted.prospects} prospect(s) agora são de ${n.label}.`,
                  )
                  await refresh()
                }}
              >
                mover para {n.label}
              </Button>
            ))}
          </div>
          {msg && (
            <div className="mt-3">
              <Banner tone="good">{msg}</Banner>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
