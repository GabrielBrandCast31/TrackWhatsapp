// Respostas de um formulário — busca, tabela por pergunta e exportação CSV.
// A aba "Incompletos" lista quem começou a preencher e não enviou.
import { useEffect, useMemo, useState } from "react";
import { Check, Download, Inbox, Loader2, RotateCcw, Search, Trash2, X } from './icons';
import {
  deleteFormPartial, listFormPartials, listFormResponses, resendToSheets, setResponseQualification,
  type LeadForm, type LeadFormPartial, type LeadFormResponse,
} from './client';

type Tab = "responses" | "partials";
type QFilter = "all" | "yes" | "no" | "none";

export function FormResponsesModal({ form, onClose, initialTab = "responses" }: {
  form: LeadForm; onClose: () => void; initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [rows, setRows] = useState<LeadFormResponse[] | null>(null);
  const [partials, setPartials] = useState<LeadFormPartial[] | null>(null);
  const [q, setQ] = useState("");
  const [qf, setQf] = useState<QFilter>("all");
  const [saving, setSaving] = useState<number | null>(null);
  const [qErr, setQErr] = useState("");

  async function resend(r: LeadFormResponse) {
    setSaving(r.id); setQErr("");
    try {
      const upd = await resendToSheets(form.id, r.id);
      setRows((rs) => (rs || []).map((x) => (x.id === r.id ? upd : x)));
      if (upd.sheets_status !== "sent") setQErr(upd.sheets_error || "A planilha recusou a linha.");
    } catch (e) {
      setQErr(e instanceof Error ? e.message : "Não foi possível reenviar.");
    } finally { setSaving(null); }
  }

  async function classify(r: LeadFormResponse, value: boolean | null) {
    setSaving(r.id); setQErr("");
    try {
      const upd = await setResponseQualification(form.id, r.id, value);
      setRows((rs) => (rs || []).map((x) => (x.id === r.id ? upd : x)));
    } catch (e) {
      setQErr(e instanceof Error ? e.message : "Não foi possível salvar a classificação.");
    } finally { setSaving(null); }
  }

  useEffect(() => {
    listFormResponses(form.id).then((r) => setRows(r.responses)).catch(() => setRows([]));
    listFormPartials(form.id).then(setPartials).catch(() => setPartials([]));
  }, [form.id]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const current = tab === "responses" ? rows : partials;
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    let list = current || [];
    if (tab === "responses" && qf !== "all") {
      list = (list as LeadFormResponse[]).filter((r) =>
        qf === "yes" ? r.qualified === true : qf === "no" ? r.qualified === false : r.qualified == null);
    }
    if (!t) return list;
    return list.filter((r) => Object.values(r.answers).join(" ").toLowerCase().includes(t));
  }, [current, q, qf, tab]);
  const qCount = useMemo(() => ({
    yes: (rows || []).filter((r) => r.qualified === true).length,
    no: (rows || []).filter((r) => r.qualified === false).length,
    none: (rows || []).filter((r) => r.qualified == null).length,
  }), [rows]);

  // onde a pessoa parou: a pergunta seguinte à última respondida
  const stoppedAt = (p: LeadFormPartial) => {
    const i = Math.min(p.step, form.fields.length - 1);
    return i >= 0 ? `${i + 1}. ${form.fields[i].label}` : "";
  };

  async function removePartial(p: LeadFormPartial) {
    if (!window.confirm("Apagar este preenchimento incompleto?")) return;
    await deleteFormPartial(form.id, p.id);
    setPartials((ps) => (ps || []).filter((x) => x.id !== p.id));
  }

  function exportCsv() {
    const cols = form.fields.map((f) => f.label);
    const cell = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = tab === "responses" ? ["Data", "Qualificado", ...cols] : ["Última atividade", "Parou em", ...cols];
    const lines = [head.map(cell).join(";")];
    for (const r of filtered) {
      const when = tab === "responses" ? r.created_at : (r as LeadFormPartial).updated_at;
      lines.push([
        when ? new Date(when).toLocaleString("pt-BR") : "",
        ...(tab === "partials" ? [stoppedAt(r as LeadFormPartial)] : [qualLabel((r as LeadFormResponse).qualified)]),
        ...form.fields.map((f) => r.answers[f.id] || ""),
      ].map(cell).join(";"));
    }
    // BOM para o Excel abrir os acentos corretamente
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tab === "responses" ? "respostas" : "incompletos"}-${form.slug}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const tabBtn = (t: Tab, label: string, n: number | undefined) => (
    <button onClick={() => setTab(t)}
      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
        tab === t ? "bg-wa-500/15 text-wa-500" : "text-ink-400 hover:bg-white/5 hover:text-ink-100"}`}>
      {label}{n !== undefined && <span className="ml-1.5 font-mono opacity-70">{n}</span>}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-3 backdrop-blur-sm md:p-6" onClick={onClose}>
      <div className="flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-ink-800 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">Respostas — {form.title}</h2>
            <p className="text-sm text-ink-400">
              {rows === null ? "Carregando…" : `${rows.length} resposta(s) · ${qCount.yes} qualificada(s) · ${partials?.length ?? 0} incompleto(s) · ${form.views} visita(s)`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportCsv} disabled={!filtered.length}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-ink-400 transition-colors hover:bg-white/5 hover:text-ink-100 disabled:opacity-40">
              <Download className="size-3.5" /> Exportar CSV
            </button>
            <button onClick={onClose} className="rounded-lg border border-ink-800 p-1.5 text-ink-400 hover:bg-white/5 hover:text-ink-100">
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-3 border-b border-ink-800 px-6 py-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-1">
            {tabBtn("responses", "Enviadas", rows?.length)}
            {tabBtn("partials", "Incompletos", partials?.length)}
          </div>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome, telefone, resposta…"
              className="w-full rounded-lg border border-ink-700 bg-ink-950 py-2 pl-10 pr-3 text-sm outline-none focus:border-wa-500/70 focus:ring-2 focus:ring-wa-500/20" />
          </div>
        </div>

        {tab === "responses" && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-ink-800 px-6 py-2">
            {([["all", "Todas", rows?.length], ["yes", "Qualificadas", qCount.yes], ["no", "Não qualificadas", qCount.no],
              ["none", "Sem classificação", qCount.none]] as const).map(([v, l, n]) => (
              <button key={v} onClick={() => setQf(v)}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  qf === v ? "border-wa-500 bg-wa-500/15 text-ink-100" : "border-ink-700 text-ink-400 hover:bg-white/5"}`}>
                {l}<span className="ml-1 font-mono opacity-70">{n ?? 0}</span>
              </button>
            ))}
            {qErr && <span className="ml-2 text-[11px] text-red-300">{qErr}</span>}
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 py-4">
          {tab === "partials" && !!partials?.length && (
            <p className="text-xs leading-relaxed text-ink-500">
              Quem começou a preencher e saiu antes de enviar. As respostas são salvas enquanto a pessoa responde;
              quem envia depois sai desta lista.
            </p>
          )}
          {current === null && (
            <p className="flex items-center justify-center gap-2 py-10 text-sm text-ink-400">
              <Loader2 className="size-4 animate-spin" /> Carregando…
            </p>
          )}
          {current !== null && filtered.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-ink-800 py-14 text-center">
              <Inbox className="size-6 text-ink-600" />
              <p className="text-sm text-ink-400">
                {current.length > 0 ? "Nada encontrado para essa busca."
                  : tab === "responses" ? "Nenhuma resposta ainda." : "Ninguém abandonou o formulário no meio até agora."}
              </p>
            </div>
          )}
          {tab === "responses" && (filtered as LeadFormResponse[]).map((r) => (
            <div key={r.id} className={`rounded-xl border bg-ink-950/50 p-4 ${
              r.qualified === true ? "border-wa-500/40" : "border-ink-800"}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-400">
                  <span>#{r.id} · {r.created_at ? new Date(r.created_at).toLocaleString("pt-BR") : ""}</span>
                  <QualBadge r={r} />
                  <EventBadge r={r} />
                  {r.sheets_status === "sent" && (
                    <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">na planilha</span>
                  )}
                  {(r.sheets_status === "failed" || (r.sheets_status == null && form.settings.sheets_enabled)) && (
                    <button onClick={() => void resend(r)} disabled={saving === r.id} title={r.sheets_error || "Enviar esta resposta para a planilha"}
                      className={`rounded-md px-1.5 py-0.5 hover:underline ${r.sheets_status === "failed"
                        ? "bg-red-500/10 text-red-300" : "bg-white/5 text-ink-400"}`}>
                      {r.sheets_status === "failed" ? "planilha falhou · reenviar" : "enviar para a planilha"}
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {saving === r.id && <Loader2 className="size-3.5 text-ink-400" />}
                  <button disabled={saving === r.id} onClick={() => void classify(r, true)}
                    title="Marcar como qualificado (dispara o evento se ainda não saiu)"
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                      r.qualified === true ? "border-wa-500 bg-wa-500/15 text-wa-500" : "border-ink-700 text-ink-400 hover:text-ink-100"}`}>
                    <Check className="size-3" /> Qualificado
                  </button>
                  <button disabled={saving === r.id} onClick={() => void classify(r, false)}
                    title="Marcar como não qualificado"
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                      r.qualified === false ? "border-red-400/60 bg-red-500/10 text-red-300" : "border-ink-700 text-ink-400 hover:text-ink-100"}`}>
                    <X className="size-3" /> Não
                  </button>
                  {r.qualified_source === "manual" && (
                    <button disabled={saving === r.id} onClick={() => void classify(r, null)}
                      title="Voltar para a classificação automática (pelos critérios)"
                      className="rounded-md p-1 text-ink-500 hover:text-ink-100">
                      <RotateCcw className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <Answers form={form} answers={r.answers} />
            </div>
          ))}
          {tab === "partials" && (filtered as LeadFormPartial[]).map((p) => (
            <div key={p.id} className="rounded-xl border border-ink-800 bg-ink-950/50 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-[11px] text-ink-400">
                  {p.updated_at ? new Date(p.updated_at).toLocaleString("pt-BR") : ""}
                  {" · "}
                  <span className="text-amber-300/90">
                    {Object.keys(p.answers).length} de {form.fields.length} respondida(s) · parou em {stoppedAt(p)}
                  </span>
                </p>
                <button onClick={() => void removePartial(p)} title="Apagar"
                  className="shrink-0 rounded-md p-1 text-ink-500 hover:text-red-300">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              <Answers form={form} answers={p.answers} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Answers({ form, answers }: { form: LeadForm; answers: Record<string, string> }) {
  return (
    <dl className="mt-2 grid gap-1.5 sm:grid-cols-2">
      {form.fields.filter((f) => answers[f.id]).map((f) => (
        <div key={f.id} className="min-w-0">
          <dt className="truncate text-[11px] uppercase tracking-wide text-ink-400">{f.label}</dt>
          <dd className="text-sm font-medium">{answers[f.id]}</dd>
        </div>
      ))}
    </dl>
  );
}

const qualLabel = (v: boolean | null) => (v === true ? "sim" : v === false ? "não" : "");

function QualBadge({ r }: { r: LeadFormResponse }) {
  if (r.qualified == null) return <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-ink-500">sem classificação</span>;
  const src = r.qualified_source === "manual" ? "manual" : `automático${
    r.qualification?.score ? ` · ${r.qualification.score} pt` : ""}`;
  return r.qualified ? (
    <span className="rounded-md bg-wa-500/15 px-1.5 py-0.5 font-semibold text-wa-500">✓ qualificado · {src}</span>
  ) : (
    <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-ink-300">não qualificado · {src}</span>
  );
}

function EventBadge({ r }: { r: LeadFormResponse }) {
  if (!r.ql_event_status) return null;
  const map = {
    sent: ["evento enviado ao Meta", "bg-sky-500/10 text-sky-300"],
    failed: ["evento falhou", "bg-red-500/10 text-red-300"],
    skipped: ["evento não enviado", "bg-amber-500/10 text-amber-300"],
  } as const;
  const [label, cls] = map[r.ql_event_status];
  return <span className={`rounded-md px-1.5 py-0.5 ${cls}`} title={r.ql_event_error || undefined}>{label}</span>;
}
