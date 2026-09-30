// Gerar formulário com IA — o usuário escolhe um método de qualificação
// comercial (BANT, CHAMP, SPIN…) e o contexto do negócio; a IA escreve as
// perguntas seguindo as etapas daquele método.
//
// Duas fases: escolher/contextualizar -> revisar o rascunho. Nada é salvo aqui:
// "Abrir no editor" entrega o rascunho para o editor normal, onde o usuário
// ajusta e só então publica.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, ArrowLeft, Check, ChevronRight, Loader2, RotateCcw, Sparkles,
  TriangleAlert, X,
} from './icons';
import {
  listFormFrameworks, generateFormWithAi,
  type FormLine, type FormAiDraft, type FormFramework, type LeadFormField,
} from './client';
import { FIELD_TYPES } from './formKit';

const INPUT = "w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm outline-none"
  + " transition-colors placeholder:text-ink-600 focus:border-wa-500/70"
  + " focus:ring-2 focus:ring-wa-500/20";

export function FormAiModal({ clients, defaultLine = 0, mode = "form", onClose, onUse }: {
  /** linhas (clientes) que o usuário vê */
  clients: FormLine[];
  defaultLine?: number;
  /** "form" devolve o formulário inteiro; "fields" só as perguntas. */
  mode?: "form" | "fields";
  onClose: () => void;
  onUse: (draft: FormAiDraft) => void;
}) {
  const [frameworks, setFrameworks] = useState<FormFramework[]>([]);
  const [limites, setLimites] = useState({ min: 4, max: 20 });
  const [fw, setFw] = useState("bant");
  const [ctx, setCtx] = useState({
    wa_number_id: defaultLine, business: "", offer: "", audience: "", tone: "", notes: "", questions: 0,
  });
  const [draft, setDraft] = useState<FormAiDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listFormFrameworks()
      .then((r) => {
        setFrameworks(r.frameworks);
        setLimites({ min: r.min_questions, max: r.max_questions });
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Falha ao carregar os métodos."));
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const escolhido = useMemo(() => frameworks.find((f) => f.id === fw), [frameworks, fw]);
  // Escolher o cliente já dá contexto de negócio sem digitar nada.
  const cliente = clients.find((c) => c.id === ctx.wa_number_id);

  async function gerar() {
    setBusy(true); setErr("");
    try {
      const r = await generateFormWithAi({
        framework: fw,
        number_id: ctx.wa_number_id || null,
        business: ctx.business, offer: ctx.offer, audience: ctx.audience,
        tone: ctx.tone, notes: ctx.notes,
        questions: ctx.questions || 0,
      });
      setDraft(r);
      scrollRef.current?.scrollTo({ top: 0 });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Falha ao gerar o formulário.");
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}>
      <div className="my-4 w-full max-w-5xl rounded-2xl border border-ink-700 bg-ink-900" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-start justify-between gap-4 border-b border-ink-700 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-wa-500/15 text-wa-500">
              <Sparkles className="size-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">
                {mode === "fields" ? "Gerar perguntas com IA" : "Gerar formulário com IA"}
              </h2>
              <p className="text-sm text-ink-400">
                Escolha o método de qualificação e conte o contexto — a IA escreve as perguntas.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-ink-400 hover:bg-white/5 hover:text-ink-100">
            <X className="size-5" />
          </button>
        </header>

        <div ref={scrollRef} className="max-h-[70vh] overflow-y-auto">
          {draft
            ? <Revisao draft={draft} mode={mode} onVoltar={() => setDraft(null)}
                onRegerar={gerar} busy={busy} onUse={() => onUse(draft)} />
            : (
              <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
                {/* ---------- métodos ---------- */}
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">Método de qualificação</h3>
                  <p className="mt-0.5 text-xs text-ink-400">
                    Cada método pergunta coisas diferentes porque serve a um cenário de venda diferente.
                  </p>
                  {!frameworks.length && !err && (
                    <div className="mt-4 flex items-center gap-2 text-sm text-ink-400">
                      <Loader2 className="size-4 animate-spin" /> Carregando métodos…
                    </div>
                  )}
                  <div className="mt-3 space-y-2">
                    {frameworks.map((f) => {
                      const sel = f.id === fw;
                      return (
                        <button key={f.id} type="button" onClick={() => setFw(f.id)}
                          className={`w-full rounded-xl border p-3.5 text-left transition-colors ${
                            sel ? "border-wa-500 bg-wa-500/10" : "border-ink-800 hover:border-wa-500/40 hover:bg-white/[0.02]"
                          }`}>
                          <div className="flex min-w-0 items-center gap-2">
                            <span className={`font-semibold ${sel ? "text-wa-500" : ""}`}>{f.name}</span>
                            <span className="min-w-0 truncate text-[11px] text-ink-400">{f.subtitle}</span>
                            <span className="ml-auto shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] tabular-nums text-ink-400">
                              ~{f.questions} perguntas
                            </span>
                          </div>
                          <p className="mt-1.5 text-xs leading-relaxed text-ink-400">{f.best_for}</p>
                          {sel && (
                            <>
                              <div className="mt-2.5 flex flex-wrap gap-1">
                                {f.stages.map((s) => (
                                  <span key={s.key} title={s.goal}
                                    className="rounded bg-wa-500/15 px-1.5 py-0.5 text-[10px] font-medium text-wa-500">
                                    {s.name}
                                  </span>
                                ))}
                              </div>
                              <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-300">
                                <TriangleAlert className="mt-px size-3 shrink-0" /> {f.watch_out}
                              </p>
                            </>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* ---------- contexto ---------- */}
                <div className="min-w-0 space-y-3 lg:border-l lg:border-ink-800 lg:pl-6">
                  <h3 className="text-sm font-semibold">Contexto do negócio</h3>
                  <p className="-mt-1 text-xs text-ink-400">
                    Tudo opcional — quanto mais você conta, mais específicas ficam as perguntas.
                  </p>

                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-400">Linha (cliente)</span>
                    <select className={INPUT} value={ctx.wa_number_id}
                      onChange={(e) => setCtx({ ...ctx, wa_number_id: Number(e.target.value) })}>
                      <option value={0}>Sem linha</option>
                      {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-400">O que o negócio faz</span>
                    <input className={INPUT} value={ctx.business}
                      onChange={(e) => setCtx({ ...ctx, business: e.target.value })}
                      placeholder={cliente ? `Ex.: ${cliente.name} — o que ela vende` : "Ex.: clínica odontológica em BH"} />
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-400">Oferta desta campanha</span>
                    <input className={INPUT} value={ctx.offer}
                      onChange={(e) => setCtx({ ...ctx, offer: e.target.value })}
                      placeholder="Ex.: avaliação gratuita de implante" />
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-400">Público</span>
                    <input className={INPUT} value={ctx.audience}
                      onChange={(e) => setCtx({ ...ctx, audience: e.target.value })}
                      placeholder="Ex.: adultos 35+ na Grande BH" />
                  </label>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-xs text-ink-400">Tom de voz</span>
                      <input className={INPUT} value={ctx.tone}
                        onChange={(e) => setCtx({ ...ctx, tone: e.target.value })} placeholder="Próximo, direto…" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-ink-400">Nº de perguntas</span>
                      <select className={INPUT} value={ctx.questions}
                        onChange={(e) => setCtx({ ...ctx, questions: Number(e.target.value) })}>
                        <option value={0}>Automático</option>
                        {Array.from({ length: limites.max - limites.min + 1 }, (_, i) => limites.min + i)
                          .map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </label>
                  </div>

                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-400">Observações</span>
                    <textarea className={`${INPUT} min-h-[70px]`} value={ctx.notes}
                      onChange={(e) => setCtx({ ...ctx, notes: e.target.value })}
                      placeholder="Algo que a IA precisa saber: restrições, o que não perguntar…" />
                  </label>

                  {err && (
                    <p className="flex items-start gap-1.5 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                      <AlertCircle className="mt-px size-3.5 shrink-0" /> {err}
                    </p>
                  )}

                  <button type="button" onClick={gerar} disabled={busy || !frameworks.length}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-wa-500 px-4 py-2.5 text-sm font-semibold text-ink-950 transition-[filter] hover:brightness-110 disabled:opacity-50">
                    {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                    {busy ? "Escrevendo as perguntas…" : `Gerar com ${escolhido?.name || "IA"}`}
                  </button>
                  {busy && (
                    <p className="text-center text-[11px] text-ink-400">
                      Leva de 15 segundos a 1 minuto e meio. Pode deixar esta janela aberta.
                    </p>
                  )}
                </div>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revisão do rascunho
// ---------------------------------------------------------------------------
function Revisao({ draft, mode, busy, onVoltar, onRegerar, onUse }: {
  draft: FormAiDraft;
  mode: "form" | "fields";
  busy: boolean;
  onVoltar: () => void;
  onRegerar: () => void;
  onUse: () => void;
}) {
  const tipoLabel = (t: LeadFormField["type"]) =>
    FIELD_TYPES.find((x) => x.v === t)?.l || t;

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button onClick={onVoltar}
          className="inline-flex items-center gap-1 rounded-md border border-ink-700 px-2.5 py-1.5 text-xs text-ink-400 hover:text-ink-100">
          <ArrowLeft className="size-3.5" /> Trocar método
        </button>
        <span className="rounded-md bg-wa-500/15 px-2 py-1 text-xs font-semibold text-wa-500">
          {draft.framework_name}
        </span>
        <span className="text-xs text-ink-400">{draft.fields.length} perguntas</span>
        {draft.source === "modelo" && (
          <span className="inline-flex items-center gap-1 rounded-md bg-amber-950/60 px-2 py-1 text-[11px] text-amber-300">
            <TriangleAlert className="size-3" /> Modelo do método — a IA não respondeu{draft.ai_error ? ` (${draft.ai_error})` : ""}
          </span>
        )}
      </div>

      {mode === "form" && (
        <div className="mb-4 rounded-xl border border-ink-800 bg-ink-950/50 p-4">
          <p className="text-[11px] uppercase tracking-wide text-ink-400">Nome interno</p>
          <p className="text-sm font-semibold">{draft.title}</p>
          {draft.headline && (
            <>
              <p className="mt-2 text-[11px] uppercase tracking-wide text-ink-400">O lead vê</p>
              <p className="text-sm font-semibold">{draft.headline}</p>
            </>
          )}
          {draft.description && <p className="mt-0.5 text-xs text-ink-400">{draft.description}</p>}
        </div>
      )}

      <ol className="space-y-2">
        {draft.fields.map((f, i) => (
          <li key={f.id || i} className="rounded-xl border border-ink-800 bg-ink-950/50 p-3.5">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-white/5 text-[11px] font-semibold tabular-nums text-ink-400">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{f.label}</p>
                {f.help && <p className="mt-0.5 text-xs text-ink-400">{f.help}</p>}
                {!!f.options.length && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {f.options.map((o) => (
                      <span key={o} className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-ink-400">{o}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="shrink-0 text-right">
                <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-ink-400">
                  {tipoLabel(f.type)}
                </span>
                {!f.required && <p className="mt-1 text-[10px] text-ink-400">opcional</p>}
              </div>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <button onClick={onRegerar} disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-400 hover:text-ink-100 disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} Gerar de novo
        </button>
        <button onClick={onUse}
          className="inline-flex items-center gap-2 rounded-lg bg-wa-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:brightness-110">
          {mode === "fields"
            ? <><Check className="size-4" /> Usar estas perguntas</>
            : <>Abrir no editor <ChevronRight className="size-4" /></>}
        </button>
      </div>
      <p className="mt-2 text-right text-[11px] text-ink-400">
        {mode === "fields"
          ? "Substitui as perguntas atuais do formulário. Nada é salvo até você clicar em Salvar."
          : "Nada é publicado ainda — você revisa e ajusta tudo no editor."}
      </p>
    </div>
  );
}
