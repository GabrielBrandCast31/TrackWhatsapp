import { useEffect, useState } from 'react'

import { useNumber } from '../numberContext'
import { api, evolutionApi, type Contact, type ContactDetail, type Conversion } from '../api'
import { Badge, Banner, Button, Card, Empty, Field, Input, Json, Toggle, when } from '../ui'

function AttributionTags({ c }: { c: Contact }) {
  return (
    <div className="flex flex-wrap gap-1">
      {c.attributable_meta && <Badge tone="good">ctwa_clid</Badge>}
      {c.attribution.ad_id && <Badge tone="info">ad {c.attribution.ad_id.slice(-8)}</Badge>}
      {c.attribution.gclid && <Badge tone="warn">gclid</Badge>}
      {c.attribution.wbraid && <Badge tone="warn">wbraid</Badge>}
      {!c.attributable_meta && !c.attributable_google && <Badge>sem atribuição</Badge>}
    </div>
  )
}

function FireForm({ contact, onFired }: { contact: ContactDetail; onFired: (c: Conversion) => void }) {
  const [eventName, setEventName] = useState('Lead')
  const [value, setValue] = useState('')
  const [isTest, setIsTest] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null)

  const payload = () => ({
    contact_id: contact.id,
    event_name: eventName,
    value: value === '' ? null : Number(value),
    is_test: isTest,
    destinations: ['meta_capi'],
  })

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Nome do evento" hint="Lead, Purchase, Schedule, CompleteRegistration…">
          <Input value={eventName} onChange={(e) => setEventName(e.target.value)} />
        </Field>
        <Field label="Valor (opcional)">
          <Input type="number" placeholder="0.00" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </div>

      <p className="text-[11px] leading-snug text-ink-500">
        Destino: <strong className="text-ink-300">Meta Conversions API</strong>, com o Pixel e o token da linha
        (aba Rastreamento). Google Ads e webhook próprio continuam disponíveis na área de admin.
      </p>

      <Toggle
        checked={isTest}
        onChange={setIsTest}
        label="Modo teste (usa o test_event_code do Meta — aparece em Test Events, não afeta otimização)"
      />

      {err && <Banner tone="bad">{err}</Banner>}

      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => act(async () => onFired(await api.fire(payload())))}
        >
          {busy ? 'enviando…' : 'Disparar conversão'}
        </Button>
        <Button disabled={busy} onClick={() => act(async () => setPreview(await api.preview(payload())))}>
          Ver payload
        </Button>
      </div>

      {preview && (
        <div className="space-y-2">
          <p className="text-xs text-ink-500">Payload que sairia (nada foi enviado):</p>
          <Json value={preview} max={280} />
        </div>
      )}
    </div>
  )
}

export default function Leads({ onChanged }: { onChanged: () => void }) {
  const { numberId, current } = useNumber()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [onlyAttributed, setOnlyAttributed] = useState(false)
  const [selected, setSelected] = useState<ContactDetail | null>(null)
  const [simOpen, setSimOpen] = useState(false)
  const [sim, setSim] = useState({
    wa_id: '5511988887777',
    name: 'Lead de Teste',
    text: 'Olá! Vim pelo anúncio.',
    ctwa_clid: `ARAySIM${Math.random().toString(36).slice(2, 12)}`,
    ad_id: '120210000000000000',
    source_url: 'https://fb.me/simulado?utm_source=meta&utm_campaign=teste',
  })
  const [flash, setFlash] = useState<string | null>(null)

  const load = async () => setContacts(await api.contacts(onlyAttributed, numberId))
  useEffect(() => {
    void load()
  }, [onlyAttributed, numberId])

  const open = async (id: number) => setSelected(await api.contact(id))

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
      <Card
        title="Leads do WhatsApp"
        subtitle={`${contacts.length} contato(s) em ${
          current?.label ?? 'todas as linhas'
        }. A atribuição chega junto com a primeira mensagem depois do clique.`}
        actions={
          <>
            <Button size="sm" onClick={() => setSimOpen(!simOpen)}>
              Simular lead
            </Button>
            <Button size="sm" onClick={() => void load()}>
              atualizar
            </Button>
          </>
        }
      >
        <div className="mb-4">
          <Toggle checked={onlyAttributed} onChange={setOnlyAttributed} label="Só com atribuição" />
        </div>

        {simOpen && (
          <div className="mb-4 space-y-3 rounded-lg border border-ink-800 bg-ink-850 p-4">
            <p className="text-xs leading-relaxed text-ink-500">
              Injeta um payload idêntico ao da Evolution API, com{' '}
              <code className="font-mono">contextInfo.externalAdReply.ctwaClid</code>. Valida o fluxo inteiro sem
              precisar de anúncio no ar. O lead entra em{' '}
              <strong className="text-ink-100">{current?.label ?? 'linha padrão'}</strong>.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="wa_id">
                <Input value={sim.wa_id} onChange={(e) => setSim({ ...sim, wa_id: e.target.value })} />
              </Field>
              <Field label="Nome">
                <Input value={sim.name} onChange={(e) => setSim({ ...sim, name: e.target.value })} />
              </Field>
              <Field label="ctwa_clid">
                <Input value={sim.ctwa_clid} onChange={(e) => setSim({ ...sim, ctwa_clid: e.target.value })} />
              </Field>
              <Field label="Ad ID">
                <Input value={sim.ad_id} onChange={(e) => setSim({ ...sim, ad_id: e.target.value })} />
              </Field>
            </div>
            <Field label="Mensagem" hint="Um gclid=... no texto também é capturado (link do wa.me montado pela landing).">
              <Input value={sim.text} onChange={(e) => setSim({ ...sim, text: e.target.value })} />
            </Field>
            <Button
              variant="primary"
              size="sm"
              disabled={numberId === undefined}
              onClick={async () => {
                if (numberId === undefined) return
                await evolutionApi.simulate(numberId, sim)
                setFlash('Lead simulado criado.')
                setTimeout(() => setFlash(null), 2000)
                await load()
                onChanged()
              }}
            >
              Criar lead simulado
            </Button>
            {flash && <Banner tone="good">{flash}</Banner>}
          </div>
        )}

        {contacts.length === 0 ? (
          <Empty>Nenhum lead ainda. Use “Simular lead” ou aguarde uma mensagem real.</Empty>
        ) : (
          <ul className="divide-y divide-ink-800">
            {contacts.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => void open(c.id)}
                  className={`w-full px-1 py-3 text-left transition-colors hover:bg-ink-850 ${
                    selected?.id === c.id ? 'bg-ink-850' : ''
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium text-ink-100">{c.name ?? c.wa_id}</span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-500">{c.phone_e164}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-ink-500">{c.first_message ?? '—'}</p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <AttributionTags c={c} />
                    {c.conversions > 0 && <Badge tone="info">{c.conversions} conv.</Badge>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {selected ? (
        <div className="space-y-5">
          <Card title={selected.name ?? selected.wa_id} subtitle={`Visto por último em ${when(selected.last_seen_at)}`}>
            <Json value={selected.attribution} max={220} />
          </Card>

          <Card title="Disparar evento de conversão">
            <FireForm
              contact={selected}
              onFired={async (conv) => {
                setSelected(await api.contact(selected.id))
                onChanged()
                setFlash(`Conversão #${conv.id} disparada.`)
                setTimeout(() => setFlash(null), 2500)
              }}
            />
          </Card>

          <Card title="Conversa" subtitle={`${selected.messages.length} mensagem(ns)`}>
            {selected.messages.length === 0 ? (
              <Empty>Sem mensagens.</Empty>
            ) : (
              <ul className="space-y-2">
                {selected.messages.map((m) => {
                  const outbound = m.direction === 'out'
                  return (
                    <li
                      key={m.id}
                      className={`rounded-lg border px-3 py-2 ${
                        outbound
                          ? 'ml-8 border-wa-500/25 bg-wa-900/20'
                          : 'mr-8 border-ink-800 bg-ink-850'
                      }`}
                    >
                      <p className="text-sm text-ink-100">{m.body ?? `[${m.type}]`}</p>
                      <p className="mt-1 flex items-center gap-2 font-mono text-[11px] text-ink-500">
                        <span>{outbound ? 'atendente' : 'cliente'}</span>
                        <span>{when(m.sent_at)}</span>
                      </p>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </div>
      ) : (
        <Card title="Detalhe do lead">
          <Empty>Selecione um lead à esquerda.</Empty>
        </Card>
      )}
    </div>
  )
}
