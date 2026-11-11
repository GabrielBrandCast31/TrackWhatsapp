// Qualificação do lead — critérios sobre as respostas, o que acontece quando o
// lead qualifica (evento QualifiedLead no Meta, MQL no CRM, aviso) e a
// simulação com as respostas já recebidas, para ajustar o formulário.
import { useState } from "react";
import { AlertCircle, Check, Loader2, Plus, RotateCcw, Sparkles, Trash2 } from "./icons";
import {
  reapplyQualification, simulateQualification,
  type LeadFormField, type LeadFormQualification, type QualOp, type QualRule, type QualSimulation,
} from "./client";
import { Field, INPUT, SettingRow, Toggle } from "./editorUi";

export const DEFAULT_QUALIFICATION: LeadFormQualification = {
  enabled: false, mode: "all", min_score: 1, rules: [],
  send_event: true, event_name: "QualifiedLead", move_to_mql: true, notify_only_qualified: false,
};

const OP_LABEL: Record<QualOp, string> = {
  is_any: "é uma destas", is_none: "não é nenhuma destas",
  contains: "contém", not_contains: "não contém",
  gte: "maior ou igual a", lte: "menor ou igual a",
  filled: "foi respondida", empty: "ficou em branco",
};

const CHOICE_TYPES = ["choice", "select", "multi"];
const NUMBER_TYPES = ["number", "rating"];

/** Operadores que fazem sentido para o tipo da pergunta. */
function opsFor(f: LeadFormField | undefined): QualOp[] {
  if (!f) return ["filled"];
  if (CHOICE_TYPES.includes(f.type)) return ["is_any", "is_none", "filled", "empty"];
  if (NUMBER_TYPES.includes(f.type)) return ["gte", "lte", "filled", "empty"];
  return ["contains", "not_contains", "filled", "empty"];
}

/** Perguntas de contato não qualificam ninguém — ficam fora da lista. */
const qualifiable = (fields: LeadFormField[]) => fields.filter((f) => !["phone", "email"].includes(f.type));

function newRule(fields: LeadFormField[]): QualRule {
  const f = qualifiable(fields).find((x) => CHOICE_TYPES.includes(x.type)) || qualifiable(fields)[0] || fields[0];
  return {
    id: `r${Date.now().toString(36)}`, field_id: f?.id || "", op: opsFor(f)[0],
    values: [], value: "", points: 1,
  };
}

const chip = (on: boolean) =>
  `rounded-lg border px-2.5 py-1 text-xs transition-colors ${
    on ? "border-wa-500 bg-wa-500/15 text-ink-100" : "border-ink-700 text-ink-400 hover:bg-white/5"}`;

// ------------------------------- critérios ---------------------------------
export function QualCriteria({ q, onChange, fields }: {
  q: LeadFormQualification; onChange: (q: LeadFormQualification) => void; fields: LeadFormField[];
}) {
  const set = (patch: Partial<LeadFormQualification>) => onChange({ ...q, ...patch });
  const setRule = (i: number, patch: Partial<QualRule>) =>
    set({ rules: q.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const options = qualifiable(fields);
  const orphan = q.rules.filter((r) => !fields.some((f) => f.id === r.field_id)).length;
  const maxScore = q.rules.reduce((a, r) => a + Math.max(0, r.points), 0);

  return (
    <>
      <SettingRow label="Classificar leads deste formulário"
        hint="Cada resposta é avaliada pelos critérios abaixo e marcada como qualificada ou não. Você pode corrigir na mão na lista de respostas."
        help="Desligado, as respostas chegam sem classificação e nenhum evento de qualificação é enviado.">
        <Toggle checked={q.enabled} onChange={(v) => set({ enabled: v, rules: v && !q.rules.length ? [newRule(fields)] : q.rules })} />
      </SettingRow>

      {q.enabled && (
        <>
          <SettingRow label="Quando o lead é qualificado?"
            hint={q.mode === "all" ? "Precisa cumprir todas as regras."
              : q.mode === "any" ? "Basta cumprir uma das regras."
              : `Soma os pontos das regras cumpridas e qualifica a partir de ${q.min_score} ponto(s).`}>
            <div className="flex gap-1.5">
              {([["all", "Todas"], ["any", "Qualquer uma"], ["score", "Por pontos"]] as const).map(([v, l]) => (
                <button key={v} type="button" onClick={() => set({ mode: v })} className={chip(q.mode === v)}>{l}</button>
              ))}
            </div>
          </SettingRow>
          {q.mode === "score" && (
            <SettingRow label="Pontuação mínima" hint={`Máximo possível com as regras atuais: ${maxScore} ponto(s).`}>
              <input type="number" className={`${INPUT} w-24`} value={q.min_score}
                onChange={(e) => set({ min_score: Number(e.target.value) || 0 })} />
            </SettingRow>
          )}

          <div className="space-y-2">
            {q.rules.map((r, i) => {
              const f = fields.find((x) => x.id === r.field_id);
              const ops = opsFor(f);
              return (
                <div key={r.id} className="rounded-xl border border-ink-800 bg-ink-950/50 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] text-ink-500">{i === 0 ? "SE" : q.mode === "any" ? "OU" : q.mode === "all" ? "E" : "+"}</span>
                    <select className={`${INPUT} w-auto min-w-0 flex-1`} value={r.field_id}
                      onChange={(e) => {
                        const nf = fields.find((x) => x.id === e.target.value);
                        setRule(i, { field_id: e.target.value, op: opsFor(nf)[0], values: [], value: "" });
                      }}>
                      {!f && <option value={r.field_id}>— pergunta removida —</option>}
                      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                    <select className={`${INPUT} w-auto`} value={r.op}
                      onChange={(e) => setRule(i, { op: e.target.value as QualOp })}>
                      {ops.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
                    </select>
                    {q.mode === "score" && (
                      <label className="flex items-center gap-1 text-xs text-ink-400">
                        <input type="number" className={`${INPUT} w-16 px-2`} value={r.points}
                          onChange={(e) => setRule(i, { points: Number(e.target.value) || 0 })} />
                        pts
                      </label>
                    )}
                    <button type="button" title="Remover regra"
                      onClick={() => set({ rules: q.rules.filter((_, j) => j !== i) })}
                      className="rounded-md p-1.5 text-ink-500 hover:text-red-300">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>

                  {f && (r.op === "is_any" || r.op === "is_none") && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {f.options.map((o) => {
                        const on = r.values.includes(o);
                        return (
                          <button key={o} type="button" className={chip(on)}
                            onClick={() => setRule(i, { values: on ? r.values.filter((v) => v !== o) : [...r.values, o] })}>
                            {on && <Check className="mr-1 inline size-3" />}{o}
                          </button>
                        );
                      })}
                      {!f.options.length && <p className="text-xs text-ink-500">Essa pergunta ainda não tem opções.</p>}
                    </div>
                  )}
                  {(r.op === "contains" || r.op === "not_contains") && (
                    <input className={`${INPUT} mt-2`} value={r.value} placeholder="termos separados por vírgula: clínica, consultório"
                      onChange={(e) => setRule(i, {
                        value: e.target.value,
                        values: e.target.value.split(",").map((t) => t.trim()).filter(Boolean),
                      })} />
                  )}
                  {(r.op === "gte" || r.op === "lte") && (
                    <input className={`${INPUT} mt-2 w-40`} inputMode="decimal" value={r.value}
                      placeholder={f?.type === "rating" ? "ex.: 4" : "ex.: 5000"}
                      onChange={(e) => setRule(i, { value: e.target.value })} />
                  )}
                  {(r.op === "is_any" || r.op === "is_none") && f && !r.values.length && (
                    <p className="mt-1.5 text-[11px] text-amber-300">Marque ao menos uma opção — sem ela a regra nunca bate.</p>
                  )}
                </div>
              );
            })}
            <button type="button" onClick={() => set({ rules: [...q.rules, newRule(fields)] })}
              disabled={!options.length}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-wa-500/40 bg-wa-500/5 py-2.5 text-sm font-semibold text-wa-500 transition-colors hover:bg-wa-500/10 disabled:opacity-40">
              <Plus className="size-4" /> Adicionar regra
            </button>
            {orphan > 0 && (
              <p className="flex items-center gap-1.5 text-[11px] text-amber-300">
                <AlertCircle className="size-3.5" /> {orphan} regra(s) apontam para pergunta removida e serão ignoradas.
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ------------------------------ ao qualificar -------------------------------
export function QualActions({ q, onChange, pixelReady, notifySet }: {
  q: LeadFormQualification; onChange: (q: LeadFormQualification) => void;
  /** Pixel + token da CAPI configurados (aba Integrações) */
  pixelReady: boolean; notifySet: boolean;
}) {
  const set = (patch: Partial<LeadFormQualification>) => onChange({ ...q, ...patch });
  const validName = /^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(q.event_name);
  return (
    <>
      <SettingRow label="Disparar evento no Meta"
        hint="Quando o lead qualifica (pelos critérios ou marcado por você), o evento sai pela Conversions API e pelo Pixel da página, com o mesmo event_id."
        help="Sai uma única vez por resposta: reclassificar não duplica. Use o evento para otimizar campanhas por lead qualificado.">
        <Toggle checked={q.send_event} onChange={(v) => set({ send_event: v })} />
      </SettingRow>
      {q.send_event && (
        <>
          <Field label="Nome do evento" hint="QualifiedLead é um evento personalizado. Crie uma conversão personalizada com ele no Gerenciador de Eventos para usar nas campanhas.">
            <input className={`${INPUT} font-mono`} value={q.event_name} spellCheck={false}
              onChange={(e) => set({ event_name: e.target.value.replace(/\s/g, "") })} />
            {!validName && (
              <p className="mt-1 text-[11px] text-red-300">Use só letras, números e _, começando com letra. Inválido volta para QualifiedLead.</p>
            )}
          </Field>
          {!pixelReady && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-300">
              Falta o Pixel e o token da CAPI (categoria Integrações). Sem eles, o lead é classificado mas o evento não sai.
            </p>
          )}
        </>
      )}
      <SettingRow label="Mover para MQL no CRM"
        hint="O card do lead qualificado sobe para a etapa MQL. Nunca rebaixa quem já está mais à frente.">
        <Toggle checked={q.move_to_mql} onChange={(v) => set({ move_to_mql: v })} />
      </SettingRow>
      <SettingRow label="Avisar no WhatsApp só os qualificados"
        hint={notifySet ? "Lead não qualificado continua no CRM, mas não gera aviso para a equipe."
          : "Configure o número de aviso em Notificações para usar esta opção."}>
        <Toggle checked={q.notify_only_qualified} onChange={(v) => set({ notify_only_qualified: v })} />
      </SettingRow>
    </>
  );
}

// ------------------------------- simulação ---------------------------------
export function QualSimulator({ formId, q, fields }: {
  formId: number | null; q: LeadFormQualification; fields: LeadFormField[];
}) {
  const [sim, setSim] = useState<QualSimulation | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [reapply, setReapply] = useState<{ busy: boolean; msg?: string }>({ busy: false });

  if (!formId) {
    return <p className="text-xs text-ink-400">Salve o formulário e receba respostas para testar os critérios com dados reais.</p>;
  }

  async function run() {
    setBusy(true); setErr("");
    try { setSim(await simulateQualification(formId!, q, fields)); }
    catch (e) { setErr(e instanceof Error ? e.message : "Falha ao simular."); }
    finally { setBusy(false); }
  }
  async function doReapply() {
    if (!window.confirm("Reclassificar as respostas antigas com os critérios SALVOS? As marcadas na mão não mudam, e nenhum evento é enviado.")) return;
    setReapply({ busy: true });
    try {
      const r = await reapplyQualification(formId!);
      setReapply({ busy: false, msg: `${r.evaluated} resposta(s) reavaliadas · ${r.changed} mudaram de classificação.` });
    } catch (e) { setReapply({ busy: false, msg: e instanceof Error ? e.message : "Falha ao reaplicar." }); }
  }

  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void run()} disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-wa-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:brightness-110 disabled:opacity-50">
          {busy ? <Loader2 className="size-3.5" /> : <Sparkles className="size-3.5" />}
          Testar com as respostas recebidas
        </button>
        <button type="button" onClick={() => void doReapply()} disabled={reapply.busy}
          title="Usa os critérios salvos — salve antes se mudou algo"
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-xs font-medium text-ink-300 hover:bg-white/5 disabled:opacity-50">
          {reapply.busy ? <Loader2 className="size-3.5" /> : <RotateCcw className="size-3.5" />}
          Reclassificar respostas antigas
        </button>
      </div>
      <p className="text-[11px] text-ink-500">O teste usa o que está na tela, mesmo sem salvar. Reclassificar usa os critérios salvos.</p>
      {reapply.msg && <p className="text-xs text-wa-500">{reapply.msg}</p>}
      {err && <p className="text-xs text-red-300">{err}</p>}

      {sim && (
        <div className="space-y-3">
          {sim.total === 0 ? (
            <p className="text-xs text-ink-400">Nenhuma resposta ainda para testar.</p>
          ) : !sim.has_rules ? (
            <p className="text-xs text-ink-400">Adicione ao menos uma regra para ver o resultado.</p>
          ) : (
            <div className="rounded-xl border border-wa-500/30 bg-wa-500/5 px-4 py-3">
              <p className="text-2xl font-bold text-wa-500">{pct(sim.qualified, sim.total)}</p>
              <p className="text-xs text-ink-300">
                {sim.qualified} de {sim.total} resposta(s) seriam qualificadas com esses critérios.
              </p>
            </div>
          )}

          {sim.rules.length > 0 && sim.total > 0 && (
            <div className="rounded-xl border border-ink-800 bg-ink-950/50 px-4 py-3">
              <p className="mb-2 text-xs font-semibold text-ink-300">Quanto cada regra bate</p>
              {sim.rules.map((r) => (
                <div key={r.id} className="mb-1.5">
                  <div className="flex justify-between gap-3 text-xs">
                    <span className="truncate text-ink-300">{r.text}</span>
                    <span className="shrink-0 font-mono text-ink-400">{r.matched}/{sim.total}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/5">
                    <div className="h-full rounded-full bg-wa-500" style={{ width: pct(r.matched, sim.total) }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {sim.fields.map((b) => (
            <div key={b.field_id} className="rounded-xl border border-ink-800 bg-ink-950/50 px-4 py-3">
              <p className="text-xs font-semibold text-ink-300">{b.label}</p>
              <p className="mb-2 text-[11px] text-ink-500">{b.answered} resposta(s) · barra = quantos escolheram · verde = quantos desses qualificaram</p>
              {b.options.map((o) => {
                const max = Math.max(1, ...b.options.map((x) => x.count));
                return (
                  <div key={o.value} className="mb-1.5">
                    <div className="flex justify-between gap-3 text-xs">
                      <span className="truncate text-ink-300">{o.value}</span>
                      <span className="shrink-0 font-mono text-ink-400">
                        {o.count}{sim.has_rules && o.count > 0 && <> · <span className="text-wa-500">{pct(o.qualified, o.count)}</span></>}
                      </span>
                    </div>
                    <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-white/5">
                      <div className="absolute inset-y-0 left-0 rounded-full bg-ink-600" style={{ width: `${(o.count / max) * 100}%` }} />
                      {sim.has_rules && (
                        <div className="absolute inset-y-0 left-0 rounded-full bg-wa-500" style={{ width: `${(o.qualified / max) * 100}%` }} />
                      )}
                    </div>
                  </div>
                );
              })}
              {b.answered > 0 && b.options.every((o) => o.count === 0 || o.count === b.answered) && (
                <p className="mt-1 text-[11px] text-amber-300">Todo mundo responde igual: essa pergunta não ajuda a separar leads.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
