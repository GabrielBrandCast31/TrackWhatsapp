import { useEffect, useState } from 'react'

import { useNumber } from '../numberContext'
import { api, DESTINATION_LABEL, type Conversion, type Dispatch } from '../api'
import { Badge, Button, Card, Copy, Empty, Json, when } from '../ui'

function Payload({ label, value, empty }: { label: string; value: Record<string, unknown>; empty: string }) {
  const hasData = value && Object.keys(value).length > 0
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[11px] uppercase tracking-wide text-ink-500">{label}</p>
        {hasData && <Copy text={JSON.stringify(value, null, 2)} />}
      </div>
      {hasData ? <Json value={value} max={480} /> : <p className="text-[11px] italic text-ink-500">{empty}</p>}
    </div>
  )
}

function DispatchRow({
  d,
  busy,
  onResend,
}: {
  d: Dispatch
  busy: boolean
  onResend: (force: boolean) => void
}) {
  const tone = d.status === 'ok' ? 'good' : d.status === 'error' ? 'bad' : 'neutral'
  // erro sem resposta = barrado pela checagem local, o Meta nem foi chamado
  const blockedLocally = d.status === 'error' && d.destination === 'meta_capi' && !Object.keys(d.response_body ?? {}).length
  return (
    <details className="rounded-lg border border-ink-800 bg-ink-850">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
        <span className="text-xs font-medium text-ink-100">{DESTINATION_LABEL[d.destination] ?? d.destination}</span>
        <Badge tone={tone}>{d.status}</Badge>
        {d.http_status !== null && <Badge>HTTP {d.http_status}</Badge>}
        {d.error && <span className="flex-1 truncate text-[11px] text-red-300">{d.error}</span>}
      </summary>
      <div className="space-y-3 px-3 pb-3">
        {d.error && (
          <p className="rounded-md border border-red-900/50 bg-red-950/30 px-2.5 py-2 text-[11px] leading-relaxed text-red-300">
            {d.error}
          </p>
        )}
        <div className="grid gap-3 lg:grid-cols-2">
          <Payload
            label="request"
            value={d.request_payload}
            empty="Nada foi montado — o erro aconteceu antes de gerar o payload."
          />
          <Payload
            label={d.http_status !== null ? `response · HTTP ${d.http_status}` : 'response'}
            value={d.response_body}
            empty="Sem resposta do destino — a requisição não chegou a ser feita."
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => onResend(false)}>
            {busy ? 'enviando…' : 'reenviar este destino'}
          </Button>
          {blockedLocally && (
            <>
              <Button size="sm" disabled={busy} onClick={() => onResend(true)}>
                enviar pro Meta mesmo assim
              </Button>
              <span className="text-[11px] text-ink-500">pula a checagem local e mostra a resposta real do Meta</span>
            </>
          )}
        </div>
      </div>
    </details>
  )
}

export default function Conversions({ onChanged }: { onChanged: () => void }) {
  const { numberId, current } = useNumber()
  const [rows, setRows] = useState<Conversion[]>([])
  const [busy, setBusy] = useState<number | null>(null)
  const [busyDispatch, setBusyDispatch] = useState<number | null>(null)

  const resend = async (c: Conversion, d: Dispatch, force: boolean) => {
    setBusyDispatch(d.id)
    try {
      await api.retry(c.id, { destinations: [d.destination], force })
      await load()
      onChanged()
    } finally {
      setBusyDispatch(null)
    }
  }

  const load = async () => setRows(await api.conversions(numberId))
  useEffect(() => {
    void load()
  }, [numberId])

  return (
    <Card
      title="Eventos de conversão enviados"
      subtitle={`${
        current?.label ?? 'Todas as linhas'
      } — cada disparo guarda o payload que saiu e a resposta do destino.`}
      actions={
        <Button size="sm" onClick={() => void load()}>
          atualizar
        </Button>
      }
    >
      {rows.length === 0 ? (
        <Empty>Nenhuma conversão disparada ainda. Vá em Leads, escolha um contato e dispare.</Empty>
      ) : (
        <ul className="space-y-3">
          {rows.map((c) => {
            const failed = c.dispatches.filter((d) => d.status === 'error').length
            return (
              <li key={c.id} className="rounded-xl border border-ink-800 bg-ink-950/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-ink-100">{c.event_name}</span>
                    {c.source === 'rule' && <Badge tone="good">palavra-chave</Badge>}
                    {c.source === 'auto' && <Badge tone="info">automático</Badge>}
                    {c.is_test && <Badge tone="warn">teste</Badge>}
                    {c.value !== null && (
                      <Badge tone="info">
                        {c.value.toLocaleString('pt-BR', { style: 'currency', currency: c.currency })}
                      </Badge>
                    )}
                    <span className="text-xs text-ink-500">
                      {c.contact?.name ?? c.contact?.wa_id ?? `contato #${c.contact_id}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-ink-500">{when(c.created_at)}</span>
                    {failed > 0 && (
                      <Button
                        size="sm"
                        disabled={busy === c.id}
                        onClick={async () => {
                          setBusy(c.id)
                          try {
                            await api.retry(c.id)
                            await load()
                            onChanged()
                          } finally {
                            setBusy(null)
                          }
                        }}
                      >
                        {busy === c.id ? 'reenviando…' : `reenviar ${failed} falha(s)`}
                      </Button>
                    )}
                  </div>
                </div>

                <p className="mt-1 font-mono text-[11px] text-ink-500">event_id: {c.event_id}</p>

                <div className="mt-3 space-y-2">
                  {c.dispatches.map((d) => (
                    <DispatchRow
                      key={d.id}
                      d={d}
                      busy={busyDispatch === d.id}
                      onResend={(force) => void resend(c, d, force)}
                    />
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
