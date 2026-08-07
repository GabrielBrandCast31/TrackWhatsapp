import { useEffect, useState } from 'react'

import { api, DESTINATION_LABEL, type Conversion, type Dispatch } from '../api'
import { Badge, Button, Card, Empty, Json, when } from '../ui'

function DispatchRow({ d }: { d: Dispatch }) {
  const tone = d.status === 'ok' ? 'good' : d.status === 'error' ? 'bad' : 'neutral'
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
        <div>
          <p className="mb-1 text-[11px] uppercase tracking-wide text-ink-500">request</p>
          <Json value={d.request_payload} max={240} />
        </div>
        <div>
          <p className="mb-1 text-[11px] uppercase tracking-wide text-ink-500">response</p>
          <Json value={d.response_body} max={200} />
        </div>
      </div>
    </details>
  )
}

export default function Conversions({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<Conversion[]>([])
  const [busy, setBusy] = useState<number | null>(null)

  const load = async () => setRows(await api.conversions())
  useEffect(() => {
    void load()
  }, [])

  return (
    <Card
      title="Eventos de conversão enviados"
      subtitle="Cada disparo guarda o payload que saiu e a resposta de cada destino."
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
                    <DispatchRow key={d.id} d={d} />
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
