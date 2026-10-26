# Disparo do Lead para o Meta (CAPI): mudanças de 21/10/2026

Este documento junta tudo o que foi feito em **21/10/2026** para o disparo do lead (conversão) para o Meta funcionar de forma confiável. O objetivo é poder replicar as mudanças em outro sistema parecido com este.

Commits do dia (em ordem):

| Commit    | Hora  | Mensagem                        | Foco |
|-----------|-------|---------------------------------|------|
| `aec3da0` | 14:44 | lead submited                   | `LeadSubmitted`, erro com a resposta crua do destino, reenvio por destino e "forçar envio" |
| `0a56a40` | 15:22 | feat/frontend new funcionlity   | WABA opcional, novo campo **ID do Instagram**, escolha automática do formato (WABA x page_id) |

Para ver o diff completo: `git diff f611945 0a56a40`

---

## 1. O problema

O Meta recusava o evento de lead vindo de anúncio Click to WhatsApp (CTWA) por três motivos:

1. **Nome do evento errado.** A Conversions API for Business Messaging não usa o `Lead` do pixel. Ela usa **`LeadSubmitted`**.
2. **Falta de identificador do negócio.** O evento precisa de `whatsapp_business_account_id` (WABA) **ou** de `page_id`. Sem nenhum dos dois, o Meta responde com o erro `code 100 / subcode 2804116` ("sem page_id nem whatsapp_business_account_id"). Muitas linhas não tinham WABA, e o sistema exigia o WABA.
3. **`page_id` errado em lead do Instagram.** O `ctwa_clid` é gerado pela conta que roda o anúncio. Quando o anúncio roda no Instagram, quem gera o clid é a **conta do Instagram**, e não a Página do Facebook. Mandar o Page ID do Facebook nesse caso não casa com o clid.

Também era difícil depurar: quando o destino recusava, o histórico guardava só a mensagem de erro, sem o HTTP status nem o corpo da resposta. E não existia forma de reenviar um destino específico.

---

## 2. Visão geral de como funciona agora

```
Conversão criada (event_name = "Lead")
        │
        ▼
dispatch_conversion()
        │  destinos habilitados: meta_capi / google_ads / webhook
        ▼
_with_parallel(cfg, targets)  ← decide os formatos do Meta
        │
        ├─ tem WABA e (Page ID ou Instagram) → meta_capi + meta_capi_page (os dois em paralelo)
        ├─ só WABA                           → meta_capi
        ├─ sem WABA, com Page ID/Instagram   → meta_capi_page (substitui o meta_capi)
        └─ nada                              → meta_capi (vai falhar na checagem local)
        │
        ▼
Para cada destino: build → (check) → send
        │  o payload é gravado ANTES do envio
        │  em caso de erro, grava http_status + response_body crus
        ▼
Tabela dispatches (aparece na aba Conversões)
```

### Os dois formatos do evento do Meta

**Formato padrão (`meta_capi`), com WABA:**

```json
{
  "data": [{
    "event_name": "LeadSubmitted",
    "event_time": 1761070000,
    "event_id": "<mesmo event_id da conversão>",
    "action_source": "business_messaging",
    "messaging_channel": "whatsapp",
    "user_data": {
      "ctwa_clid": "<clid do referral, SEM hash>",
      "whatsapp_business_account_id": "109876543210987",
      "ph": ["<sha256 do telefone E.164 só dígitos>"]
    },
    "custom_data": { "lead_source": "whatsapp", "ad_id": "<ad id>" }
  }],
  "test_event_code": "TEST123"
}
```

**Formato page (`meta_capi_page`), sem WABA:**

```json
{
  "data": [{
    "event_name": "LeadSubmitted",
    "event_time": 1761070000,
    "event_id": "<mesmo event_id>",
    "action_source": "business_messaging",
    "messaging_channel": "whatsapp",
    "user_data": {
      "ph": ["<sha256>"],
      "page_id": "<Page ID do Facebook OU ID do Instagram>",
      "ctwa_clid": "<clid>"
    },
    "custom_data": {
      "ad_id": "...", "source_id": "...", "source_type": "ad",
      "source_url": "...", "source_app": "instagram",
      "ad_name": "...", "adset_id": "...", "adset_name": "...",
      "campaign_id": "...", "campaign_name": "...",
      "status": "LeadSubmitted",
      "currency": "BRL",
      "lead_event_source": "WhatsApp"
    }
  }]
}
```

Os dois formatos usam **o mesmo `event_id`**, então o Meta deduplica quando os dois são aceitos. Os dois são enviados por `POST https://graph.facebook.com/{versao}/{dataset_id}/events?access_token=...`.

> **Pré-requisito:** o destino `meta_capi_page`, a função `build_page_payload` e `ad_custom_data` já existiam antes de 21/10. Se o outro sistema não tiver isso, copie também essas partes de `backend/app/services/meta_capi.py` e `backend/app/services/dispatch.py`. O código completo está na seção 4.

---

## 3. Mudanças no backend

### 3.1 `LeadSubmitted` nos dois formatos (`services/meta_capi.py`)

Antes, só o formato page trocava `Lead` por `LeadSubmitted` (constante `PAGE_EVENT_NAMES`). Agora a constante foi renomeada para `MESSAGING_EVENT_NAMES` e vale **para os dois formatos**. Internamente a conversão continua se chamando `Lead`. A troca acontece só no payload que vai para o Meta.

```python
# Nome do evento que vai pro Meta: a lista de eventos da Conversions API for
# Business Messaging usa `LeadSubmitted` no lugar do `Lead` do pixel. Vale pros
# dois formatos (WABA e page_id); por dentro o evento continua `Lead`.
MESSAGING_EVENT_NAMES = {"Lead": "LeadSubmitted"}

# em build_payload:
"event_name": MESSAGING_EVENT_NAMES.get(event_name, event_name),

# em build_page_payload:
name = MESSAGING_EVENT_NAMES.get(event_name, event_name)
```

### 3.2 Nova função `page_id_for` (`services/meta_capi.py`)

Esta função escolhe qual ID vai em `user_data.page_id` de acordo com a origem do anúncio (`contact.ad_source_app`):

```python
def page_id_for(cfg: dict, source_app: str | None = None) -> str | None:
    """ID que vai em `user_data.page_id` no formato page: o dono do anuncio.

    O Meta exige que o `ctwa_clid` tenha sido gerado por esse mesmo ID. Lead que
    veio de anuncio no Instagram usa a conta do Instagram; o resto, a Pagina do
    Facebook. Com so um dos dois preenchido, vai o que tiver.
    """
    page = (cfg.get("meta_page_id") or "").strip() or None
    instagram = (cfg.get("meta_instagram_id") or "").strip() or None
    if (source_app or "").lower() == "instagram":
        return instagram or page
    return page or instagram
```

| `source_app` | Page ID | Instagram ID | Vai em `page_id` |
|---|---|---|---|
| `instagram` | ✔ | ✔ | Instagram ID |
| `facebook` (ou vazio) | ✔ | ✔ | Page ID |
| qualquer um | ✔ | ✘ | Page ID |
| qualquer um | ✘ | ✔ | Instagram ID |

O `ad_source_app` vem do `referral.source_app` do webhook do WhatsApp, em minúsculo (`backend/app/tracking.py`). No lead de formulário do Meta, ele vem do `platform` (`backend/app/meta_leads.py`). **Confirme que o outro sistema grava esse campo no contato.**

O `_build_meta_page` e o endpoint de preview (`routers/conversions.py`) passaram a usar `meta_capi.page_id_for(cfg, contact.ad_source_app)` no lugar de `business_ids(cfg)["page_id"]`.

### 3.3 Escolha do formato: `_with_parallel` (`services/dispatch.py`)

Antes, o `meta_capi_page` só era adicionado **junto** do `meta_capi` quando havia Page ID, e o WABA era obrigatório. Agora **qualquer um dos três basta** (WABA, Page ID ou Instagram):

```python
def _with_parallel(cfg: dict, targets: list[str]) -> list[str]:
    """Escolhe os formatos do Meta pelo que a linha tem: WABA, Page ID, Instagram.

    Qualquer um basta. Com WABA e Page/Instagram, sai `meta_capi_page` logo depois
    de `meta_capi`; sem WABA, o `meta_capi_page` entra no lugar do `meta_capi`.
    """
    if "meta_capi" not in targets:
        return list(targets)
    has_page = bool(meta_capi.page_id_for(cfg))
    if not has_page:
        return list(targets)
    out = list(targets)
    i = out.index("meta_capi")
    if not meta_capi.business_ids(cfg)["waba_id"]:
        out[i] = "meta_capi_page"
    elif "meta_capi_page" not in out:
        out.insert(i + 1, "meta_capi_page")
    # sem duplicar quando o meta_capi_page ja estava na lista
    return list(dict.fromkeys(out))
```

Lembrete: `business_ids(cfg)["waba_id"]` usa `meta_waba_id` e, se estiver vazio, cai para `wa_business_account_id` (o WABA da linha Cloud API).

### 3.4 Checagem local separada do build: `_check_meta` + `force`

Antes, as validações (falta de `ctwa_clid`, falta de WABA) ficavam **dentro** do `_build_meta` e impediam qualquer envio. Agora:

- `_build_meta` só **monta** o payload.
- `_check_meta` **valida** o payload e lança `CapiError` com uma mensagem clara.
- O mapa de runners virou uma tupla de 3 itens: `(build, check, send)`.
- `dispatch_conversion` ganhou dois parâmetros nomeados:
  - `force=True` pula o `check` e envia mesmo assim, para ver a resposta real do Meta.
  - `exact=True` envia **só** os destinos pedidos, sem chamar `_with_parallel`.

```python
def _check_meta(cfg: dict, payload: dict) -> None:
    """Barra antes de enviar o que o Meta com certeza recusa. `force` pula isso."""
    user_data = payload["data"][0]["user_data"]
    if not user_data.get("ctwa_clid"):
        raise meta_capi.CapiError(
            "Contato sem ctwa_clid — o Meta nao consegue atribuir esse evento a uma campanha. "
            "Use um lead vindo de anuncio Click to WhatsApp (ou o simulador)."
        )
    if not user_data.get("whatsapp_business_account_id"):
        raise meta_capi.CapiError(
            "Linha sem WhatsApp Business Account ID (WABA) — esse formato do evento precisa dele. "
            "Preencha em Rastreamento > Meta o WABA, o Page ID ou o ID do Instagram (basta um)."
        )


# destino -> (monta o payload, checa antes de enviar, envia o payload)
_RUNNERS = {
    "meta_capi": (_build_meta, _check_meta, meta_capi.send),
    "meta_capi_page": (_build_meta_page, None, meta_capi.send),
    "google_ads": (_build_google, None, google_ads.send),
    "webhook": (_build_webhook, None, generic_webhook.send),
}


async def dispatch_conversion(session, cfg, conv, contact, destinations=None, *, force=False, exact=False):
    targets = destinations if destinations else enabled_destinations(cfg)
    if not exact:
        targets = _with_parallel(cfg, targets)
    ...
        build, check, send = runner
        try:
            payload = build(cfg, contact, conv, campaign)
            # grava o payload ANTES de enviar
            record.request_payload = _sanitize(payload)
            if check is not None and not force:
                check(cfg, payload)
            http_status, body = await send(cfg, payload)
            record.http_status = http_status
            record.response_body = body if isinstance(body, dict) else {"data": body}
            record.status = "ok"
        except Exception as exc:
            record.status = "error"
            record.error = str(exc)
            if getattr(exc, "http_status", None) is not None:
                record.http_status = exc.http_status
            if getattr(exc, "body", None) is not None:
                record.response_body = exc.body
```

### 3.5 Erros carregam a resposta crua do destino

`CapiError` (Meta), `GoogleAdsError` e `WebhookError` agora guardam `http_status` e `body`. Assim o histórico mostra **o que o destino respondeu**, mesmo quando falha:

```python
class CapiError(Exception):
    def __init__(self, message: str, http_status: int | None = None, body: dict | None = None):
        super().__init__(message)
        # resposta crua do destino, pra aparecer no historico mesmo quando falha
        self.http_status = http_status
        self.body = body
```

Em cada `send`, passe `resp.status_code` e o corpo ao lançar o erro:

```python
# meta_capi.send
raise CapiError(f"{msg} (code {err.get('code')}, subcode {err.get('error_subcode')})", resp.status_code, body)

# google_ads.send
raise GoogleAdsError(_readable_error(body, resp.status_code), resp.status_code, body)
raise GoogleAdsError(f"Partial failure: {partial.get('message')}", resp.status_code, body)

# generic_webhook.send
raise WebhookError(f"Destino respondeu HTTP {resp.status_code}: {resp.text[:300]}",
                   resp.status_code, parsed if isinstance(parsed, dict) else {"data": parsed})
```

Regra útil para a interface: se um erro do `meta_capi` não tem `response_body`, ele foi **barrado pela checagem local** e o Meta nem chegou a ser chamado.

### 3.6 Endpoint de reenvio (`routers/conversions.py`)

`POST /api/conversions/{id}/retry` ganhou `?force=true`. Se o corpo trouxer uma lista explícita de destinos, ele envia só esses (`exact`):

```python
async def retry_conversion(
    conversion_id: int,
    destinations: list[str] | None = None,   # body JSON: ["meta_capi"]
    force: bool = Query(default=False),
    session: AsyncSession = Depends(get_session),
):
    ...
    targets = destinations or [d.destination for d in conv.dispatches if d.status == "error"] or None
    await dispatch_conversion(session, cfg, conv, contact, targets, force=force, exact=bool(destinations))
```

O reenvio usa **o mesmo `event_id`**, então o Meta deduplica.

### 3.7 Novo campo de configuração `meta_instagram_id`

Adicione o campo em todos os lugares onde `meta_page_id` aparece:

| Arquivo | O que foi feito |
|---|---|
| `app/settings_store.py` | `DEFAULTS["meta_instagram_id"] = os.getenv("META_INSTAGRAM_ID", "")` |
| `app/numbers.py` | `"meta_instagram_id"` na tupla `OVERRIDABLE`, para permitir valor por linha/número |
| `app/routers/evolution.py` | em `META_FIELDS`, no `serialize()` (`"meta_instagram_id": overrides.get(...) or ""`), em `InstanceIn` e em `InstancePatch` |

Não precisa de migração de banco: o valor fica no settings/overrides (JSON) da linha.

Variável de ambiente opcional: `META_INSTAGRAM_ID=`

---

## 4. Mudanças no frontend

### 4.1 `src/api.ts`
- `EvoInstance` ganhou `meta_instagram_id?: string`.
- `api.retry` passou a aceitar destinos e `force`:

```ts
retry: (id: number, opts: { destinations?: Dispatch['destination'][]; force?: boolean } = {}) =>
  request<Conversion>(`/api/conversions/${id}/retry${opts.force ? '?force=true' : ''}`, {
    method: 'POST',
    ...(opts.destinations ? { body: JSON.stringify(opts.destinations) } : {}),
  }),
```

### 4.2 `src/tabs/Conversions.tsx`: depuração por destino
- Novo componente `Payload`: mostra o JSON e um botão **Copiar**. Quando está vazio, mostra uma mensagem explicativa.
- `request` e `response · HTTP <status>` aparecem lado a lado (`grid lg:grid-cols-2`).
- Cada destino tem o botão **"reenviar este destino"** (`api.retry(c.id, { destinations: [d.destination], force: false })`).
- Se o erro foi barrado localmente (`meta_capi` com erro e sem `response_body`), aparece o botão **"enviar pro Meta mesmo assim"** (`force: true`).
- Novo estado `busyDispatch`, para mostrar "enviando…" só na linha clicada.

### 4.3 `src/tabs/Tracking.tsx`: aba Rastreamento > Meta
- Três campos lado a lado (`md:grid-cols-3`), **todos opcionais, basta um**: *WABA ID*, *Page ID do Facebook* e *ID do Instagram* (placeholder `17841400000000000`).
- Novo texto explicando que lead do Instagram vai com o ID do Instagram e o resto vai com o Page ID.
- O `useEffect` do draft agora depende também de `instance.meta_instagram_id`.
- A linha fica "pronta" quando tem dataset, token e pelo menos um dos três:
  ```ts
  const hasBusinessId = Boolean(instance.meta_waba_id || instance.meta_page_id || instance.meta_instagram_id)
  ```
- O aviso (banner) diz "Preencha ao menos um dos três".

### 4.4 `src/tabs/Destinations.tsx` e `src/tabs/Numbers.tsx`
- O WABA deixou de ser "obrigatório" e passou a ser "Opcional — basta ele, o Page ID ou o ID do Instagram".
- Foram adicionados os campos `meta_page_id` (Page ID do Facebook) e `meta_instagram_id` (ID do Instagram) nas listas de campos (`META` e `OVERRIDE_FIELDS`).

---

## 5. Testes (`backend/tests/test_capi_page.py`)

Casos adicionados ou ajustados, que servem de especificação para o outro sistema:

**Instagram**
- Lead do Instagram com os dois IDs preenchidos → usa o ID do Instagram.
- Lead do Facebook com os dois IDs preenchidos → usa a Página.
- Só o Instagram preenchido → serve para qualquer lead.
- Só a Página preenchida → serve também para lead do Instagram.
- `_build_meta_page` de um contato do Instagram → `user_data.page_id` = ID do Instagram.

**Paralelo**
- WABA + Page ID → `["meta_capi", "meta_capi_page", "webhook"]`
- Sem WABA → `["meta_capi_page", "webhook"]` (substitui o `meta_capi`)
- Só Instagram + WABA → `["meta_capi", "meta_capi_page"]`
- Nada preenchido → `["meta_capi"]`
- Sem `meta_capi` na lista → nada muda
- Não duplica, com ou sem WABA

**Formato padrão**
- Continua com WABA e sem `page_id`.
- Agora manda `LeadSubmitted` (antes mandava `Lead`).

Para rodar: `cd backend && python tests/test_capi_page.py` (precisa das dependências de `requirements.txt` instaladas).

---

## 6. Checklist para portar para o outro sistema

1. [ ] `meta_capi.py`: criar `MESSAGING_EVENT_NAMES` e aplicar em `build_payload` **e** em `build_page_payload`.
2. [ ] `meta_capi.py`: criar `page_id_for(cfg, source_app)`.
3. [ ] `meta_capi.py`, `google_ads.py`, `generic_webhook.py`: classes de erro com `http_status` e `body`, preenchidos no `send`.
4. [ ] `dispatch.py`: novo `_with_parallel` (WABA opcional, troca pelo formato page quando não há WABA).
5. [ ] `dispatch.py`: separar `_check_meta` do `_build_meta`, runners com 3 itens, `force`/`exact` no `dispatch_conversion`, gravar `http_status`/`response_body` no `except`.
6. [ ] `dispatch.py` e `routers/conversions.py` (preview): usar `page_id_for(cfg, contact.ad_source_app)`.
7. [ ] `routers/conversions.py`: `force` no retry e `exact=bool(destinations)`.
8. [ ] Config: `meta_instagram_id` em DEFAULTS, OVERRIDABLE, META_FIELDS, serialize, InstanceIn e InstancePatch. Opcionalmente `META_INSTAGRAM_ID` no `.env.example`.
9. [ ] Confirmar que o contato grava `ad_source_app` (vindo de `referral.source_app`, em minúsculo).
10. [ ] Frontend: `api.retry` com opções, `Conversions.tsx` (reenviar/forçar, request e response lado a lado), campos novos em Tracking, Destinations e Numbers.
11. [ ] Testes do item 5.

## 7. Como validar em produção

1. Em **Rastreamento > Meta**, preencha o Dataset ID, o token e **pelo menos um** entre WABA, Page ID e ID do Instagram. Para testar, coloque o `test_event_code`.
2. Gere um lead de teste vindo de anúncio CTWA (ou do simulador), para que ele tenha `ctwa_clid`.
3. Na aba **Conversões**, abra o envio e confira:
   - `event_name` = `LeadSubmitted`;
   - `user_data.page_id` correto (Instagram para lead do Instagram);
   - `response · HTTP 200` com `events_received: 1`.
4. Se aparecer erro **sem** response, foi a checagem local. Use **"enviar pro Meta mesmo assim"** para ver o motivo real dado pelo Meta.
5. Confira o evento no **Gerenciador de Eventos > Testar eventos** do Meta.

### Erros comuns
| Erro | Causa | Solução |
|---|---|---|
| `code 100 / subcode 2804116` | Evento sem `page_id` e sem `whatsapp_business_account_id` | Preencher WABA, Page ID ou ID do Instagram |
| "Contato sem ctwa_clid" | O lead não veio de anúncio CTWA | Usar um lead de anúncio ou o simulador |
| Meta aceita, mas não atribui à campanha | `page_id` não é o dono do `ctwa_clid` (por exemplo, Page ID do Facebook em lead do Instagram) | Preencher o ID do Instagram |
