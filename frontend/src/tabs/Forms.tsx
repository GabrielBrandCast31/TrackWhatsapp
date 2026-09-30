import { useCallback, useEffect, useMemo, useState } from 'react'

import { deleteForm, listForms, updateForm, type FormLine, type LeadForm } from '../forms/client'
import { FormAiModal } from '../forms/FormAiModal'
import { FormEditorModal } from '../forms/FormEditorModal'
import { FormResponsesModal } from '../forms/FormResponsesModal'
import {
  Check,
  ClipboardList,
  Copy,
  ExternalLink,
  ImageIcon,
  Inbox,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
} from '../forms/icons'
import { useNumber } from '../numberContext'
import { Banner } from '../ui'

/** Formulários de captação: páginas /f/{slug} no mesmo domínio do painel, usadas
 *  como destino das campanhas. Cada resposta vira conversa no CRM da linha. */
export default function Forms() {
  const { numbers, numberId } = useNumber()
  const [forms, setForms] = useState<LeadForm[]>([])
  const [editing, setEditing] = useState<LeadForm | 'new' | null>(null)
  const [viewing, setViewing] = useState<LeadForm | null>(null)
  const [copied, setCopied] = useState(0)
  const [q, setQ] = useState('')
  const [aiOpen, setAiOpen] = useState(false)
  // rascunho da IA: abre o editor pré-preenchido, sem salvar nada antes da revisão
  const [draft, setDraft] = useState<Partial<LeadForm> | null>(null)
  const [error, setError] = useState<string | null>(null)

  const lines: FormLine[] = useMemo(() => numbers.map((n) => ({ id: n.id, name: n.label })), [numbers])

  const load = useCallback(() => {
    listForms(numberId)
      .then((r) => {
        setForms(r.forms)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [numberId])

  useEffect(load, [load])

  const linkOf = (f: LeadForm) => `${window.location.origin}/f/${f.slug}`
  const copiar = async (f: LeadForm) => {
    try {
      await navigator.clipboard.writeText(linkOf(f))
      setCopied(f.id)
      setTimeout(() => setCopied(0), 2000)
    } catch {
      window.prompt('Copie o link:', linkOf(f))
    }
  }
  const toggleAtivo = async (f: LeadForm) => {
    await updateForm(f.id, { active: !f.active })
    load()
  }
  const remover = async (f: LeadForm) => {
    if (window.confirm(`Excluir "${f.title}" e todas as respostas?`)) {
      await deleteForm(f.id)
      load()
    }
  }

  const visiveis = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return forms
    return forms.filter((f) => `${f.title} ${f.headline} ${f.number_label || ''}`.toLowerCase().includes(t))
  }, [forms, q])

  const totais = useMemo(
    () => forms.reduce((a, f) => ({ views: a.views + f.views, leads: a.leads + f.responses }), { views: 0, leads: 0 }),
    [forms],
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
        <p className="max-w-2xl text-xs leading-relaxed text-ink-500">
          Páginas de captação para as campanhas, publicadas em{' '}
          <span className="font-mono text-ink-300">{window.location.host}/f/…</span> — as respostas viram conversas no CRM
          da linha, com a jornada da campanha ligada.
          {forms.length > 0 && ` ${totais.views} visitas · ${totais.leads} leads.`}
        </p>
        <div className="flex items-center gap-2">
          {forms.length > 3 && (
            <div className="relative hidden md:block">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar formulário…"
                className="w-52 rounded-lg border border-ink-700 bg-ink-950 py-2 pl-9 pr-3 text-sm text-ink-100 outline-none focus:border-wa-500"
              />
            </div>
          )}
          <button
            onClick={() => setAiOpen(true)}
            disabled={lines.length === 0}
            className="inline-flex items-center gap-2 rounded-lg border border-wa-500/40 bg-wa-500/10 px-3.5 py-2 text-sm font-semibold text-wa-500 hover:bg-wa-500/20 disabled:opacity-40"
          >
            <Sparkles className="size-4" /> Gerar com IA
          </button>
          <button
            onClick={() => {
              setDraft(null)
              setEditing('new')
            }}
            disabled={lines.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-wa-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-wa-600 disabled:opacity-40"
          >
            <Plus className="size-4" /> Novo formulário
          </button>
        </div>
      </div>

      {error && <Banner tone="bad">{error}</Banner>}
      {lines.length === 0 && <Banner tone="warn">Cadastre uma linha em Conexão antes: o formulário entrega os leads no CRM dela.</Banner>}

      {forms.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-ink-700 p-14 text-center">
          <ClipboardList className="size-7 text-ink-600" />
          <p className="max-w-md text-sm text-ink-400">
            Nenhum formulário ainda. Gere um a partir de um método de qualificação (BANT, CHAMP, SPIN…) ou monte do zero —
            o link vira o destino da campanha.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={() => setAiOpen(true)}
              disabled={lines.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-wa-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-wa-600 disabled:opacity-40"
            >
              <Sparkles className="size-4" /> Gerar com IA
            </button>
            <button
              onClick={() => {
                setDraft(null)
                setEditing('new')
              }}
              disabled={lines.length === 0}
              className="inline-flex items-center gap-2 rounded-lg border border-ink-700 px-4 py-2 text-sm font-medium text-ink-400 hover:text-ink-100 disabled:opacity-40"
            >
              <Plus className="size-4" /> Criar do zero
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visiveis.map((f) => {
            const conv = f.views > 0 ? (f.responses / f.views) * 100 : 0
            return (
              <article
                key={f.id}
                className={`flex flex-col rounded-2xl border bg-ink-900 p-5 transition-colors ${
                  f.active ? 'border-ink-800 hover:border-wa-500/40' : 'border-ink-800 opacity-60'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div
                      className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-ink-800"
                      style={{ background: f.theme.bg }}
                    >
                      {f.logo_url ? (
                        <img src={f.logo_url} alt="" className="max-h-7 max-w-8 object-contain" />
                      ) : (
                        <ImageIcon className="size-4" style={{ color: f.theme.primary }} />
                      )}
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold text-ink-100">{f.title}</h3>
                      <p className="truncate text-[11px] text-ink-500">
                        {f.number_label ? `${f.number_label} · ` : ''}
                        {f.fields.length} pergunta(s)
                        {f.settings.layout === 'page' ? ' · página única' : ''}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => void toggleAtivo(f)}
                    className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold ${
                      f.active ? 'bg-wa-500/15 text-wa-500' : 'bg-white/10 text-ink-400'
                    }`}
                  >
                    {f.active ? 'No ar' : 'Pausado'}
                  </button>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-ink-950/50 py-2">
                    <div className="font-mono text-sm font-bold text-ink-100">{f.views}</div>
                    <div className="text-[9px] uppercase text-ink-500">Visitas</div>
                  </div>
                  <div className="rounded-lg bg-ink-950/50 py-2">
                    <div className="font-mono text-sm font-bold text-wa-500">{f.responses}</div>
                    <div className="text-[9px] uppercase text-ink-500">Leads</div>
                  </div>
                  <div className="rounded-lg bg-ink-950/50 py-2">
                    <div className="font-mono text-sm font-bold text-wa-400">{conv.toFixed(0)}%</div>
                    <div className="text-[9px] uppercase text-ink-500">Conversão</div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => setEditing(f)}
                    className="inline-flex items-center gap-1 rounded-md border border-ink-700 px-2 py-1.5 text-xs font-medium text-ink-200 hover:bg-white/5"
                  >
                    <Settings2 className="size-3.5" /> Configurar
                  </button>
                  <button
                    onClick={() => setViewing(f)}
                    className="inline-flex items-center gap-1 rounded-md border border-ink-700 px-2 py-1.5 text-xs text-ink-200 hover:bg-white/5"
                  >
                    <Inbox className="size-3.5" /> Respostas
                  </button>
                  <button
                    onClick={() => void copiar(f)}
                    className="inline-flex items-center gap-1 rounded-md border border-ink-700 px-2 py-1.5 text-xs text-ink-200 hover:bg-white/5"
                  >
                    {copied === f.id ? <Check className="size-3.5 text-wa-500" /> : <Copy className="size-3.5" />} Link
                  </button>
                  <a
                    href={linkOf(f)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-ink-700 px-2 py-1.5 text-xs text-ink-200 hover:bg-white/5"
                  >
                    <ExternalLink className="size-3.5" /> Abrir
                  </a>
                  <button
                    onClick={() => void remover(f)}
                    title="Excluir"
                    className="ml-auto rounded-md p-1.5 text-ink-500 hover:text-red-300"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </article>
            )
          })}
          {visiveis.length === 0 && (
            <p className="col-span-full rounded-2xl border border-dashed border-ink-700 p-10 text-center text-sm text-ink-500">
              Nenhum formulário corresponde a “{q}”.
            </p>
          )}
        </div>
      )}

      {editing && (
        <FormEditorModal
          form={editing === 'new' ? null : editing}
          clients={lines}
          defaultLine={numberId ?? 0}
          draft={editing === 'new' ? draft : null}
          onClose={() => {
            setEditing(null)
            setDraft(null)
          }}
          onSaved={() => {
            setEditing(null)
            setDraft(null)
            load()
          }}
        />
      )}
      {aiOpen && (
        <FormAiModal
          clients={lines}
          defaultLine={numberId ?? 0}
          onClose={() => setAiOpen(false)}
          onUse={(g) => {
            setDraft({
              title: g.title,
              headline: g.headline,
              description: g.description,
              thank_you: g.thank_you,
              fields: g.fields,
            })
            setAiOpen(false)
            setEditing('new')
          }}
        />
      )}
      {viewing && <FormResponsesModal form={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}
