// Respostas de um formulário — busca, tabela por pergunta e exportação CSV.
import { useEffect, useMemo, useState } from "react";
import { Download, Inbox, Loader2, Search, X } from './icons';
import { listFormResponses, type LeadForm, type LeadFormResponse } from './client';

export function FormResponsesModal({ form, onClose }: { form: LeadForm; onClose: () => void }) {
  const [rows, setRows] = useState<LeadFormResponse[] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    listFormResponses(form.id).then((r) => setRows(r.responses)).catch(() => setRows([]));
  }, [form.id]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t || !rows) return rows || [];
    return rows.filter((r) => Object.values(r.answers).join(" ").toLowerCase().includes(t));
  }, [rows, q]);

  function exportCsv() {
    const cols = form.fields.map((f) => f.label);
    const cell = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [["Data", ...cols].map(cell).join(";")];
    for (const r of filtered) {
      lines.push([
        r.created_at ? new Date(r.created_at).toLocaleString("pt-BR") : "",
        ...form.fields.map((f) => r.answers[f.id] || ""),
      ].map(cell).join(";"));
    }
    // BOM para o Excel abrir os acentos corretamente
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `respostas-${form.slug}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-3 backdrop-blur-sm md:p-6" onClick={onClose}>
      <div className="flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-ink-800 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">Respostas — {form.title}</h2>
            <p className="text-sm text-ink-400">
              {rows === null ? "Carregando…" : `${rows.length} resposta(s) · ${form.views} visita(s)`}
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

        <div className="shrink-0 border-b border-ink-800 px-6 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome, telefone, resposta…"
              className="w-full rounded-lg border border-ink-700 bg-ink-950 py-2 pl-10 pr-3 text-sm outline-none focus:border-wa-500/70 focus:ring-2 focus:ring-wa-500/20" />
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 py-4">
          {rows === null && (
            <p className="flex items-center justify-center gap-2 py-10 text-sm text-ink-400">
              <Loader2 className="size-4 animate-spin" /> Carregando respostas…
            </p>
          )}
          {rows !== null && filtered.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-ink-800 py-14 text-center">
              <Inbox className="size-6 text-ink-600" />
              <p className="text-sm text-ink-400">
                {rows.length === 0 ? "Nenhuma resposta ainda." : "Nada encontrado para essa busca."}
              </p>
            </div>
          )}
          {filtered.map((r) => (
            <div key={r.id} className="rounded-xl border border-ink-800 bg-ink-950/50 p-4">
              <p className="text-[11px] text-ink-400">
                #{r.id} · {r.created_at ? new Date(r.created_at).toLocaleString("pt-BR") : ""}
              </p>
              <dl className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {form.fields.filter((f) => r.answers[f.id]).map((f) => (
                  <div key={f.id} className="min-w-0">
                    <dt className="truncate text-[11px] uppercase tracking-wide text-ink-400">{f.label}</dt>
                    <dd className="text-sm font-medium">{r.answers[f.id]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
