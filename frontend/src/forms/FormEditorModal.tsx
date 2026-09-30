// Configurações do Formulário — modal organizado por categorias (Geral,
// Aparência, Perguntas, Comportamento, Notificações, Integrações), com busca
// global, seções recolhíveis e prévia ao vivo da página pública.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle, ArrowDown, ArrowUp, Bell, Check, ChevronDown, ChevronsDownUp,
  ChevronsUpDown, Copy, Crosshair, Eye, EyeOff, HelpCircle, ImageIcon,
  Keyboard, Layers, ListChecks, Loader2, MonitorPlay, Palette, Plus, Search, Settings2,
  Shield, Sparkles, Trash2, Upload, X,
} from './icons';
import {
  createForm, updateForm,
  type FormLine, type LeadForm, type LeadFormField, type LeadFormFieldType,
  type LeadFormSettings, type LeadFormTheme,
} from './client';
import {
  DEFAULT_SETTINGS, DEFAULT_THEME, FIELD_TYPES, FONT_LABEL, FONT_STACK, OPTION_TYPES,
  RADIUS_LABEL, RADIUS_PX, contrastOn, emptyField, fileToLogoDataUrl, pageBackground,
  withAlpha,
} from './formKit';
import { FormAiModal } from './FormAiModal';

type Cat = "geral" | "aparencia" | "perguntas" | "comportamento" | "notificacoes" | "integracoes";

const CATS: { id: Cat; label: string; icon: typeof Settings2; desc: string }[] = [
  { id: "geral", label: "Geral", icon: Settings2, desc: "Nome, linha, publicação e link" },
  { id: "aparencia", label: "Aparência", icon: Palette, desc: "Logo, cores, fonte e formas" },
  { id: "perguntas", label: "Perguntas", icon: ListChecks, desc: "Campos que o lead responde" },
  { id: "comportamento", label: "Comportamento", icon: MonitorPlay, desc: "Layout, capa e pós-envio" },
  { id: "notificacoes", label: "Notificações", icon: Bell, desc: "WhatsApp e webhook" },
  { id: "integracoes", label: "Integrações", icon: Crosshair, desc: "Jornada, Pixel e Conversions API" },
];

interface Sec {
  id: string; cat: Cat; title: string; desc: string; icon: typeof Settings2;
  kw: string; body: ReactNode;
}

const INPUT = "w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm outline-none"
  + " transition-colors placeholder:text-ink-600 focus:border-wa-500/70"
  + " focus:ring-2 focus:ring-wa-500/20";

export function FormEditorModal({ form, clients, defaultLine = 0, draft, onClose, onSaved }: {
  form: LeadForm | null;
  /** linhas (clientes) que o usuário vê — o formulário pertence a uma delas */
  clients: FormLine[];
  defaultLine?: number;
  /** Rascunho da IA usado para semear um formulário novo (não salvo ainda). */
  draft?: Partial<LeadForm> | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState({
    title: form?.title || draft?.title || "",
    headline: form?.headline || draft?.headline || "",
    description: form?.description || draft?.description || "",
    wa_number_id: form?.wa_number_id || draft?.wa_number_id || defaultLine || clients[0]?.id || 0,
    thank_you: form?.thank_you || draft?.thank_you || "Obrigado! Em breve entraremos em contato. 💚",
    whatsapp_notify: form?.whatsapp_notify ?? "",
    create_lead: form?.create_lead ?? true,
    active: form?.active ?? true,
    pixel_id: form?.pixel_id || "",
    capi_token: form?.capi_token || "",
    logo_url: form?.logo_url || "",
    theme: { ...DEFAULT_THEME, ...(form?.theme || {}) } as LeadFormTheme,
    settings: { ...DEFAULT_SETTINGS, ...(form?.settings || {}) } as LeadFormSettings,
  });
  const [fields, setFields] = useState<LeadFormField[]>(
    form?.fields?.length ? form.fields
      : draft?.fields?.length ? draft.fields
      : [
          { ...emptyField(1), id: "q1", label: "Qual o seu nome?", type: "text" },
          { ...emptyField(2), id: "q2", label: "Qual o seu WhatsApp?", type: "phone" },
        ],
  );
  const [cat, setCat] = useState<Cat>("geral");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoErr, setLogoErr] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [copied, setCopied] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);   // gerar perguntas com IA
  const searchRef = useRef<HTMLInputElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);

  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => setD((p) => ({ ...p, [k]: v }));
  const setTheme = (patch: Partial<LeadFormTheme>) => setD((p) => ({ ...p, theme: { ...p.theme, ...patch } }));
  const setCfg = (patch: Partial<LeadFormSettings>) => setD((p) => ({ ...p, settings: { ...p.settings, ...patch } }));

  // Atalhos: Esc fecha, ←/→ trocam de categoria, Ctrl/⌘+K foca a busca.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if (e.key === "Escape") {
        if (shortcuts) { setShortcuts(false); return; }
        if (typing && query) { setQuery(""); return; }
        onClose(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const i = CATS.findIndex((c) => c.id === cat);
        const next = (i + (e.key === "ArrowRight" ? 1 : CATS.length - 1)) % CATS.length;
        setQuery(""); setCat(CATS[next].id);
      }
      if (e.key === "?") setShortcuts(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cat, onClose, query, shortcuts]);

  const publicLink = form ? `${window.location.origin}/f/${form.slug}` : "";
  async function copyLink() {
    if (!publicLink) return;
    try { await navigator.clipboard.writeText(publicLink); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { window.prompt("Copie o link:", publicLink); }
  }

  // -------------------------------- perguntas --------------------------------
  function patchField(i: number, patch: Partial<LeadFormField>) {
    setFields((p) => p.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }
  function moveField(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= fields.length) return;
    const arr = [...fields];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    setFields(arr);
  }

  // ----------------------------------- logo ----------------------------------
  async function pickLogo(file: File | undefined) {
    if (!file) return;
    setLogoErr(""); setLogoBusy(true);
    try { set("logo_url", await fileToLogoDataUrl(file)); }
    catch (e) { setLogoErr(e instanceof Error ? e.message : "Falha ao carregar a imagem."); }
    finally { setLogoBusy(false); if (logoInput.current) logoInput.current.value = ""; }
  }

  // ----------------------------------- salvar --------------------------------
  async function save() {
    if (!d.title.trim()) { setCat("geral"); setErr("Dê um nome interno ao formulário."); return; }
    if (!d.wa_number_id) { setCat("geral"); setErr("Escolha a linha (cliente) que recebe os leads."); return; }
    if (!fields.length) { setCat("perguntas"); setErr("Adicione ao menos uma pergunta."); return; }
    const semLabel = fields.findIndex((f) => !f.label.trim());
    if (semLabel >= 0) { setCat("perguntas"); setErr(`Escreva o texto da pergunta ${semLabel + 1}.`); return; }
    const semOpcao = fields.findIndex((f) => OPTION_TYPES.includes(f.type) && f.options.length < 2);
    if (semOpcao >= 0) {
      setCat("perguntas");
      setErr(`A pergunta ${semOpcao + 1} precisa de pelo menos 2 opções.`); return;
    }
    if ((d.capi_token.trim() || form?.capi_token__set) && !d.pixel_id.trim()) {
      setCat("integracoes"); setErr("Para usar o token da CAPI, preencha também o ID do Pixel."); return;
    }
    setBusy(true); setErr("");
    try {
      const payload = { ...d, wa_number_id: d.wa_number_id || null, fields };
      if (form) await updateForm(form.id, payload);
      else await createForm(payload);
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : "Falha ao salvar."); }
    finally { setBusy(false); }
  }

  // --------------------------------- seções ----------------------------------
  const sections: Sec[] = [
    {
      id: "publicacao", cat: "geral", icon: Shield, title: "Publicação",
      desc: "Controle como o formulário fica acessível e o que acontece com cada resposta",
      kw: "publicar ativo pausado link slug pipeline lead crm",
      body: (
        <>
          <SettingRow label="Publicar formulário" required
            hint="Com o formulário publicado, qualquer pessoa com o link consegue responder. Pausado, o link mostra um aviso de indisponível."
            help="Pausar não apaga nada — as respostas já recebidas continuam no painel.">
            <Toggle checked={d.active} onChange={(v) => set("active", v)} />
          </SettingRow>
          <SettingRow label="Criar lead no CRM"
            hint="Cada resposta abre automaticamente um card na etapa “Lead” do CRM da linha."
            help="Nome, telefone e e-mail são detectados pelos tipos das perguntas.">
            <Toggle checked={d.create_lead} onChange={(v) => set("create_lead", v)} />
          </SettingRow>
          {form && (
            <div className="rounded-xl border border-ink-800 bg-ink-950/50 px-4 py-3">
              <p className="text-sm font-semibold">Link público</p>
              <p className="mt-0.5 text-xs text-ink-400">Use este endereço como destino das campanhas.</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-ink-950/70 px-3 py-2 font-mono text-xs text-wa-500">
                  {publicLink}
                </code>
                <button type="button" onClick={copyLink} className={btnGhost}>
                  {copied ? <Check className="size-3.5 text-wa-500" /> : <Copy className="size-3.5" />}
                  {copied ? "Copiado" : "Copiar"}
                </button>
                <a href={publicLink} target="_blank" rel="noreferrer" className={btnGhost}>
                  <Eye className="size-3.5" /> Abrir
                </a>
              </div>
            </div>
          )}
        </>
      ),
    },
    {
      id: "identificacao", cat: "geral", icon: Layers, title: "Identificação",
      desc: "Como o formulário aparece no painel e o texto que abre a página",
      kw: "nome interno cliente titulo headline subtitulo descricao",
      body: (
        <>
          <Field label="Nome interno" required hint="Só a equipe vê — usado nas listas e no aviso de novo lead.">
            <input className={INPUT} value={d.title} placeholder="Captação — Cliente X"
              onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field label="Linha (cliente)" required hint="As respostas viram conversas no CRM desta linha, e o aviso de novo lead sai pelo WhatsApp dela.">
            <select className={INPUT} value={d.wa_number_id}
              onChange={(e) => set("wa_number_id", Number(e.target.value))}>
              {!d.wa_number_id && <option value={0}>— escolha a linha —</option>}
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Título mostrado ao lead" hint="A promessa principal da página. Vazio = usa o nome interno.">
            <input className={INPUT} value={d.headline} placeholder="Quer triplicar suas vendas com tráfego pago?"
              onChange={(e) => set("headline", e.target.value)} />
          </Field>
          <Field label="Subtítulo" hint="Uma linha de apoio explicando o que o lead recebe.">
            <input className={INPUT} value={d.description}
              placeholder="Responda 4 perguntas rápidas e receba um diagnóstico gratuito."
              onChange={(e) => set("description", e.target.value)} />
          </Field>
        </>
      ),
    },
    {
      id: "marca", cat: "aparencia", icon: ImageIcon, title: "Marca da empresa",
      desc: "Logo exibida no topo do formulário — opcional",
      kw: "logo marca logotipo imagem empresa upload branding",
      body: (
        <>
          <div className="rounded-xl border border-ink-800 bg-ink-950/50 p-4">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex h-20 w-32 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed border-ink-700 bg-[repeating-conic-gradient(#ffffff0a_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
                {d.logo_url ? (
                  <img src={d.logo_url} alt="Logo do formulário" className="max-h-16 max-w-28 object-contain" />
                ) : (
                  <ImageIcon className="size-6 text-ink-600" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Logo (opcional)</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-400">
                  PNG, JPG, WebP ou SVG até 5 MB. A imagem é reduzida no navegador antes de salvar,
                  então a página pública continua leve. Prefira fundo transparente.
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => logoInput.current?.click()} disabled={logoBusy} className={btnGhost}>
                    {logoBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                    {d.logo_url ? "Trocar imagem" : "Enviar imagem"}
                  </button>
                  {d.logo_url && (
                    <button type="button" onClick={() => { set("logo_url", ""); setLogoErr(""); }}
                      className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-400 hover:text-red-300">
                      <Trash2 className="size-3.5" /> Remover
                    </button>
                  )}
                  <input ref={logoInput} type="file" accept="image/*" className="hidden"
                    onChange={(e) => pickLogo(e.target.files?.[0])} />
                </div>
                {logoErr && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-red-300">
                    <AlertCircle className="size-3.5" /> {logoErr}
                  </p>
                )}
              </div>
            </div>
          </div>
          <Field label="Ou cole a URL da imagem" hint="Útil quando a logo já está hospedada no site do cliente.">
            <input className={INPUT} value={d.logo_url.startsWith("data:") ? "" : d.logo_url}
              placeholder="https://cliente.com.br/logo.png"
              onChange={(e) => set("logo_url", e.target.value.trim())}
              disabled={d.logo_url.startsWith("data:")} />
            {d.logo_url.startsWith("data:") && (
              <p className="mt-1 text-[11px] text-ink-400">
                Uma imagem enviada está em uso. Remova-a para usar uma URL.
              </p>
            )}
          </Field>
          <SettingRow label="Altura da logo" hint={`${d.settings.logo_size}px na página pública.`}>
            <input type="range" min={20} max={120} step={2} value={d.settings.logo_size}
              onChange={(e) => setCfg({ logo_size: Number(e.target.value) })}
              className="w-36 accent-wa-500" />
          </SettingRow>
        </>
      ),
    },
    {
      id: "cores", cat: "aparencia", icon: Palette, title: "Cores",
      desc: "Paleta aplicada em toda a página pública",
      kw: "cor cores paleta fundo texto principal gradiente tema",
      body: (
        <>
          {([["primary", "Cor principal", "Botões, destaques e barra de progresso."],
            ["bg", "Fundo da página", "Cor de base do formulário."],
            ["text", "Cor do texto", "Títulos, perguntas e respostas."]] as const).map(([k, label, hint]) => (
            <SettingRow key={k} label={label} hint={hint}>
              <div className="flex items-center gap-2">
                <input value={d.theme[k]} onChange={(e) => setTheme({ [k]: e.target.value } as Partial<LeadFormTheme>)}
                  className="w-24 rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 font-mono text-xs uppercase outline-none focus:border-wa-500/70" />
                <input type="color" value={d.theme[k]}
                  onChange={(e) => setTheme({ [k]: e.target.value } as Partial<LeadFormTheme>)}
                  className="size-9 cursor-pointer rounded-md border border-ink-700 bg-transparent" />
              </div>
            </SettingRow>
          ))}
          <SettingRow label="Fundo com gradiente"
            hint="Aplica um brilho suave da cor principal no topo da página."
            help="Desligue para um fundo totalmente sólido.">
            <Toggle checked={d.theme.gradient} onChange={(v) => setTheme({ gradient: v })} />
          </SettingRow>
          <SettingRow label="Paletas prontas" hint="Um clique para combinações que já funcionam bem.">
            <div className="flex flex-wrap gap-1.5">
              {PALETTES.map((p) => (
                <button key={p.name} type="button" title={p.name}
                  onClick={() => setTheme({ primary: p.primary, bg: p.bg, text: p.text })}
                  className="flex size-8 items-center justify-center rounded-lg border border-ink-700 hover:scale-105"
                  style={{ background: p.bg }}>
                  <span className="size-3.5 rounded-full" style={{ background: p.primary }} />
                </button>
              ))}
            </div>
          </SettingRow>
        </>
      ),
    },
    {
      id: "tipografia", cat: "aparencia", icon: Sparkles, title: "Tipografia e formas",
      desc: "Fonte, arredondamento dos elementos e texto dos botões",
      kw: "fonte tipografia serif mono arredondamento raio botao texto",
      body: (
        <>
          <SettingRow label="Fonte" hint="Aplicada em toda a página pública.">
            <div className="flex gap-1.5">
              {(Object.keys(FONT_LABEL) as LeadFormTheme["font"][]).map((f) => (
                <button key={f} type="button" onClick={() => setTheme({ font: f })}
                  style={{ fontFamily: FONT_STACK[f] }}
                  className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                    d.theme.font === f ? "border-wa-500 bg-wa-500/15 text-ink-100" : "border-ink-700 text-ink-400 hover:bg-white/5"}`}>
                  {FONT_LABEL[f]}
                </button>
              ))}
            </div>
          </SettingRow>
          <SettingRow label="Cantos" hint="Arredondamento de campos, cartões e botões.">
            <div className="flex gap-1.5">
              {(Object.keys(RADIUS_LABEL) as LeadFormTheme["radius"][]).map((r) => (
                <button key={r} type="button" onClick={() => setTheme({ radius: r })}
                  className={`border px-2.5 py-1.5 text-xs transition-colors ${
                    d.theme.radius === r ? "border-wa-500 bg-wa-500/15 text-ink-100" : "border-ink-700 text-ink-400 hover:bg-white/5"}`}
                  style={{ borderRadius: Math.min(RADIUS_PX[r], 14) }}>
                  {RADIUS_LABEL[r]}
                </button>
              ))}
            </div>
          </SettingRow>
          <Field label="Texto do botão de envio" hint="O botão da última pergunta.">
            <input className={INPUT} value={d.theme.button} placeholder="Enviar"
              onChange={(e) => setTheme({ button: e.target.value })} />
          </Field>
          <Field label="Texto do botão da capa" hint="Aparece quando a capa está ligada.">
            <input className={INPUT} value={d.settings.cover_button} placeholder="Começar"
              onChange={(e) => setCfg({ cover_button: e.target.value })} />
          </Field>
        </>
      ),
    },
    {
      id: "campos", cat: "perguntas", icon: ListChecks, title: "Perguntas do formulário",
      desc: "11 tipos de campo — os tipos e-mail e telefone alimentam o lead do CRM",
      kw: "pergunta campo tipo obrigatorio opcoes placeholder ajuda nota data numero lista",
      body: (
        <div className="space-y-2.5">
          {fields.map((q, i) => (
            <FieldCard key={q.id || i} f={q} index={i} total={fields.length}
              onPatch={(patch) => patchField(i, patch)}
              onMove={(dir) => moveField(i, dir)}
              onRemove={() => setFields(fields.filter((_, j) => j !== i))}
              onDuplicate={() => setFields([
                ...fields.slice(0, i + 1),
                { ...q, id: emptyField(Date.now()).id },
                ...fields.slice(i + 1),
              ])} />
          ))}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setFields([...fields, emptyField(Date.now())])}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-dashed border-wa-500/40 bg-wa-500/5 py-3 text-sm font-semibold text-wa-500 transition-colors hover:bg-wa-500/10">
              <Plus className="size-4" /> Adicionar pergunta
            </button>
            <button type="button" onClick={() => setAiOpen(true)}
              className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-ink-700 px-4 py-3 text-sm font-semibold text-ink-400 transition-colors hover:border-wa-500/40 hover:text-ink-100">
              <Sparkles className="size-4" /> Gerar com IA
            </button>
          </div>
          <p className="text-[11px] text-ink-400">
            {fields.length} de 30 perguntas. Formulários curtos (3 a 5) convertem melhor.
            Gerar com IA reescreve as perguntas seguindo um método de qualificação (BANT, SPIN…).
          </p>
        </div>
      ),
    },
    {
      id: "layout", cat: "comportamento", icon: MonitorPlay, title: "Layout e navegação",
      desc: "Como as perguntas são apresentadas ao lead",
      kw: "layout etapas typeform pagina unica capa progresso barra rodape marca",
      body: (
        <>
          <SettingRow label="Formato das perguntas" hint="Uma por vez costuma converter mais; página única é mais rápido de preencher.">
            <div className="flex gap-1.5">
              {([["step", "Uma por vez"], ["page", "Página única"]] as const).map(([v, l]) => (
                <button key={v} type="button" onClick={() => setCfg({ layout: v })}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    d.settings.layout === v ? "border-wa-500 bg-wa-500/15 text-ink-100" : "border-ink-700 text-ink-400 hover:bg-white/5"}`}>
                  {l}
                </button>
              ))}
            </div>
          </SettingRow>
          <SettingRow label="Mostrar capa de abertura"
            hint="Tela inicial com título, subtítulo e botão antes da primeira pergunta."
            help="Sem capa, o lead já cai na primeira pergunta — bom para tráfego frio e alto volume.">
            <Toggle checked={d.settings.show_cover} onChange={(v) => setCfg({ show_cover: v })} />
          </SettingRow>
          <SettingRow label="Barra de progresso" hint="Mostra o quanto falta para terminar.">
            <Toggle checked={d.settings.show_progress} onChange={(v) => setCfg({ show_progress: v })} />
          </SettingRow>
          <SettingRow label="Assinatura no rodapé"
            hint="Exibe uma linha de assinatura no fim da página.">
            <Toggle checked={d.settings.show_branding} onChange={(v) => setCfg({ show_branding: v })} />
          </SettingRow>
          {d.settings.show_branding && (
            <Field label="Texto da assinatura">
              <input className={INPUT} value={d.settings.branding_text}
                onChange={(e) => setCfg({ branding_text: e.target.value })} />
            </Field>
          )}
        </>
      ),
    },
    {
      id: "pos-envio", cat: "comportamento", icon: Check, title: "Depois do envio",
      desc: "Mensagem de agradecimento e redirecionamento",
      kw: "obrigado agradecimento mensagem redirecionar redirect url whatsapp destino",
      body: (
        <>
          <Field label="Mensagem de obrigado" hint="Aparece na tela final, junto do ícone de confirmação.">
            <textarea className={`${INPUT} min-h-[70px] resize-y`} value={d.thank_you}
              onChange={(e) => set("thank_you", e.target.value)} />
          </Field>
          <SettingRow label="Abrir o WhatsApp da linha ao terminar"
            hint="Depois do envio, o lead cai na conversa com a mensagem pronta — e o TL_ID da jornada vai junto, então a conversa já chega ligada a este formulário."
            help="Tem prioridade sobre o redirecionamento abaixo.">
            <Toggle checked={d.settings.whatsapp_redirect} onChange={(v) => setCfg({ whatsapp_redirect: v })} />
          </SettingRow>
          {d.settings.whatsapp_redirect && (
            <>
              <Field label="Número do WhatsApp" hint="Vazio = o número da própria linha (ela precisa ter sido conectada, senão o número não é conhecido e o lead fica na tela de obrigado).">
                <input className={INPUT} value={d.settings.whatsapp_phone} placeholder="5531999999999"
                  onChange={(e) => setCfg({ whatsapp_phone: e.target.value.replace(/\D/g, "") })} />
              </Field>
              <Field label="Mensagem pronta" hint="O que já vem escrito para o lead mandar.">
                <textarea className={`${INPUT} min-h-[60px] resize-y`} value={d.settings.whatsapp_message}
                  onChange={(e) => setCfg({ whatsapp_message: e.target.value })} />
              </Field>
            </>
          )}
          <Field label="Redirecionar para (opcional)"
            hint="Ao enviar, o lead é levado para este endereço. Vazio = fica na tela de obrigado.">
            <input className={INPUT} value={d.settings.redirect_url}
              placeholder="https://wa.me/5531999999999"
              onChange={(e) => setCfg({ redirect_url: e.target.value.trim() })} />
          </Field>
          {(d.settings.redirect_url || d.settings.whatsapp_redirect) && (
            <SettingRow label="Esperar antes de redirecionar"
              hint={`${d.settings.redirect_delay}s lendo a mensagem de obrigado — o Pixel precisa de um instante para disparar.`}>
              <input type="range" min={0} max={15} value={d.settings.redirect_delay}
                onChange={(e) => setCfg({ redirect_delay: Number(e.target.value) })}
                className="w-36 accent-wa-500" />
            </SettingRow>
          )}
          <SettingRow label="Consentimento (LGPD)"
            hint="Adiciona uma caixa de aceite obrigatória antes do envio."
            help="O envio é bloqueado no navegador e também no servidor enquanto o aceite não vier marcado.">
            <Toggle checked={d.settings.consent_enabled} onChange={(v) => setCfg({ consent_enabled: v })} />
          </SettingRow>
          {d.settings.consent_enabled && (
            <Field label="Texto do consentimento" hint="Escreva de forma clara o que o lead está autorizando.">
              <textarea className={`${INPUT} min-h-[60px] resize-y`} value={d.settings.consent_text}
                onChange={(e) => setCfg({ consent_text: e.target.value })} />
            </Field>
          )}
        </>
      ),
    },
    {
      id: "avisos", cat: "notificacoes", icon: Bell, title: "Avisos de novo lead",
      desc: "Para onde o formulário avisa quando alguém responde",
      kw: "whatsapp aviso notificacao numero webhook zapier n8n integracao",
      body: (
        <>
          <Field label="Avisar no WhatsApp" hint="Mensagem com o resumo da resposta, enviada pela instância da própria linha. Vazio = não avisa.">
            <input className={INPUT} value={d.whatsapp_notify} placeholder="31 99999-9999"
              onChange={(e) => set("whatsapp_notify", e.target.value)} />
          </Field>
          <Field label="Webhook (opcional)"
            hint="Enviamos um POST com a resposta em JSON assim que o lead chega — Zapier, Make, n8n ou seu CRM.">
            <input className={INPUT} value={d.settings.webhook_url}
              placeholder="https://hooks.zapier.com/hooks/catch/…"
              onChange={(e) => setCfg({ webhook_url: e.target.value.trim() })} />
            <p className="mt-1 text-[11px] text-ink-400">
              Endereços da rede interna são bloqueados por segurança. Para um n8n self-hosted,
              o servidor precisa liberar o host em <code className="font-mono">FORM_WEBHOOK_ALLOW_HOSTS</code>.
            </p>
          </Field>
          <div className="rounded-xl border border-ink-800 bg-ink-950/50 px-4 py-3">
            <p className="text-xs font-semibold text-ink-400">Formato enviado no webhook</p>
            <pre className="mt-1.5 overflow-x-auto rounded-md bg-ink-950/70 p-2.5 font-mono text-[11px] leading-relaxed text-ink-400">
{`{ "event": "form.response",
  "form": { "id": 1, "slug": "…", "title": "…" },
  "response_id": 42,
  "answers": { "Qual o seu nome?": "Ana" } }`}
            </pre>
          </div>
        </>
      ),
    },
    {
      id: "jornada", cat: "integracoes", icon: Layers, title: "Jornada do lead",
      desc: "TL_ID, UTMs e click IDs da visita ligados à resposta",
      kw: "jornada tl tag rastreamento utm gclid fbclid origem campanha",
      body: (
        <>
          <SettingRow label="Rastrear a jornada nesta página"
            hint="Carrega a tag da linha: a visita ganha TL_ID, UTMs e click IDs, e o envio leva o TL_ID. O lead chega no CRM com a origem da campanha."
            help="Use os links da campanha com as UTMs normais (?utm_source=…&gclid=…): a tag lê tudo sozinha.">
            <Toggle checked={d.settings.track_journey} onChange={(v) => setCfg({ track_journey: v })} />
          </SettingRow>
        </>
      ),
    },
    {
      id: "meta", cat: "integracoes", icon: Crosshair, title: "Rastreamento do Meta",
      desc: "Pixel no navegador e Conversions API no servidor",
      kw: "pixel meta facebook capi conversions api token evento lead rastreamento",
      body: (
        <>
          <Field label="Pixel do Meta (ID)" hint="Dispara PageView ao abrir e Lead na conversão.">
            <input className={INPUT} value={d.pixel_id} placeholder="123456789012345 (vazio = não rastreia)"
              onChange={(e) => set("pixel_id", e.target.value)} />
          </Field>
          <Field label="Token da Conversions API (CAPI)"
            hint="Envia o Lead também pelo servidor. Precisa do Pixel preenchido.">
            <div className="relative">
              <input className={`${INPUT} pr-10`} type={showToken ? "text" : "password"}
                autoComplete="off" spellCheck={false} value={d.capi_token}
                placeholder={form?.capi_token__set ? "•••••• já configurado — deixe vazio para manter" : "EAAG… (gerado no Gerenciador de Eventos)"}
                onChange={(e) => set("capi_token", e.target.value)} />
              <button type="button" onClick={() => setShowToken(!showToken)}
                title={showToken ? "Esconder token" : "Mostrar token"}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-ink-400 hover:text-ink-100">
                {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </Field>
          <p className="rounded-xl border border-ink-800 bg-ink-950/50 px-4 py-3 text-xs leading-relaxed text-ink-400">
            O evento vai com o mesmo <code className="font-mono text-wa-500">event_id</code> nos dois canais,
            então o Meta deduplica e não conta a conversão em dobro. O token nunca é exposto na página pública.
          </p>
        </>
      ),
    },
  ];

  const q = query.trim().toLowerCase();
  const shown = q
    ? sections.filter((s) => `${s.title} ${s.desc} ${s.kw} ${CATS.find((c) => c.id === s.cat)?.label}`
        .toLowerCase().includes(q))
    : sections.filter((s) => s.cat === cat);
  const allCollapsed = shown.length > 0 && shown.every((s) => collapsed.includes(s.id));
  const activeCat = CATS.find((c) => c.id === cat)!;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-3 backdrop-blur-sm md:p-6"
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="flex h-[94vh] w-full max-w-[1180px] flex-col overflow-hidden rounded-3xl border border-ink-700 bg-ink-900 shadow-2xl">

        {/* cabeçalho */}
        <div className="shrink-0 border-b border-ink-800 px-6 pb-4 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold tracking-tight">Configurações do Formulário</h2>
              <p className="text-sm text-ink-400">
                {form ? `Editando “${form.title}”` : "Configure todos os aspectos do seu formulário de forma organizada"}
              </p>
            </div>
            <button onClick={onClose} title="Fechar (Esc)"
              className="rounded-lg border border-ink-800 p-1.5 text-ink-400 transition-colors hover:bg-white/5 hover:text-ink-100">
              <X className="size-4" />
            </button>
          </div>

          <div className="relative mt-4">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Pesquisar configurações… (Ctrl+K)"
              className="w-full rounded-xl border border-ink-700 bg-ink-950 py-2.5 pl-10 pr-9 text-sm outline-none transition-colors focus:border-wa-500/70 focus:ring-2 focus:ring-wa-500/20" />
            {query && (
              <button onClick={() => setQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-400 hover:text-ink-100">
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-sm text-ink-400">
              <activeCat.icon className="size-3.5" />
              {q ? (
                <span>{shown.length} resultado(s) para “{query}”</span>
              ) : (
                <>
                  <span>{activeCat.label}</span>
                  <span className="text-ink-600">/</span>
                  <span className="text-ink-100">{activeCat.desc}</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setShortcuts(true)} className={btnGhost} title="Atalhos de teclado (?)">
                <Keyboard className="size-3.5" /> Atalhos
              </button>
              <button className={btnGhost}
                onClick={() => setCollapsed(allCollapsed ? [] : sections.map((s) => s.id))}>
                {allCollapsed ? <ChevronsUpDown className="size-3.5" /> : <ChevronsDownUp className="size-3.5" />}
                {allCollapsed ? "Expandir todas" : "Recolher todas"}
              </button>
            </div>
          </div>

          {/* categorias */}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {CATS.map((c, i) => {
              const on = !q && c.id === cat;
              return (
                <button key={c.id} onClick={() => { setQuery(""); setCat(c.id); }}
                  className={`relative flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 transition-all ${
                    on ? "border-foreground/80 bg-white/[0.06] shadow-sm"
                       : "border-ink-800 text-ink-400 hover:border-ink-700 hover:bg-white/[0.03]"}`}>
                  <span className="absolute right-2 top-1.5 text-[10px] font-bold text-ink-500">
                    {i + 1}
                  </span>
                  <c.icon className={`size-5 ${on ? "text-wa-500" : ""}`} />
                  <span className="text-xs font-semibold">{c.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* corpo: seções + prévia */}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-h-0 space-y-3 overflow-y-auto px-6 py-5">
            {shown.length === 0 && (
              <p className="rounded-2xl border border-dashed border-ink-800 p-10 text-center text-sm text-ink-400">
                Nada encontrado para “{query}”. Tente “logo”, “pixel”, “progresso” ou “webhook”.
              </p>
            )}
            {shown.map((s) => {
              const open = !collapsed.includes(s.id);
              return (
                <section key={s.id} className="overflow-hidden rounded-2xl border border-ink-800 bg-ink-950/30">
                  <button
                    onClick={() => setCollapsed(open ? [...collapsed, s.id] : collapsed.filter((x) => x !== s.id))}
                    className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.02]">
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-wa-500/15 text-wa-500">
                      <s.icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="font-semibold">{s.title}</span>
                        {q && (
                          <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-400">
                            {CATS.find((c) => c.id === s.cat)?.label}
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-400">{s.desc}</span>
                    </span>
                    <ChevronDown className={`mt-1 size-4 shrink-0 text-ink-400 transition-transform ${open ? "" : "-rotate-90"}`} />
                  </button>
                  {open && <div className="space-y-2.5 border-t border-ink-800 px-4 py-4">{s.body}</div>}
                </section>
              );
            })}
          </div>

          <aside className="hidden min-h-0 flex-col overflow-y-auto border-l border-ink-800 bg-ink-950/30 px-5 py-5 xl:flex">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-400">
              <Eye className="size-3.5" /> Prévia ao vivo
            </p>
            <LivePreview logo={d.logo_url} headline={d.headline || d.title} description={d.description}
              theme={d.theme} settings={d.settings} field={fields[0]} total={fields.length} />
            <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
              Prévia da capa. Abra o link público para ver o formulário inteiro com as transições.
            </p>
            {form && (
              <a href={publicLink} target="_blank" rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-wa-500 hover:underline">
                <Eye className="size-3.5" /> Ver formulário publicado
              </a>
            )}
          </aside>
        </div>

        {/* rodapé */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-ink-800 px-6 py-4">
          {err ? (
            <p className="flex items-center gap-1.5 text-sm text-red-300">
              <AlertCircle className="size-4 shrink-0" /> {err}
            </p>
          ) : (
            <p className="text-xs text-ink-400">
              {fields.length} pergunta(s) · {d.settings.layout === "step" ? "uma por vez" : "página única"}
              {d.logo_url ? " · com logo" : ""}{d.active ? "" : " · pausado"}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-medium text-ink-400 hover:text-ink-100">
              Cancelar
            </button>
            <button onClick={save} disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-wa-500 px-5 py-2 text-sm font-semibold text-ink-950 transition-all hover:brightness-110 disabled:opacity-50">
              {busy && <Loader2 className="size-4 animate-spin" />}
              {form ? "Salvar alterações" : "Criar e publicar"}
            </button>
          </div>
        </div>
      </div>

      {shortcuts && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onClick={(e) => { e.stopPropagation(); setShortcuts(false); }}>
          <div className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-900 p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Atalhos de teclado</h3>
              <button onClick={() => setShortcuts(false)} className="text-ink-400 hover:text-ink-100">
                <X className="size-4" />
              </button>
            </div>
            <dl className="mt-3 space-y-2 text-sm">
              {[["Ctrl / ⌘ + K", "Pesquisar configurações"], ["← →", "Trocar de categoria"],
                ["?", "Abrir esta lista"], ["Esc", "Limpar busca ou fechar"]].map(([k, l]) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <dt className="text-ink-400">{l}</dt>
                  <dd><kbd className="rounded-md border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-xs">{k}</kbd></dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}

      {aiOpen && (
        <FormAiModal
          clients={clients}
          defaultLine={d.wa_number_id}
          mode="fields"
          onClose={() => setAiOpen(false)}
          onUse={(g) => {
            setFields(g.fields);
            setAiOpen(false);
            setCat("perguntas");
          }}
        />
      )}
    </div>
  );
}

const btnGhost = "inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-950/50 px-2.5 py-1.5"
  + " text-xs font-medium text-ink-400 transition-colors hover:bg-white/5 hover:text-ink-100";

const PALETTES = [
  { name: "WhatsApp", primary: "#25d366", bg: "#0b141a", text: "#e9edef" },
  { name: "Brandcast", primary: "#8b5cf6", bg: "#0f0a1e", text: "#f4f4f5" },
  { name: "Meia-noite", primary: "#38bdf8", bg: "#0b1220", text: "#e2e8f0" },
  { name: "Esmeralda", primary: "#10b981", bg: "#07130f", text: "#ecfdf5" },
  { name: "Coral", primary: "#f97316", bg: "#1a0f0a", text: "#fff7ed" },
  { name: "Papel", primary: "#7c3aed", bg: "#faf7ff", text: "#1c1523" },
  { name: "Grafite", primary: "#e11d48", bg: "#111113", text: "#f5f5f5" },
];

// ------------------------------- peças de UI -------------------------------
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-wa-500" : "bg-white/15"}`}>
      <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

function HelpDot({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <HelpCircle className="size-3.5 cursor-help text-ink-500" />
      <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden w-56 -translate-x-1/2 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-2 text-[11px] leading-relaxed text-ink-100 shadow-xl group-hover:block">
        {text}
      </span>
    </span>
  );
}

/** Linha com rótulo + explicação à esquerda e o controle à direita. */
function SettingRow({ label, hint, help, required, children }: {
  label: string; hint?: string; help?: string; required?: boolean; children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-ink-800 bg-ink-950/50 px-4 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          {label}{required && <span className="text-red-300">*</span>}
          {help && <HelpDot text={help} />}
        </p>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-ink-400">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Campo empilhado (rótulo em cima, input embaixo). */
function Field({ label, hint, required, children }: {
  label: string; hint?: string; required?: boolean; children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-950/50 px-4 py-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        {label}{required && <span className="text-red-300">*</span>}
      </p>
      {hint && <p className="mb-2 mt-0.5 text-xs leading-relaxed text-ink-400">{hint}</p>}
      <div className={hint ? "" : "mt-2"}>{children}</div>
    </div>
  );
}

// ------------------------------ cartão de campo ----------------------------
function FieldCard({ f, index, total, onPatch, onMove, onRemove, onDuplicate }: {
  f: LeadFormField; index: number; total: number;
  onPatch: (patch: Partial<LeadFormField>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = FIELD_TYPES.find((t) => t.v === f.type);
  const needsOptions = OPTION_TYPES.includes(f.type);

  return (
    <div className="rounded-xl border border-ink-800 bg-ink-950/50 p-3">
      <div className="flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-white/5 font-mono text-[11px] font-bold text-ink-400">
          {index + 1}
        </span>
        <input className={`${INPUT} flex-1`} value={f.label} placeholder="Texto da pergunta"
          onChange={(e) => onPatch({ label: e.target.value })} />
        <div className="flex items-center">
          <button type="button" onClick={() => onMove(-1)} disabled={index === 0} title="Subir"
            className="p-1 text-ink-400 hover:text-ink-100 disabled:opacity-25"><ArrowUp className="size-4" /></button>
          <button type="button" onClick={() => onMove(1)} disabled={index === total - 1} title="Descer"
            className="p-1 text-ink-400 hover:text-ink-100 disabled:opacity-25"><ArrowDown className="size-4" /></button>
          <button type="button" onClick={onDuplicate} title="Duplicar"
            className="p-1 text-ink-400 hover:text-ink-100"><Copy className="size-4" /></button>
          <button type="button" onClick={onRemove} title="Excluir"
            className="p-1 text-ink-400 hover:text-red-300"><Trash2 className="size-4" /></button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select className="rounded-lg border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs outline-none focus:border-wa-500/70"
          value={f.type}
          onChange={(e) => {
            const type = e.target.value as LeadFormFieldType;
            onPatch({ type, options: OPTION_TYPES.includes(type) ? f.options : [] });
            if (OPTION_TYPES.includes(type)) setOpen(true);
          }}>
          {FIELD_TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
        </select>
        <button type="button" onClick={() => onPatch({ required: !f.required })}
          className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
            f.required ? "border-wa-500/50 bg-wa-500/10 text-wa-500" : "border-ink-700 text-ink-400 hover:bg-white/5"}`}>
          {f.required ? "Obrigatória" : "Opcional"}
        </button>
        <span className="text-[11px] text-ink-400">{meta?.hint}</span>
        <button type="button" onClick={() => setOpen(!open)}
          className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-ink-400 hover:text-ink-100">
          {open ? "Menos opções" : "Mais opções"}
          <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {needsOptions && (
        <div className="mt-2">
          <label className="text-[11px] font-medium text-ink-400">Opções — uma por linha</label>
          <textarea
            className={`${INPUT} mt-1 min-h-[70px] resize-y font-mono text-xs`}
            value={f.options.join("\n")}
            placeholder={"Sim\nNão\nAinda não sei"}
            onChange={(e) => onPatch({ options: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} />
          {f.options.length < 2 && (
            <p className="mt-1 text-[11px] text-red-300">Escreva pelo menos 2 opções.</p>
          )}
        </div>
      )}

      {open && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div>
            <label className="text-[11px] font-medium text-ink-400">Dica dentro do campo</label>
            <input className={`${INPUT} mt-1`} value={f.placeholder} placeholder="Ex.: (31) 99999-9999"
              onChange={(e) => onPatch({ placeholder: e.target.value })}
              disabled={needsOptions || f.type === "rating"} />
          </div>
          <div>
            <label className="text-[11px] font-medium text-ink-400">Texto de ajuda</label>
            <input className={`${INPUT} mt-1`} value={f.help} placeholder="Aparece abaixo da pergunta"
              onChange={(e) => onPatch({ help: e.target.value })} />
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------------------- prévia ao vivo ---------------------------
function LivePreview({ logo, headline, description, theme, settings, field, total }: {
  logo: string; headline: string; description: string;
  theme: LeadFormTheme; settings: LeadFormSettings;
  field?: LeadFormField; total: number;
}) {
  const radius = RADIUS_PX[theme.radius];
  const cover = settings.show_cover;
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-ink-800"
      style={{ background: pageBackground(theme), color: theme.text, fontFamily: FONT_STACK[theme.font] }}>
      {settings.show_progress && (
        <div className="h-1 w-full" style={{ background: withAlpha(theme.text, 0.12) }}>
          <div className="h-full" style={{ width: cover ? "6%" : `${Math.round(100 / Math.max(total, 1))}%`, background: theme.primary }} />
        </div>
      )}
      <div className="px-4 pb-5 pt-4">
        {logo && (
          <img src={logo} alt="" className="mb-3 w-auto object-contain"
            style={{ height: Math.min(settings.logo_size, 56) }} />
        )}
        {cover ? (
          <>
            <p className="text-base font-bold leading-snug">{headline || "Título do formulário"}</p>
            {description && <p className="mt-1.5 text-xs opacity-70">{description}</p>}
          </>
        ) : (
          <>
            <p className="text-[11px] font-semibold" style={{ color: theme.primary }}>1 de {Math.max(total, 1)}</p>
            <p className="mt-1 text-base font-bold leading-snug">{field?.label || "Primeira pergunta…"}</p>
            {field?.help && <p className="mt-1 text-[11px] opacity-60">{field.help}</p>}
            <div className="mt-3 border-b-2 pb-1 text-xs opacity-40" style={{ borderColor: theme.primary }}>
              {field?.placeholder || "Digite aqui…"}
            </div>
          </>
        )}
        <span className="mt-4 inline-block px-4 py-2 text-xs font-bold"
          style={{ background: theme.primary, color: contrastOn(theme.primary), borderRadius: radius }}>
          {cover ? settings.cover_button || "Começar" : theme.button || "Enviar"}
        </span>
        {settings.consent_enabled && !cover && (
          <p className="mt-3 text-[10px] leading-snug opacity-60">☐ {settings.consent_text}</p>
        )}
        {settings.show_branding && (
          <p className="mt-4 text-center text-[9px] opacity-40">{settings.branding_text}</p>
        )}
      </div>
    </div>
  );
}
