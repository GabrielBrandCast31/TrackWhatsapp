// Google Sheets — cada resposta vira uma linha numa planilha, via um Apps
// Script que o usuário cola na própria planilha (sem login do Google aqui).
import { useState } from "react";
import { AlertCircle, Check, Copy, ExternalLink, Loader2 } from "./icons";
import { getSheetsScript, testSheets, type LeadFormField, type LeadFormSettings } from "./client";
import { Field, INPUT, SettingRow, Toggle } from "./editorUi";

const URL_SHAPE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[A-Za-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
export const validSheetsUrl = (u: string) => URL_SHAPE.test(u.trim());

function randomSecret(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function SheetsPanel({ settings, onChange, lineId, title, fields }: {
  settings: LeadFormSettings; onChange: (patch: Partial<LeadFormSettings>) => void;
  lineId: number; title: string; fields: LeadFormField[];
}) {
  const [copy, setCopy] = useState<{ busy: boolean; done?: boolean; err?: string }>({ busy: false });
  const [test, setTest] = useState<{ busy: boolean; ok?: boolean; msg?: string }>({ busy: false });
  const url = settings.sheets_url.trim();
  const urlBad = !!url && !validSheetsUrl(url);

  function toggle(v: boolean) {
    // o segredo nasce aqui para o script já sair pronto, antes de salvar
    onChange({ sheets_enabled: v, ...(v && !settings.sheets_secret ? { sheets_secret: randomSecret() } : {}) });
  }

  async function copyScript() {
    setCopy({ busy: true });
    try {
      const { script } = await getSheetsScript(settings.sheets_secret);
      try { await navigator.clipboard.writeText(script); }
      catch { window.prompt("Copie o script:", script); }
      setCopy({ busy: false, done: true });
      setTimeout(() => setCopy({ busy: false }), 2500);
    } catch (e) {
      setCopy({ busy: false, err: e instanceof Error ? e.message : "Não foi possível gerar o script." });
    }
  }

  async function sendTest() {
    setTest({ busy: true });
    try {
      const r = await testSheets({
        wa_number_id: lineId, url, secret: settings.sheets_secret, tab: settings.sheets_tab, title, fields,
      });
      setTest({ busy: false, ok: true, msg: `Linha de teste gravada${r.row ? ` (linha ${r.row})` : ""}. Confira a planilha — pode apagar depois.` });
    } catch (e) {
      setTest({ busy: false, ok: false, msg: e instanceof Error ? e.message : "O teste falhou." });
    }
  }

  return (
    <>
      <SettingRow label="Enviar respostas para uma planilha"
        hint="Opcional. Cada resposta vira uma linha no Google Sheets, com uma coluna por pergunta, a qualificação e as UTMs."
        help="Se a planilha falhar, o lead não se perde: continua no CRM e você pode reenviar pela lista de respostas.">
        <Toggle checked={settings.sheets_enabled} onChange={toggle} />
      </SettingRow>

      {settings.sheets_enabled && (
        <>
          <ol className="space-y-2.5 rounded-xl border border-ink-800 bg-ink-950/50 px-4 py-3 text-xs leading-relaxed text-ink-300">
            <li>
              <b className="text-ink-100">1.</b> Abra (ou crie) a planilha e vá em <b>Extensões → Apps Script</b>.{" "}
              <a href="https://sheets.new" target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-wa-500 hover:underline">
                Criar planilha <ExternalLink className="size-3" />
              </a>
            </li>
            <li>
              <b className="text-ink-100">2.</b> Apague o código que estiver lá e cole este script (já vem com o segredo deste formulário):
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void copyScript()} disabled={copy.busy || !settings.sheets_secret}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-950/50 px-2.5 py-1.5 text-xs font-medium text-ink-200 hover:bg-white/5 disabled:opacity-50">
                  {copy.busy ? <Loader2 className="size-3.5" /> : copy.done ? <Check className="size-3.5 text-wa-500" /> : <Copy className="size-3.5" />}
                  {copy.done ? "Script copiado" : "Copiar script"}
                </button>
                {copy.err && <span className="text-red-300">{copy.err}</span>}
              </div>
            </li>
            <li>
              <b className="text-ink-100">3.</b> Clique em <b>Implantar → Nova implantação</b>, tipo <b>App da Web</b>,
              com <b>Executar como: Eu</b> e <b>Quem pode acessar: Qualquer pessoa</b>. Autorize o acesso quando o Google pedir.
            </li>
            <li>
              <b className="text-ink-100">4.</b> Copie a <b>URL do app da Web</b> (termina em <code className="font-mono">/exec</code>), cole abaixo e clique em “Enviar linha de teste”.
            </li>
          </ol>

          <Field label="URL do app da Web" required>
            <input className={`${INPUT} font-mono text-xs`} value={settings.sheets_url} spellCheck={false}
              placeholder="https://script.google.com/macros/s/AKfy…/exec"
              onChange={(e) => { onChange({ sheets_url: e.target.value.trim() }); setTest({ busy: false }); }} />
            {urlBad && (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-red-300">
                <AlertCircle className="size-3.5" /> Use a URL de implantação do Apps Script, que termina em /exec (a de teste, /dev, não funciona).
              </p>
            )}
          </Field>
          <Field label="Aba da planilha" hint="Criada automaticamente se não existir. Cabeçalhos entram sozinhos; pergunta nova vira coluna nova no fim.">
            <input className={INPUT} value={settings.sheets_tab} placeholder="Respostas"
              onChange={(e) => onChange({ sheets_tab: e.target.value })} />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void sendTest()} disabled={test.busy || !url || urlBad || !lineId}
              className="inline-flex items-center gap-1.5 rounded-lg bg-wa-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:brightness-110 disabled:opacity-40">
              {test.busy && <Loader2 className="size-3.5" />} Enviar linha de teste
            </button>
            {test.msg && (
              <span className={`flex items-center gap-1.5 text-[11px] ${test.ok ? "text-wa-500" : "text-red-300"}`}>
                {test.ok ? <Check className="size-3.5" /> : <AlertCircle className="size-3.5" />} {test.msg}
              </span>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-ink-500">
            Cada formulário tem o próprio segredo: o script copiado de outro formulário recusa as linhas. Ao trocar o
            código do script, publique uma nova versão em Implantar → Gerenciar implantações (a URL continua a mesma).
          </p>
        </>
      )}
    </>
  );
}
