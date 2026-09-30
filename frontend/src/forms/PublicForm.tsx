import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2, Star } from './icons';
import type { LeadFormField, LeadFormSettings, LeadFormTheme } from './client';
import {
  DEFAULT_SETTINGS, DEFAULT_THEME, FONT_STACK, RADIUS_PX, contrastOn, fieldPlaceholder,
  pageBackground, validateAnswer, withAlpha,
} from './formKit';

// Página PÚBLICA do formulário de captação (/f/{slug}), no mesmo domínio do
// painel e sem login. Dois formatos, escolhidos no editor: uma pergunta por vez
// (estilo Typeform) ou página única. Aparência, logo e comportamento vêm do painel.
//
// Com a tag de jornada ligada, a página carrega o tl.js da linha: a visita ganha
// TL_ID, UTMs e click ids, e o envio leva o TL_ID — o lead chega no CRM com a
// origem da campanha já recuperada.

interface PublicForm {
  slug: string; headline: string; description: string;
  fields: LeadFormField[]; theme: LeadFormTheme;
  thank_you: string; pixel_id?: string; logo_url?: string;
  settings?: Partial<LeadFormSettings>;
  site_key?: string | null;
}

/** Carrega a tag de jornada da linha (a mesma do site do cliente). */
function loadJourneyTag(siteKey: string) {
  if (document.querySelector("script[data-tl-form]")) return;
  const s = document.createElement("script");
  s.async = true;
  s.src = `/t/tl.js?k=${encodeURIComponent(siteKey)}`;
  s.setAttribute("data-tl-form", "1");
  document.head.appendChild(s);
}

function journeyId(): string {
  const w = window as unknown as { tracklabs?: { tl?: string } };
  return w.tracklabs?.tl || "";
}

type Answer = string | string[];

// Injeta o Meta Pixel uma única vez e dispara PageView.
function initMetaPixel(pixelId: string) {
  const w = window as unknown as { fbq?: (...a: unknown[]) => void; _fbq?: unknown };
  if (w.fbq) { w.fbq("init", pixelId); w.fbq("track", "PageView"); return; }
  /* eslint-disable */
  (function (f: any, b: any, e: any, v: any, n?: any, t?: any, s?: any) {
    if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
    t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
  /* eslint-enable */
  w.fbq!("init", pixelId); w.fbq!("track", "PageView");
}

function cookie(name: string): string {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : "";
}

// ID único do evento: vai no Pixel (navegador) e na CAPI (servidor) para o Meta
// deduplicar a mesma conversão enviada pelos dois caminhos.
function newEventId(): string {
  const c = window.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `lead-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const ANIM = `
@keyframes fqIn { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
.fq-in { animation: fqIn .45s cubic-bezier(.2,.7,.3,1) both; }
.fq-form input::placeholder, .fq-form textarea::placeholder { opacity: .38; }
`;

export default function PublicFormPage({ slug }: { slug: string }) {
  const [form, setForm] = useState<PublicForm | null>(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState(-1);            // -1 = capa, 0..n-1 = perguntas
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState("");
  const [redirecting, setRedirecting] = useState(0);
  // destino depois do envio: o WhatsApp da linha (montado no servidor, com o
  // TL_ID) ou a URL configurada
  const [redirectTo, setRedirectTo] = useState("");
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    fetch(`/api/forms/public/${slug}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).detail || "Indisponível"); return r.json(); })
      .then((f: PublicForm) => {
        setForm(f);
        if (f.headline) document.title = f.headline;
        if (!(f.settings?.show_cover ?? true)) setStep(0);
        if (f.pixel_id) { try { initMetaPixel(f.pixel_id); } catch { /* noop */ } }
        if (f.site_key) { try { loadJourneyTag(f.site_key); } catch { /* noop */ } }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Formulário indisponível."));
  }, [slug]);

  const theme: LeadFormTheme = { ...DEFAULT_THEME, ...(form?.theme || {}) };
  const cfg: LeadFormSettings = { ...DEFAULT_SETTINGS, ...(form?.settings || {}) };
  const fields = useMemo(() => form?.fields || [], [form]);
  const stepMode = cfg.layout === "step";
  const field = stepMode && step >= 0 ? fields[step] : null;
  const isLast = step === fields.length - 1;

  useEffect(() => { if (stepMode) inputRef.current?.focus(); }, [step, stepMode]);

  const progress = useMemo(() => {
    if (done) return 100;
    if (!fields.length) return 0;
    if (stepMode) return step < 0 ? 0 : Math.round((step / fields.length) * 100);
    const feitas = fields.filter((f) => {
      const v = answers[f.id];
      return Array.isArray(v) ? v.length > 0 : !!(v || "").trim();
    }).length;
    return Math.round((feitas / fields.length) * 100);
  }, [answers, done, fields, step, stepMode]);

  // redireciona depois do envio, quando configurado
  useEffect(() => {
    if (!done || !redirectTo) return;
    setRedirecting(cfg.redirect_delay);
    const t = window.setInterval(() => {
      setRedirecting((s) => {
        if (s <= 1) { window.clearInterval(t); window.location.href = redirectTo; return 0; }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  function setAnswer(id: string, v: Answer) {
    setAnswers((p) => ({ ...p, [id]: v }));
    setErrs((p) => (p[id] ? { ...p, [id]: "" } : p));
  }

  function toggleMulti(id: string, opt: string) {
    const atual = Array.isArray(answers[id]) ? (answers[id] as string[]) : [];
    setAnswer(id, atual.includes(opt) ? atual.filter((o) => o !== opt) : [...atual, opt]);
  }

  async function send() {
    if (!form) return;
    if (cfg.consent_enabled && !consent) {
      setErrs((p) => ({ ...p, __consent: "Marque o aceite para enviar." }));
      return;
    }
    setSending(true);
    setErrs({});
    const eventId = newEventId();
    try {
      const r = await fetch(`/api/forms/public/${slug}/submit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers, website: "", consent: cfg.consent_enabled ? consent : true,
          // dados do navegador usados pela CAPI (envio server-side do Lead)
          event_id: eventId, url: window.location.href,
          fbp: cookie("_fbp"), fbc: cookie("_fbc"),
          // ID da jornada do visitante (tag de jornada): liga o lead à campanha
          tl: journeyId(),
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Falha ao enviar.");
      if (form.pixel_id) {
        const w = window as unknown as { fbq?: (...a: unknown[]) => void };
        try { w.fbq?.("track", "Lead", {}, { eventID: eventId }); } catch { /* noop */ }
      }
      setRedirectTo(data.redirect_url || "");
      setDone(data.thank_you || "Obrigado!");
    } catch (e) {
      setErrs({ __form: e instanceof Error ? e.message : "Falha ao enviar — tente de novo." });
    } finally { setSending(false); }
  }

  // avança no formato "uma pergunta por vez"
  function next() {
    if (!field) return;
    const msg = validateAnswer(field, answers[field.id] ?? "");
    if (msg) { setErrs((p) => ({ ...p, [field.id]: msg })); return; }
    if (!isLast) { setStep(step + 1); return; }
    send();
  }

  // valida tudo e envia no formato "página única"
  function submitPage() {
    const found: Record<string, string> = {};
    for (const f of fields) {
      const msg = validateAnswer(f, answers[f.id] ?? "");
      if (msg) found[f.id] = msg;
    }
    if (Object.keys(found).length) {
      setErrs(found);
      const first = fields.find((f) => found[f.id]);
      if (first) document.getElementById(`campo-${first.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    send();
  }

  function onKey(e: React.KeyboardEvent) {
    if (!stepMode || done || e.key !== "Enter") return;
    // textarea usa Enter para pular linha; botões (opções, voltar) já tratam o
    // próprio clique — avançar aqui também causaria salto duplo.
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    if (step < 0) setStep(0); else next();
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-center text-zinc-400">
        <p>{error}</p>
      </div>
    );
  }
  if (!form) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: theme.bg }}>
        <Loader2 className="size-6 animate-spin" style={{ color: theme.primary }} />
      </div>
    );
  }

  const radius = RADIUS_PX[theme.radius];
  const cardRadius = Math.min(radius + 6, 26);
  const btn = {
    background: theme.primary, color: contrastOn(theme.primary), borderRadius: radius,
  };
  const logo = form.logo_url ? (
    <img src={form.logo_url} alt="" className="w-auto object-contain"
      style={{ height: cfg.logo_size, maxWidth: 240 }} />
  ) : null;

  return (
    <div className="fq-form flex min-h-screen flex-col" onKeyDown={onKey}
      style={{ background: pageBackground(theme), color: theme.text, fontFamily: FONT_STACK[theme.font] }}>
      <style>{ANIM}</style>

      {cfg.show_progress && (
        <div className="sticky top-0 z-10 h-1 w-full" style={{ background: withAlpha(theme.text, 0.12) }}>
          <div className="h-full transition-all duration-500" style={{ width: `${progress}%`, background: theme.primary }} />
        </div>
      )}

      {logo && (
        <header className="mx-auto w-full max-w-2xl px-6 pt-7">
          {logo}
        </header>
      )}

      <main className={`mx-auto flex w-full flex-1 flex-col px-6 py-10 ${
        stepMode ? "max-w-2xl justify-center" : "max-w-2xl"}`}>
        {done ? (
          // ---------------------------- tela final ----------------------------
          <div className="fq-in text-center">
            <div className="mx-auto flex size-16 items-center justify-center rounded-full"
              style={{ background: theme.primary, color: contrastOn(theme.primary) }}>
              <Check className="size-8" />
            </div>
            <h1 className="mt-6 whitespace-pre-line text-2xl font-bold leading-snug">{done}</h1>
            {redirectTo && (
              <p className="mt-4 text-sm opacity-60">
                {redirectTo.startsWith("https://wa.me/") ? "Abrindo o WhatsApp" : "Redirecionando"} em {redirecting}s…{" "}
                <a href={redirectTo} className="underline" style={{ color: theme.primary }}>ir agora</a>
              </p>
            )}
          </div>
        ) : stepMode && step === -1 ? (
          // ------------------------------- capa -------------------------------
          <div className="fq-in">
            <h1 className="text-3xl font-bold leading-tight md:text-[2.6rem]">{form.headline}</h1>
            {form.description && <p className="mt-4 text-base leading-relaxed opacity-70 md:text-lg">{form.description}</p>}
            <button onClick={() => setStep(0)}
              className="mt-9 inline-flex items-center gap-2 px-7 py-3.5 text-base font-bold transition-transform hover:scale-[1.02]"
              style={btn}>
              {cfg.cover_button || "Começar"} <ArrowRight className="size-5" />
            </button>
            <p className="mt-3 text-xs opacity-50">
              {fields.length} pergunta{fields.length === 1 ? "" : "s"} · leva menos de 1 minuto ⏱
            </p>
          </div>
        ) : stepMode && field ? (
          // ------------------------ uma pergunta por vez -----------------------
          <div key={field.id} className="fq-in">
            <p className="text-sm font-semibold" style={{ color: theme.primary }}>
              {step + 1} de {fields.length}
            </p>
            <h2 className="mt-2 text-2xl font-bold leading-snug md:text-3xl">
              {field.label}
              {field.required && <span style={{ color: theme.primary }}> *</span>}
            </h2>
            {field.help && <p className="mt-2 text-sm leading-relaxed opacity-60">{field.help}</p>}

            <div className="mt-7">
              <FieldInput field={field} value={answers[field.id] ?? ""} theme={theme} big
                inputRef={inputRef}
                onChange={(v) => setAnswer(field.id, v)}
                onToggle={(opt) => toggleMulti(field.id, opt)}
                onPick={(opt) => {
                  setAnswer(field.id, opt);
                  if (!isLast) window.setTimeout(() => setStep((s) => (s === step ? s + 1 : s)), 260);
                }} />
            </div>

            {errs[field.id] && <p className="mt-3 text-sm font-medium" style={{ color: "#f87171" }}>{errs[field.id]}</p>}

            {isLast && cfg.consent_enabled && (
              <ConsentBox text={cfg.consent_text} checked={consent} theme={theme} radius={radius}
                error={errs.__consent} onChange={(v) => { setConsent(v); setErrs((p) => ({ ...p, __consent: "" })); }} />
            )}
            {errs.__form && <p className="mt-3 text-sm font-medium" style={{ color: "#f87171" }}>{errs.__form}</p>}

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button onClick={next} disabled={sending}
                className="inline-flex items-center gap-2 px-7 py-3.5 text-base font-bold transition-transform hover:scale-[1.02] disabled:opacity-60"
                style={btn}>
                {sending && <Loader2 className="size-5 animate-spin" />}
                {isLast ? theme.button || "Enviar" : "OK"}
                {!isLast && !sending && <ArrowRight className="size-5" />}
              </button>
              {step > 0 && (
                <button onClick={() => setStep(step - 1)}
                  className="inline-flex items-center gap-1 text-sm opacity-60 transition-opacity hover:opacity-100">
                  <ArrowLeft className="size-4" /> Voltar
                </button>
              )}
              <span className="hidden text-xs opacity-40 sm:inline">pressione Enter ↵</span>
            </div>
          </div>
        ) : (
          // --------------------------- página única ---------------------------
          <div className="fq-in">
            <h1 className="text-3xl font-bold leading-tight md:text-4xl">{form.headline}</h1>
            {form.description && <p className="mt-3 text-base leading-relaxed opacity-70">{form.description}</p>}

            <div className="mt-8 space-y-5">
              {fields.map((f, i) => (
                <div key={f.id} id={`campo-${f.id}`} className="p-5"
                  style={{
                    background: withAlpha(theme.text, 0.04), borderRadius: cardRadius,
                    border: `1px solid ${errs[f.id] ? "#f87171" : withAlpha(theme.text, 0.08)}`,
                  }}>
                  <label className="block text-base font-semibold leading-snug">
                    <span className="mr-1.5 text-xs font-bold opacity-40">{i + 1}.</span>
                    {f.label}
                    {f.required && <span style={{ color: theme.primary }}> *</span>}
                  </label>
                  {f.help && <p className="mt-1 text-xs leading-relaxed opacity-60">{f.help}</p>}
                  <div className="mt-3">
                    <FieldInput field={f} value={answers[f.id] ?? ""} theme={theme}
                      onChange={(v) => setAnswer(f.id, v)}
                      onToggle={(opt) => toggleMulti(f.id, opt)}
                      onPick={(opt) => setAnswer(f.id, opt)} />
                  </div>
                  {errs[f.id] && <p className="mt-2 text-sm font-medium" style={{ color: "#f87171" }}>{errs[f.id]}</p>}
                </div>
              ))}
            </div>

            {cfg.consent_enabled && (
              <ConsentBox text={cfg.consent_text} checked={consent} theme={theme} radius={radius}
                error={errs.__consent} onChange={(v) => { setConsent(v); setErrs((p) => ({ ...p, __consent: "" })); }} />
            )}
            {errs.__form && <p className="mt-4 text-sm font-medium" style={{ color: "#f87171" }}>{errs.__form}</p>}

            <button onClick={submitPage} disabled={sending}
              className="mt-7 inline-flex w-full items-center justify-center gap-2 px-7 py-4 text-base font-bold transition-transform hover:scale-[1.01] disabled:opacity-60 sm:w-auto"
              style={btn}>
              {sending && <Loader2 className="size-5 animate-spin" />}
              {theme.button || "Enviar"}
            </button>
          </div>
        )}
      </main>

      {cfg.show_branding && (
        <footer className="pb-6 text-center text-[11px] opacity-40">
          {cfg.branding_text}
        </footer>
      )}
    </div>
  );
}

// --------------------------- controles por tipo ----------------------------
function FieldInput({ field, value, theme, big, inputRef, onChange, onToggle, onPick }: {
  field: LeadFormField;
  value: Answer;
  theme: LeadFormTheme;
  big?: boolean;
  inputRef?: React.MutableRefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  onChange: (v: string) => void;
  onToggle: (opt: string) => void;
  onPick: (opt: string) => void;
}) {
  const radius = RADIUS_PX[theme.radius];
  const soft = Math.min(radius, 18);
  const str = Array.isArray(value) ? "" : value;
  const list = Array.isArray(value) ? value : [];
  // Fundo claro precisa de color-scheme claro, senão os controles nativos
  // (calendário do type=date, lista do select) saem escuros e ilegíveis.
  const scheme: "dark" | "light" = contrastOn(theme.bg) === "#ffffff" ? "dark" : "light";
  const boxed: React.CSSProperties = {
    borderColor: withAlpha(theme.text, 0.22), color: theme.text, borderRadius: soft,
    background: withAlpha(theme.text, 0.04), colorScheme: scheme,
  };

  if (field.type === "choice" || field.type === "multi") {
    const multi = field.type === "multi";
    return (
      <div className="space-y-2.5">
        {field.options.map((opt, i) => {
          const sel = multi ? list.includes(opt) : str === opt;
          return (
            <button key={opt} type="button"
              onClick={() => (multi ? onToggle(opt) : onPick(opt))}
              className="flex w-full items-center gap-3 border-2 px-4 py-3.5 text-left font-medium transition-all hover:scale-[1.01]"
              style={{
                borderColor: sel ? theme.primary : withAlpha(theme.text, 0.16),
                background: sel ? withAlpha(theme.primary, 0.16) : "transparent",
                borderRadius: soft, color: theme.text,
              }}>
              <span className="flex size-6 shrink-0 items-center justify-center text-[11px] font-bold"
                style={{
                  borderRadius: multi ? 6 : 999,
                  border: `1.5px solid ${sel ? theme.primary : withAlpha(theme.text, 0.28)}`,
                  background: sel ? theme.primary : "transparent",
                  color: sel ? contrastOn(theme.primary) : withAlpha(theme.text, 0.6) as string,
                }}>
                {sel ? <Check className="size-3.5" /> : String.fromCharCode(65 + i)}
              </span>
              <span className="flex-1">{opt}</span>
            </button>
          );
        })}
        {multi && <p className="text-xs opacity-50">Você pode marcar mais de uma opção.</p>}
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <select value={str} onChange={(e) => onChange(e.target.value)}
        className="w-full border-2 bg-transparent px-4 py-3 text-base outline-none"
        style={boxed}>
        <option value="" style={{ color: "#111" }}>Selecione…</option>
        {field.options.map((o) => <option key={o} value={o} style={{ color: "#111" }}>{o}</option>)}
      </select>
    );
  }

  if (field.type === "rating") {
    const nota = Number(str || 0);
    return (
      <div className="flex items-center gap-2">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" onClick={() => onPick(String(n))} title={`Nota ${n}`}
            className="transition-transform hover:scale-110">
            <Star className={big ? "size-9" : "size-7"}
              style={{
                color: n <= nota ? theme.primary : withAlpha(theme.text, 0.3),
                fill: n <= nota ? theme.primary : "transparent",
              }} />
          </button>
        ))}
        {nota > 0 && <span className="ml-1 text-sm opacity-60">{nota} de 5</span>}
      </div>
    );
  }

  if (field.type === "textarea") {
    return (
      <textarea
        ref={(el) => { if (inputRef) inputRef.current = el; }}
        value={str} onChange={(e) => onChange(e.target.value)}
        rows={big ? 4 : 3} placeholder={fieldPlaceholder(field)}
        className="w-full border-2 bg-transparent px-4 py-3 text-base outline-none"
        style={boxed} />
    );
  }

  const type = field.type === "email" ? "email"
    : field.type === "phone" ? "tel"
    : field.type === "number" ? "number"
    : field.type === "date" ? "date"
    : field.type === "url" ? "url" : "text";

  // No formato "uma pergunta por vez" o campo é uma linha grande sublinhada;
  // na página única ele fica dentro de uma caixa, junto às outras perguntas.
  return (
    <input
      ref={(el) => { if (inputRef) inputRef.current = el; }}
      type={type}
      inputMode={field.type === "phone" ? "tel" : field.type === "number" ? "decimal" : undefined}
      value={str} onChange={(e) => onChange(e.target.value)}
      placeholder={fieldPlaceholder(field)}
      className={big
        ? "w-full border-0 border-b-2 bg-transparent px-1 py-3 text-2xl outline-none md:text-3xl"
        : "w-full border-2 bg-transparent px-4 py-3 text-base outline-none"}
      style={big
        ? { borderColor: theme.primary, color: theme.text, colorScheme: scheme }
        : boxed} />
  );
}

function ConsentBox({ text, checked, theme, radius, error, onChange }: {
  text: string; checked: boolean; theme: LeadFormTheme; radius: number;
  error?: string; onChange: (v: boolean) => void;
}) {
  return (
    <div className="mt-6">
      <label className="flex cursor-pointer items-start gap-3 p-4"
        style={{
          borderRadius: Math.min(radius + 4, 20),
          background: withAlpha(theme.text, 0.04),
          border: `1px solid ${error ? "#f87171" : withAlpha(theme.text, 0.1)}`,
        }}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 size-4 shrink-0" style={{ accentColor: theme.primary }} />
        <span className="text-sm leading-relaxed opacity-80">{text}</span>
      </label>
      {error && <p className="mt-2 text-sm font-medium" style={{ color: "#f87171" }}>{error}</p>}
    </div>
  );
}
