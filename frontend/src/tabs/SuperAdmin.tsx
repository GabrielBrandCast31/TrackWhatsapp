import { useCallback, useEffect, useState } from 'react'

import { superApi, type SuperLine, type SuperOverview, type SuperSettings } from '../api'
import { useAuth } from '../authContext'
import { Badge, Banner, Button, Card, Empty, Field, Input, Select, Toggle, when } from '../ui'

/** De quanto em quanto tempo a visão geral se atualiza sozinha. */
const REFRESH_MS = 30_000

type Filter = 'all' | 'down' | 'up'

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' }) {
  const color = tone === 'good' ? 'text-wa-500' : tone === 'bad' && value > 0 ? 'text-red-300' : 'text-ink-100'
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900 px-3.5 py-2.5">
      <p className="truncate text-[10px] uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  )
}

function StatusBadge({ line }: { line: SuperLine }) {
  if (!line.active) return <Badge>pausada</Badge>
  if (line.connected) return <Badge tone="good">conectada</Badge>
  return <Badge tone="bad">fora do ar</Badge>
}

/** 5511999998888 -> +55 11 99999-8888, só pra leitura. */
function prettyPhone(digits: string) {
  const m = digits.match(/^55(\d{2})(\d{4,5})(\d{4})$/)
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : `+${digits}`
}

/** Só o dono da plataforma chega aqui (o backend confere de novo em cada rota). */
export default function SuperAdmin() {
  const { isSuper } = useAuth()
  const [data, setData] = useState<SuperOverview | null>(null)
  const [settings, setSettings] = useState<SuperSettings | null>(null)
  const [form, setForm] = useState<SuperSettings | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const loadOverview = useCallback(async () => {
    try {
      setData(await superApi.overview())
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (!isSuper) return
    void loadOverview()
    void superApi
      .settings()
      .then((s) => {
        setSettings(s)
        setForm(s)
      })
      .catch((e) => setErr((e as Error).message))
    const timer = setInterval(() => void loadOverview(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [isSuper, loadOverview])

  if (!isSuper) return <Banner tone="warn">Área restrita ao super admin.</Banner>

  const dirty =
    !!form &&
    !!settings &&
    (form.report_phone !== settings.report_phone ||
      form.sender_number_id !== settings.sender_number_id ||
      form.daily_enabled !== settings.daily_enabled ||
      form.daily_time !== settings.daily_time ||
      form.alert_on_disconnect !== settings.alert_on_disconnect)

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    setErr(null)
    setMsg(null)
    try {
      setMsg(await fn())
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<SuperSettings> => {
    const saved = await superApi.saveSettings({
      report_phone: form!.report_phone,
      sender_number_id: form!.sender_number_id,
      daily_enabled: form!.daily_enabled,
      daily_time: form!.daily_time,
      alert_on_disconnect: form!.alert_on_disconnect,
    })
    setSettings(saved)
    setForm(saved)
    return saved
  }

  const sendNow = () =>
    run(async () => {
      // o que está digitado é o que vale: salva antes pra não enviar pro número antigo
      if (dirty) await save()
      const res = await superApi.send()
      setSettings(res.settings)
      setForm(res.settings)
      return `Relatório enviado para ${prettyPhone(res.to)} pela linha ${res.sender_label}.`
    })

  const togglePreview = async () => {
    if (preview !== null) return setPreview(null)
    try {
      setPreview((await superApi.preview()).text)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const t = data?.totals
  const senders = (data?.lines ?? []).filter((l) => l.channel === 'evolution' && l.active)
  const rows = (data?.lines ?? []).filter((l) =>
    filter === 'all' ? true : filter === 'down' ? l.active && !l.connected : l.active && l.connected,
  )

  return (
    <div className="space-y-5">
      {err && <Banner tone="bad">{err}</Banner>}
      {msg && <Banner tone="good">{msg}</Banner>}

      {t && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <Tile label="Clientes ativos" value={t.active} />
          <Tile label="Conectados" value={t.connected} tone="good" />
          <Tile label="Fora do ar" value={t.disconnected} tone="bad" />
          <Tile label="Leads hoje" value={t.leads_today} />
          <Tile label="Leads em 7 dias" value={t.leads_7d} />
          <Tile label="Leads no total" value={t.leads_total} />
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title="Relatório no WhatsApp" subtitle="A visão geral de todos os clientes, enviada para o seu número">
          {!form ? (
            <p className="text-xs text-ink-500">carregando…</p>
          ) : (
            <div className="space-y-4">
              <Field
                label="Número que recebe"
                hint="Seu WhatsApp pessoal ou qualquer outro. Com DDD; o 55 entra sozinho. Vazio desliga os envios."
              >
                <Input
                  inputMode="tel"
                  placeholder="11 99999-8888"
                  value={form.report_phone}
                  onChange={(e) => setForm({ ...form, report_phone: e.target.value })}
                />
              </Field>

              <Field
                label="Linha que envia"
                hint="Precisa ser uma linha da Evolution diferente do número que recebe. Se ela cair, sai pela primeira conectada."
              >
                <Select
                  value={form.sender_number_id ?? ''}
                  onChange={(e) =>
                    setForm({ ...form, sender_number_id: e.target.value ? Number(e.target.value) : null })
                  }
                >
                  <option value="">Automático — primeira linha conectada</option>
                  {senders.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                      {l.phone ? ` · ${l.phone}` : ''}
                      {l.connected ? '' : ' (fora do ar)'}
                    </option>
                  ))}
                </Select>
              </Field>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <Toggle
                  checked={form.daily_enabled}
                  onChange={(v) => setForm({ ...form, daily_enabled: v })}
                  label="Enviar todo dia às"
                />
                <div className="w-28">
                  <Input
                    type="time"
                    aria-label="Horário do relatório diário"
                    value={form.daily_time}
                    disabled={!form.daily_enabled}
                    onChange={(e) => setForm({ ...form, daily_time: e.target.value })}
                  />
                </div>
              </div>

              <Toggle
                checked={form.alert_on_disconnect}
                onChange={(v) => setForm({ ...form, alert_on_disconnect: v })}
                label="Avisar na hora quando um cliente cair ou reconectar"
              />

              <div className="flex flex-wrap items-center gap-2 border-t border-ink-800 pt-4">
                <Button
                  variant="primary"
                  disabled={busy || !dirty}
                  onClick={() => void run(async () => (await save(), 'Configuração salva.'))}
                >
                  Salvar
                </Button>
                <Button disabled={busy || !form.report_phone.trim()} onClick={() => void sendNow()}>
                  Enviar agora
                </Button>
                <Button onClick={() => void togglePreview()}>{preview === null ? 'Ver mensagem' : 'Esconder'}</Button>
              </div>

              <p className="text-[11px] text-ink-500">
                {settings?.last_sent_at ? `Último envio: ${when(settings.last_sent_at)}.` : 'Nenhum relatório enviado ainda.'}
                {settings?.last_error && <span className="text-red-300"> Última falha: {settings.last_error}</span>}
              </p>

              {preview !== null && (
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-ink-800 bg-ink-950 p-3 text-xs leading-relaxed text-ink-300">
                  {preview}
                </pre>
              )}
            </div>
          )}
        </Card>

        <Card
          title="Clientes"
          subtitle={data ? `${data.totals.lines} linha(s) · atualizado ${when(data.generated_at)}` : 'carregando…'}
          actions={
            <div className="w-36">
              <Select aria-label="Filtrar clientes" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                <option value="all">Todos</option>
                <option value="down">Fora do ar</option>
                <option value="up">Conectados</option>
              </Select>
            </div>
          }
        >
          {!data ? (
            <p className="text-xs text-ink-500">carregando…</p>
          ) : rows.length === 0 ? (
            <Empty>
              {data.lines.length === 0 ? 'Nenhuma linha cadastrada ainda.' : 'Nenhum cliente neste filtro.'}
            </Empty>
          ) : (
            <ul className="divide-y divide-ink-800">
              {rows.map((l) => (
                <li key={l.id} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-ink-100">
                      <span className="truncate font-medium">{l.label}</span>
                      <StatusBadge line={l} />
                      {l.channel === 'cloud' && <Badge tone="info">cloud api</Badge>}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-ink-500">
                      {[
                        l.phone,
                        l.profile_name,
                        l.users.length ? `acesso: ${l.users.join(', ')}` : 'sem usuário de operação',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {l.active && !l.connected && (
                      <p className="mt-1 break-words text-[11px] text-red-300">
                        {l.last_error || (l.state ? `estado: ${l.state}` : 'sem resposta da instância')}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm tabular-nums text-ink-100">
                      {l.leads_today} <span className="text-[11px] text-ink-500">hoje</span>
                      <span className="mx-1.5 text-ink-700">·</span>
                      {l.leads_7d} <span className="text-[11px] text-ink-500">7 dias</span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-500">
                      {l.last_message_at ? `última conversa ${when(l.last_message_at)}` : 'sem conversa ainda'}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
