"""Planilha do Google Sheets por formulario, via Google Apps Script.

Sem OAuth e sem credencial do Google guardada aqui: o usuario cola o script
abaixo (`apps_script`) na propria planilha, publica como "App da Web" e cola a
URL /exec no formulario. A cada resposta, o backend faz POST nessa URL com um
segredo por formulario; o script confere o segredo e acrescenta a linha.

O script casa as colunas pelo NOME do cabecalho: pergunta nova vira coluna nova
no fim, e reordenar as colunas na planilha nao quebra nada.
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit

import httpx

log = logging.getLogger(__name__)

# so o host do Apps Script: a URL vem do usuario, entao nada de rede interna.
# /a/macros/<dominio>/ e o formato de conta Google Workspace.
URL_SHAPE = re.compile(r"https://script\.google\.com/(?:a/macros/[A-Za-z0-9.\-]+|macros)/s/[A-Za-z0-9_\-]{20,}/exec")
DEFAULT_TAB = "Respostas"
UTM_KEYS = ("source", "medium", "campaign", "content", "term")


class SheetsError(RuntimeError):
    pass


def valid_url(url: str) -> bool:
    return bool(URL_SHAPE.fullmatch((url or "").strip()))


def new_secret() -> str:
    return secrets.token_urlsafe(18)


def _utms(contact_utm: dict | None, page_url: str) -> dict:
    """UTMs da jornada (o que a tag ligou ao lead) ou, sem ela, as da URL da pagina."""
    out = {k: str(v) for k, v in (contact_utm or {}).items() if k in UTM_KEYS and v}
    if not out and page_url and "?" in page_url:
        q = parse_qs(urlsplit(page_url).query)
        out = {k: q[f"utm_{k}"][0] for k in UTM_KEYS if q.get(f"utm_{k}")}
    return out


def build_columns(
    *, form_title: str, response_id: int | str, created_at: datetime | None, fields: list[dict],
    answers: dict, qualified: bool | None, contact_utm: dict | None = None, page_url: str = "",
    transaction_id: str | None = None, test: bool = False,
) -> list[list[str]]:
    """Linha da planilha como pares [coluna, valor], na ordem em que aparecem."""
    when = (created_at or datetime.now(timezone.utc)).astimezone()
    cols: list[list[str]] = [
        ["Data", when.strftime("%d/%m/%Y %H:%M:%S")],
        ["Formulário", form_title + (" (TESTE)" if test else "")],
        ["Resposta #", str(response_id)],
    ]
    for f in fields:
        cols.append([f.get("label") or f["id"], str(answers.get(f["id"]) or "")])
    cols.append(["Qualificado", {True: "Sim", False: "Não"}.get(qualified, "")])
    utm = _utms(contact_utm, page_url)
    for k in UTM_KEYS:
        cols.append([f"utm_{k}", utm.get(k, "")])
    cols.append(["Página", page_url or ""])
    cols.append(["TL_ID", transaction_id or ""])
    # cabecalho repetido (duas perguntas com o mesmo texto) sobrescreveria a outra
    seen: dict[str, int] = {}
    for c in cols:
        n = seen.get(c[0], 0)
        seen[c[0]] = n + 1
        if n:
            c[0] = f"{c[0]} ({n + 1})"
    return cols


async def append_row(url: str, secret: str, tab: str, columns: list[list[str]]) -> dict:
    if not valid_url(url):
        raise SheetsError("URL do Apps Script inválida — use a URL que termina em /exec.")
    payload = {"secret": secret, "sheet": (tab or DEFAULT_TAB)[:100], "columns": columns}
    # o Apps Script responde 302 para script.googleusercontent.com com o retorno;
    # o doPost ja rodou no primeiro POST, o redirect so entrega o JSON
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        r = await client.post(url, json=payload)
    if r.status_code >= 400:
        raise SheetsError(f"Apps Script respondeu {r.status_code}. Confira se o acesso do app da Web é 'Qualquer pessoa'.")
    try:
        body = r.json()
    except ValueError:
        # pagina de login do Google em HTML: implantacao restrita
        raise SheetsError(
            "O Apps Script não devolveu JSON — a implantação provavelmente não está com acesso "
            "'Qualquer pessoa', ou a URL é de teste (/dev) em vez de /exec."
        ) from None
    if not body.get("ok"):
        raise SheetsError(str(body.get("error") or "A planilha recusou a linha."))
    return body


def apps_script(secret: str) -> str:
    """Script que o usuario cola em Extensoes -> Apps Script da planilha."""
    return APPS_SCRIPT.replace("__SECRET__", secret)


APPS_SCRIPT = r"""// Recebe as respostas do formulário e grava uma linha por resposta.
// Cole em Extensões > Apps Script, salve e publique como App da Web
// (Executar como: Eu · Quem pode acessar: Qualquer pessoa).
const SECRET = "__SECRET__";

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: "JSON inválido" }); }
  if (body.secret !== SECRET) return out({ ok: false, error: "Segredo não confere — copie o script de novo do formulário." });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const name = body.sheet || "Respostas";
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    const cols = body.columns || [];
    const last = sh.getLastColumn();
    const headers = last ? sh.getRange(1, 1, 1, last).getValues()[0].map(String) : [];
    let grew = false;
    cols.forEach(function (c) { if (headers.indexOf(c[0]) < 0) { headers.push(c[0]); grew = true; } });
    if (grew || !last) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
      sh.setFrozenRows(1);
    }
    const values = {};
    cols.forEach(function (c) { values[c[0]] = safe(c[1]); });
    const row = headers.map(function (h) { return h in values ? values[h] : ""; });
    sh.appendRow(row);
    return out({ ok: true, row: sh.getLastRow() });
  } finally {
    lock.releaseLock();
  }
}

// resposta que começa com = + - @ viraria fórmula: grava como texto
function safe(v) {
  const s = v == null ? "" : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
"""
