import { useState } from 'react'

import { crmApi, type MessagePayload } from './api'
import { Badge, Copy, Json, when } from './ui'

/** "Payload" dentro da bolha da mensagem: o que chegou de verdade quando o
 *  cliente mandou aquela mensagem.
 *
 *  Duas camadas, porque respondem perguntas diferentes:
 *
 *  * **mensagem** — o objeto cru do WhatsApp (`key`, `message`, `contextInfo`).
 *    É onde mora o `externalAdReply` com o `ctwaClid`: quando um lead do anúncio
 *    aparece sem atribuição, é aqui que se vê se o bloco veio ou não;
 *  * **POST do webhook** — o corpo inteiro que a Evolution entregou, com envelope
 *    (`event`, `instance`, `date_time`) e o lote todo.
 *
 *  A busca é sob demanda: anexo carrega miniatura em base64, e mandar isso junto
 *  com as 300 mensagens da conversa deixaria a tela pesada sem motivo.
 */
export function MessagePayloadToggle({ messageId }: { messageId: number }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<MessagePayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (data !== null || loading) return // já buscado: não pede de novo
    setLoading(true)
    setError(null)
    crmApi
      .messagePayload(messageId)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        className="font-mono text-[11px] text-ink-500 underline decoration-dotted underline-offset-2 transition hover:text-ink-300"
      >
        {open ? 'ocultar payload' : 'payload'}
      </button>

      {open && (
        // `basis-full` porque o botao vive na linha de metadados da bolha, que e
        // um flex: sem isso o JSON viraria uma coluna estreita ao lado da data.
        <div className="mt-2 w-full basis-full space-y-3">
          {loading && <p className="font-mono text-[11px] text-ink-500">carregando payload…</p>}
          {error && <p className="font-mono text-[11px] text-red-300">{error}</p>}

          {data && (
            <>
              <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-500">
                <Badge tone="neutral">{data.type ?? 'sem tipo'}</Badge>
                {data.wamid && <span className="break-all">{data.wamid}</span>}
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-ink-300">Mensagem (objeto cru)</span>
                  <Copy text={JSON.stringify(data.raw, null, 2)} />
                </div>
                <Json value={data.raw} max={300} />
              </div>

              {data.webhook ? (
                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-ink-300">
                      POST do webhook #{data.webhook.id}
                    </span>
                    <Copy text={JSON.stringify(data.webhook.payload, null, 2)} />
                  </div>
                  <p className="mb-1 font-mono text-[11px] text-ink-500">
                    {when(data.webhook.created_at)}
                    {data.webhook.instance ? ` · ${data.webhook.instance}` : ''}
                    {data.webhook.summary ? ` — ${data.webhook.summary}` : ''}
                  </p>
                  <Json value={data.webhook.payload} max={340} />
                </div>
              ) : (
                <p className="text-[11px] leading-relaxed text-ink-500">
                  Sem POST guardado: ou a mensagem veio do <em>puxar histórico</em> (buscada na Evolution, não
                  entregue por ela), ou chegou antes desta tela existir. O objeto cru acima é o que há dela.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </>
  )
}
