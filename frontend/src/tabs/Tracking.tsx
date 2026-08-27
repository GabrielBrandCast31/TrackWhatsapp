import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  evolutionApi,
  rulesApi,
  type EvoInstance,
  type KeywordRule,
  type RuleCatalog,
  type SimulationResult,
} from '../api'
import { useNumber } from '../numberContext'
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  Field,
  Info,
  Input,
  RadioGroup,
  Select,
  Textarea,
  Toggle,
  TrashButton,
  money,
  when,
} from '../ui'

type Draft = {
  event_name: string
  keyword: string
  match_mode: 'broad' | 'exact'
  direction: 'attendant' | 'customer' | 'any'
  value_mode: 'none' | 'fixed' | 'extract'
  value_fixed: number | null
  currency: string
  require_attribution: boolean
  once_per_contact: boolean
  is_test: boolean
  active: boolean
}

const NEW_RULE: Draft = {
  event_name: 'Lead',
  keyword: '',
  match_mode: 'exact',
  direction: 'attendant',
  value_mode: 'none',
  value_fixed: null,
  currency: 'BRL',
  require_attribution: true,
  once_per_contact: true,
  is_test: false,
  active: true,
}

function toDraft(rule: KeywordRule): Draft {
  return {
    event_name: rule.event_name,
    keyword: rule.keyword,
    match_mode: rule.match_mode,
    direction: rule.direction,
    value_mode: rule.value_mode,
    value_fixed: rule.value_fixed,
    currency: rule.currency,
    require_attribution: rule.require_attribution,
    once_per_contact: rule.once_per_contact,
    is_test: rule.is_test,
    active: rule.active,
  }
}

/** Pixel + token da Conversions API da linha selecionada. */
function MetaDestination({ instance, onSaved }: { instance: EvoInstance; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState({
    meta_dataset_id: instance.meta_dataset_id,
    meta_capi_token: '',
    meta_test_event_code: instance.meta_test_event_code,
  })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  useEffect(() => {
    setDraft({
      meta_dataset_id: instance.meta_dataset_id,
      meta_capi_token: '',
      meta_test_event_code: instance.meta_test_event_code,
    })
  }, [instance.id, instance.meta_dataset_id, instance.meta_test_event_code])

  const ready = Boolean(instance.meta_dataset_id) && instance.meta_capi_token__set

  return (
    <Card
      title="Meta — Pixel e token da API"
      subtitle={`Para onde as conversões de ${instance.label} são enviadas.`}
      actions={ready ? <Badge tone="good">destino pronto</Badge> : <Badge tone="warn">incompleto</Badge>}
    >
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Pixel / Dataset ID" hint="Events Manager → sua fonte de dados → Configurações.">
            <Input
              value={draft.meta_dataset_id}
              placeholder="1234567890123456"
              onChange={(e) => setDraft({ ...draft, meta_dataset_id: e.target.value })}
            />
          </Field>
          <Field
            label="Token da API de Conversões"
            hint={
              instance.meta_capi_token__set
                ? `Salvo (${instance.meta_capi_token__hint}). Deixe em branco para manter.`
                : 'Events Manager → Configurações → Gerar token de acesso.'
            }
          >
            <Input
              type="password"
              value={draft.meta_capi_token}
              placeholder={instance.meta_capi_token__set ? '•••••••• (mantém o atual)' : ''}
              onChange={(e) => setDraft({ ...draft, meta_capi_token: e.target.value })}
            />
          </Field>
          <Field label="Test Event Code (opcional)" hint="Usado só nas regras marcadas como teste.">
            <Input
              value={draft.meta_test_event_code}
              placeholder="TEST12345"
              onChange={(e) => setDraft({ ...draft, meta_test_event_code: e.target.value })}
            />
          </Field>
        </div>

        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setMsg(null)
              try {
                await evolutionApi.patch(instance.id, draft)
                await onSaved()
                setMsg({ tone: 'good', text: 'Pixel e token salvos para esta linha.' })
              } catch (e) {
                setMsg({ tone: 'bad', text: (e as Error).message })
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'salvando…' : 'Salvar'}
          </Button>
          <p className="text-[11px] leading-snug text-ink-500">
            O evento sai com <code className="font-mono">action_source=business_messaging</code> e o{' '}
            <code className="font-mono">ctwa_clid</code> do anúncio — é isso que faz o Meta atribuir a conversa à
            campanha.
          </p>
        </div>
      </div>
    </Card>
  )
}

/** Resultado ao vivo do simulador. */
function SimulationBanner({ result, text }: { result: SimulationResult | null; text: string }) {
  if (!text.trim()) {
    return (
      <p className="text-[11px] text-ink-500">
        Digite acima para ver, em tempo real, se essa regra dispararia o evento.
      </p>
    )
  }
  if (!result) return <p className="text-[11px] text-ink-500">testando…</p>

  if (!result.fires) {
    return (
      <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs leading-relaxed text-red-300">
        <strong>Não dispararia.</strong> {result.reason}
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-wa-500/30 bg-wa-900/30 px-3 py-2 text-xs leading-relaxed text-wa-500">
      <strong>Dispararia o evento {result.event_name}</strong>
      {result.value !== null ? ` com valor ${money(result.value, result.currency)}` : ' sem valor'}. {result.reason}{' '}
      {result.value_note}
    </div>
  )
}

function RuleEditor({
  rule,
  numberId,
  catalog,
  onChanged,
}: {
  rule: KeywordRule | null
  numberId: number
  catalog: RuleCatalog
  onChanged: () => Promise<void>
}) {
  const initial = useMemo(() => (rule ? toDraft(rule) : NEW_RULE), [rule])
  const [draft, setDraft] = useState<Draft>(initial)
  const [sample, setSample] = useState('')
  const [result, setResult] = useState<SimulationResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => setDraft(initial), [initial])

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const eventInfo = catalog.events.find((e) => e.name === draft.event_name)

  // simulação com debounce: o veredito vem do backend, a mesma função que o
  // webhook usa — o simulador não pode "achar" diferente do disparo real.
  const simulate = useCallback(
    (text: string, current: Draft) => {
      window.clearTimeout(timer.current)
      if (!text.trim()) {
        setResult(null)
        return
      }
      timer.current = window.setTimeout(() => {
        void rulesApi
          .simulate({
            text,
            keyword: current.keyword,
            match_mode: current.match_mode,
            rule_direction: current.direction,
            value_mode: current.value_mode,
            value_fixed: current.value_fixed,
            currency: current.currency,
            event_name: current.event_name,
            active: current.active,
          })
          .then(setResult)
          .catch(() => setResult(null))
      }, 250)
    },
    [],
  )

  useEffect(() => {
    simulate(sample, draft)
    return () => window.clearTimeout(timer.current)
  }, [sample, draft, simulate])

  const patch = (change: Partial<Draft>) => setDraft({ ...draft, ...change })

  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      const payload = { ...draft, keyword: draft.keyword.trim() }
      if (rule) await rulesApi.patch(rule.id, payload)
      else await rulesApi.create({ ...payload, wa_number_id: numberId })
      await onChanged()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!rule) {
      await onChanged()
      return
    }
    if (!window.confirm(`Remover a regra “${rule.keyword}”?`)) return
    setBusy(true)
    try {
      await rulesApi.remove(rule.id)
      await onChanged()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-ink-800 bg-ink-950/60 p-4">
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Field label="Evento">
            <Select value={draft.event_name} onChange={(e) => patch({ event_name: e.target.value })}>
              {catalog.events.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.label}
                  {e.accepts_value ? ' (aceita valor)' : ''}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <TrashButton onClick={() => void remove()} title="remover regra" />
      </div>

      <Field label="Palavra-chave" hint="O termo que aparece na mensagem para o evento disparar.">
        <Input
          value={draft.keyword}
          placeholder="Agradecemos a confiança"
          onChange={(e) => patch({ keyword: e.target.value })}
        />
      </Field>

      <RadioGroup
        name={`match-${rule?.id ?? 'novo'}`}
        value={draft.match_mode}
        options={catalog.match_modes}
        onChange={(v) => patch({ match_mode: v as Draft['match_mode'] })}
      />

      <div className="space-y-2 border-t border-ink-800 pt-3">
        <span className="block text-xs font-medium text-ink-300">
          Valor {eventInfo?.accepts_value ? '(opcional)' : '(o evento escolhido normalmente não usa valor)'}
        </span>
        <RadioGroup
          name={`value-${rule?.id ?? 'novo'}`}
          value={draft.value_mode}
          options={catalog.value_modes}
          onChange={(v) => patch({ value_mode: v as Draft['value_mode'] })}
        />
        {draft.value_mode === 'fixed' && (
          <div className="grid max-w-xs gap-3 pt-1">
            <Field label="Valor fixo">
              <Input
                type="number"
                step="0.01"
                value={draft.value_fixed ?? ''}
                placeholder="250.00"
                onChange={(e) => patch({ value_fixed: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </Field>
          </div>
        )}
      </div>

      <div className="space-y-3 border-t border-ink-800 pt-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-ink-300">🧪 Simular mensagem enviada</span>
          <Info text="Roda a mesma verificação do rastreio real, sem enviar nada e sem gravar lead." />
        </div>
        <p className="text-[11px] text-ink-500">
          Simule o que {catalog.directions.find((d) => d.value === draft.direction)?.label.toLowerCase() ?? 'o atendente'}{' '}
          enviaria no chat.
        </p>
        <Textarea
          rows={3}
          value={sample}
          placeholder="Digite ou cole uma mensagem para testar se esta regra dispararia o evento…"
          onChange={(e) => setSample(e.target.value)}
        />
        <SimulationBanner result={result} text={sample} />
      </div>

      <details className="rounded-lg border border-ink-800 bg-ink-850">
        <summary className="cursor-pointer px-3 py-2 text-xs text-ink-300">Opções avançadas</summary>
        <div className="space-y-3 px-3 pb-3 pt-1">
          <Field label="Quem precisa escrever a palavra-chave">
            <Select value={draft.direction} onChange={(e) => patch({ direction: e.target.value as Draft['direction'] })}>
              {catalog.directions.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>
          <Toggle
            checked={draft.require_attribution}
            onChange={(v) => patch({ require_attribution: v })}
            label="Só disparar para lead vindo de anúncio (com ctwa_clid)"
          />
          <Toggle
            checked={draft.once_per_contact}
            onChange={(v) => patch({ once_per_contact: v })}
            label="No máximo um disparo por lead"
          />
          <Toggle
            checked={draft.is_test}
            onChange={(v) => patch({ is_test: v })}
            label="Modo teste (usa o Test Event Code — aparece em Test Events e não afeta otimização)"
          />
          <Toggle checked={draft.active} onChange={(v) => patch({ active: v })} label="Regra ativa" />
        </div>
      </details>

      {err && <Banner tone="bad">{err}</Banner>}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="sm" disabled={busy || !dirty || !draft.keyword.trim()} onClick={save}>
          {busy ? 'salvando…' : rule ? 'Salvar regra' : 'Criar regra'}
        </Button>
        {dirty && <Badge tone="warn">alterações não salvas</Badge>}
        {rule && (
          <span className="text-[11px] text-ink-500">
            {rule.hits} disparo(s)
            {rule.last_fired_at ? ` · último em ${when(rule.last_fired_at)}` : ''}
          </span>
        )}
        {rule && !rule.active && <Badge tone="warn">inativa</Badge>}
      </div>
    </div>
  )
}

export default function Tracking({ onChanged }: { onChanged: () => void }) {
  const { numberId, current, numbers, reload, loading } = useNumber()
  const [catalog, setCatalog] = useState<RuleCatalog | null>(null)
  const [rules, setRules] = useState<KeywordRule[]>([])
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void rulesApi.catalog().then(setCatalog).catch((e) => setErr((e as Error).message))
  }, [])

  const loadRules = useCallback(async () => {
    if (numberId === undefined) {
      setRules([])
      return
    }
    setRules(await rulesApi.list(numberId))
  }, [numberId])

  useEffect(() => {
    void loadRules().catch((e) => setErr((e as Error).message))
  }, [loadRules])

  const refresh = async () => {
    await loadRules()
    await reload()
    onChanged()
  }

  if (loading || !catalog) return <p className="text-sm text-ink-500">carregando…</p>

  if (numbers.length === 0) {
    return (
      <Empty>
        Nenhuma linha cadastrada. Comece na aba <strong className="text-ink-300">Conexão</strong>: URL da Evolution
        API, apikey e nome da instância.
      </Empty>
    )
  }

  if (numberId === undefined || !current) {
    return <Empty>Escolha uma linha no topo da tela — Pixel, token e palavras-chave são de cada linha.</Empty>
  }

  return (
    <div className="space-y-5">
      {err && <Banner tone="bad">{err}</Banner>}

      <MetaDestination instance={current} onSaved={refresh} />

      <Card
        title="Eventos de conversão por palavra-chave"
        subtitle="Dispare eventos automaticamente quando a mensagem contiver o termo configurado."
        actions={
          <Button size="sm" variant="primary" onClick={() => setAdding(true)} disabled={adding}>
            Adicionar regra
          </Button>
        }
      >
        <div className="space-y-4">
          <p className="max-w-3xl text-xs leading-relaxed text-ink-500">
            Crie regras para disparar eventos quando o atendente responder com termos específicos. Por padrão o
            evento sai quando <strong className="text-ink-300">o atendente</strong> envia uma mensagem contendo a
            palavra-chave — é o momento em que a conversa virou atendimento de verdade, e não quando a pessoa só
            disse “oi”. Use o simulador de cada regra para conferir antes de valer no chat.
          </p>

          {rules.length === 0 && !adding && (
            <Empty>
              Nenhuma regra nesta linha. Clique em “Adicionar regra” e configure a palavra-chave que o atendente
              usa quando fecha o atendimento.
            </Empty>
          )}

          {rules.map((rule) => (
            <RuleEditor
              key={rule.id}
              rule={rule}
              numberId={numberId}
              catalog={catalog}
              onChanged={refresh}
            />
          ))}

          {adding && (
            <RuleEditor
              rule={null}
              numberId={numberId}
              catalog={catalog}
              onChanged={async () => {
                setAdding(false)
                await refresh()
              }}
            />
          )}
        </div>
      </Card>
    </div>
  )
}
