// Peças compartilhadas entre o editor (aba Formulários) e a página pública (/f/{slug}):
// defaults iguais aos do backend (app/forms.py), mapas de aparência e o preparo da
// logo da empresa (redimensionada no navegador e salva como data URI).
import type {
  LeadFormField, LeadFormFieldType, LeadFormSettings, LeadFormTheme,
} from './client';

// Mesma paleta do painel (WhatsApp Web escuro) — o cliente troca na aba Aparência.
export const DEFAULT_THEME: LeadFormTheme = {
  primary: "#25d366", bg: "#0b141a", text: "#e9edef", button: "Enviar",
  font: "sans", radius: "xl", gradient: true,
};

export const DEFAULT_SETTINGS: LeadFormSettings = {
  layout: "step",
  show_cover: true, cover_button: "Começar",
  show_progress: true, show_branding: true,
  branding_text: "Feito com 💚 pela Agência Brandcast",
  logo_size: 44,
  consent_enabled: false,
  consent_text: "Autorizo o contato e o uso dos meus dados conforme a Política de Privacidade.",
  redirect_url: "", redirect_delay: 3,
  webhook_url: "",
  whatsapp_redirect: false, whatsapp_phone: "",
  whatsapp_message: "Olá! Acabei de preencher o formulário e quero falar com vocês.",
  track_journey: true,
};

export const FIELD_TYPES: { v: LeadFormFieldType; l: string; hint: string }[] = [
  { v: "text", l: "Texto curto", hint: "Nome, cidade, empresa…" },
  { v: "textarea", l: "Texto longo", hint: "Respostas com várias linhas" },
  { v: "email", l: "E-mail", hint: "Validado e usado no lead do CRM" },
  { v: "phone", l: "Telefone/WhatsApp", hint: "Validado e usado no lead do CRM" },
  { v: "number", l: "Número", hint: "Quantidade, faturamento, idade…" },
  { v: "date", l: "Data", hint: "Seletor de data" },
  { v: "url", l: "Site/URL", hint: "Instagram, site, portfólio…" },
  { v: "choice", l: "Escolha única (botões)", hint: "Cartões grandes, 1 opção" },
  { v: "multi", l: "Múltipla seleção", hint: "Marca quantas quiser" },
  { v: "select", l: "Lista suspensa", hint: "Bom para muitas opções" },
  { v: "rating", l: "Nota (1 a 5)", hint: "Estrelas de satisfação" },
];

export const OPTION_TYPES: LeadFormFieldType[] = ["choice", "multi", "select"];

export const FONT_STACK: Record<LeadFormTheme["font"], string> = {
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
};

export const FONT_LABEL: Record<LeadFormTheme["font"], string> = {
  sans: "Moderna (sans)", serif: "Clássica (serif)", mono: "Técnica (mono)",
};

export const RADIUS_PX: Record<LeadFormTheme["radius"], number> = {
  none: 0, md: 8, xl: 16, full: 999,
};

export const RADIUS_LABEL: Record<LeadFormTheme["radius"], string> = {
  none: "Reto", md: "Suave", xl: "Arredondado", full: "Pílula",
};

/** Fundo da página: gradiente sutil puxando a cor principal, ou cor sólida. */
export function pageBackground(theme: LeadFormTheme): string {
  if (!theme.gradient) return theme.bg;
  return `radial-gradient(120% 90% at 15% -10%, ${withAlpha(theme.primary, 0.35)} 0%, `
    + `${withAlpha(theme.primary, 0)} 55%), ${theme.bg}`;
}

/** "#8b5cf6" + 0.2 -> "rgba(139,92,246,0.2)" (aceita hex de 6 dígitos). */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Cor de texto legível sobre a cor principal (botões). */
export function contrastOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? "#101014" : "#ffffff";
}

export function emptyField(seed: number): LeadFormField {
  return {
    id: `q${seed.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    label: "", type: "text", required: true, options: [], placeholder: "", help: "",
  };
}

export function fieldPlaceholder(f: LeadFormField): string {
  if (f.placeholder) return f.placeholder;
  switch (f.type) {
    case "email": return "voce@email.com";
    case "phone": return "(31) 99999-9999";
    case "url": return "instagram.com/suamarca";
    case "number": return "0";
    case "textarea": return "Escreva aqui…";
    default: return "Digite aqui…";
  }
}

/** Erro de validação da resposta, ou "" quando está tudo certo. */
export function validateAnswer(f: LeadFormField, value: string | string[]): string {
  const filled = Array.isArray(value) ? value.length > 0 : !!value.trim();
  if (f.required && !filled) {
    return f.type === "choice" || f.type === "multi" || f.type === "select"
      ? "Escolha uma opção para continuar." : "Este campo é obrigatório.";
  }
  if (!filled || Array.isArray(value)) return "";
  const v = value.trim();
  if (f.type === "email" && !/^\S+@\S+\.\S+$/.test(v)) return "Digite um e-mail válido.";
  if (f.type === "phone" && v.replace(/\D/g, "").length < 10) return "Digite o telefone com DDD.";
  if (f.type === "url" && !/^([a-z]+:\/\/)?[\w-]+(\.[\w-]+)+/i.test(v)) return "Digite um endereço válido.";
  if (f.type === "number" && Number.isNaN(Number(v.replace(",", ".")))) return "Digite apenas números.";
  return "";
}

// ----------------------- Logo da empresa (opcional) -----------------------
// Guardamos a logo como data URI no próprio formulário: nada de volume de
// upload no servidor e o link público carrega a marca junto com o JSON.
const LOGO_MAX_H = 240;      // altura máxima em px (retina de uma logo de 120px)
const LOGO_MAX_W = 960;
const LOGO_MAX_CHARS = 380_000;  // o backend corta em 400 mil caracteres

export async function fileToLogoDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Envie um arquivo de imagem (PNG, JPG, SVG ou WebP).");
  }
  if (file.size > 5 * 1024 * 1024) throw new Error("Imagem muito grande — o limite é 5 MB.");

  const dataUrl = await readAsDataUrl(file);
  if (file.type === "image/svg+xml") {
    if (dataUrl.length > LOGO_MAX_CHARS) throw new Error("SVG muito pesado — exporte em PNG.");
    return dataUrl;
  }

  const img = await loadImage(dataUrl);
  const scale = Math.min(1, LOGO_MAX_H / img.height, LOGO_MAX_W / img.width);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    if (dataUrl.length > LOGO_MAX_CHARS) throw new Error("Imagem muito grande — reduza antes de enviar.");
    return dataUrl;
  }
  ctx.drawImage(img, 0, 0, w, h);
  // WebP mantém a transparência e sai bem menor que PNG.
  let out = canvas.toDataURL("image/webp", 0.92);
  if (!out.startsWith("data:image/webp")) out = canvas.toDataURL("image/png");
  if (out.length > LOGO_MAX_CHARS) out = canvas.toDataURL("image/webp", 0.7);
  if (out.length > LOGO_MAX_CHARS) {
    throw new Error("Não conseguimos reduzir o suficiente — use uma logo menor.");
  }
  return out;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
    fr.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Arquivo de imagem inválido."));
    img.src = src;
  });
}
