import { useEffect, useState, type ReactNode } from 'react'

import { when } from '../ui'
import { contactFormResponses } from './client'

type Row = Awaited<ReturnType<typeof contactFormResponses>>[number]

/** No painel do contato do CRM: o que ele respondeu no formulário. Sem resposta, some. */
export function ContactFormAnswers({ contactId, render }: { contactId: number; render: (body: ReactNode) => ReactNode }) {
  const [rows, setRows] = useState<Row[]>([])

  useEffect(() => {
    contactFormResponses(contactId).then(setRows).catch(() => setRows([]))
  }, [contactId])

  if (rows.length === 0) return null
  return (
    <>
      {render(
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2">
              <p className="text-[11px] text-ink-500">
                {r.form_title} · {when(r.created_at)}
              </p>
              <dl className="mt-1.5 space-y-1">
                {r.answers.map((a) => (
                  <div key={a.label}>
                    <dt className="text-[10.5px] uppercase tracking-wide text-ink-500">{a.label}</dt>
                    <dd className="text-[12.5px] text-ink-100">{a.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>,
      )}
    </>
  )
}
