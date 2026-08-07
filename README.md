# WhatsApp Conversion Tracker

Plataforma para conectar um número de WhatsApp (Cloud API oficial), capturar leads
vindos de anúncios **Click to WhatsApp** com o identificador de clique, e disparar
o evento de conversão de volta para a campanha.

Destinos suportados: **Meta Conversions API**, **Google Ads (conversões offline)** e
**webhook genérico** (n8n / Make / GTM server-side).

## Como o rastreio funciona

```
anúncio CTWA  ──clique──▶  WhatsApp  ──webhook──▶  esta plataforma  ──evento──▶  Meta / Google
                                        │                                │
                          referral.ctwa_clid                  action_source=business_messaging
                                                              user_data.ctwa_clid
```

O `ctwa_clid` chega no objeto `referral` **só na primeira mensagem depois do clique**.
É ele que amarra a conversa ao anúncio — por isso o webhook é gravado no ato e a
atribuição nunca é sobrescrita nas mensagens seguintes.

O Google Ads não injeta `gclid` no WhatsApp. O caminho suportado é a landing page
montar o link `wa.me` com o clique embutido no texto pré-preenchido
(`"Olá! gclid=Cj0KC..."`). O extrator lê `gclid`, `wbraid`, `gbraid` e UTMs tanto da
`source_url` quanto do texto da mensagem.

## Subir

```bash
cp .env.example .env
docker compose up --build
```

- Painel: http://localhost:8030
- API: http://localhost:8000 (docs em `/docs`)

### Sem docker

```bash
# backend (precisa de Python 3.11+ — o código usa `str | None` em anotações avaliadas em runtime)
cd backend && python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8000

# frontend
cd frontend && npm install && npm run dev
```

## Configurar a conexão

A Meta exige HTTPS público no webhook. Em dev:

```bash
ngrok http 8030          # o frontend faz proxy de /webhook e /api pro backend
```

Ponha o host do ngrok em `PUBLIC_BASE_URL` no `.env` e reinicie o backend.

Depois, na aba **Conexão** do painel:

| Campo | Onde achar |
|---|---|
| Access Token | Business Settings → Usuários do sistema → token com `whatsapp_business_messaging` |
| Phone Number ID | Meta for Developers → WhatsApp → API Setup |
| WABA ID | mesma tela do Phone Number ID |
| Verify Token | você inventa; use o mesmo no painel da Meta |
| App Secret | App → Settings → Basic |

No painel da Meta (WhatsApp → Configuration → Webhook), cole a URL que o painel
mostra (`https://SEU-NGROK/webhook/whatsapp`), o mesmo Verify Token, e **assine o
campo `messages`**. Volte no painel e clique em *Testar conexão* e *Assinar webhooks*.

## Testar sem gastar clique em anúncio

Aba **Leads** → *Simular lead*. Isso injeta um payload idêntico ao da Meta, com
`referral.ctwa_clid` preenchido, e o lead aparece na lista com a atribuição extraída.

Em seguida, no detalhe do lead → *Disparar conversão*:

- **Ver payload** monta o JSON dos três destinos sem enviar nada.
- **Disparar conversão** envia de verdade e grava request + response de cada destino.
- Com **modo teste** ligado, o Meta recebe o `test_event_code` — o evento aparece em
  *Events Manager → Test Events* e não entra na otimização da campanha.

A aba **Conversões** mostra o log completo, com retry por destino que falhou.

## Configurar os destinos

Aba **Destinos**.

**Meta CAPI** — Dataset/Pixel ID e o token gerado em Events Manager → Configurações.
O evento sai como:

```json
{
  "event_name": "Lead",
  "action_source": "business_messaging",
  "messaging_channel": "whatsapp",
  "user_data": { "ctwa_clid": "...", "ph": ["<sha256>"] }
}
```

**Google Ads** — Customer ID, Conversion Action ID (tipo *Importar*), developer token
e OAuth (client id/secret + refresh token). O upload usa `uploadClickConversions`.

**Webhook** — URL de destino. Com secret preenchido, o corpo vai assinado em
`X-Signature-256: sha256=<hmac>`.

## Estrutura

```
backend/app/
  main.py                 app + /api/health, /api/stats
  ingest.py               webhook da Meta -> Contato + Mensagem (e o simulador)
  tracking.py             extração de ctwa_clid / gclid / wbraid / UTMs
  settings_store.py       config env + override no banco, com mascaramento de segredo
  models.py               contacts, messages, conversions, dispatches, webhook_logs
  routers/                config, webhook, contacts, conversions
  services/
    whatsapp_cloud.py     Graph API: status do número, subscribe, envio, assinatura
    meta_capi.py          montagem e envio do evento CAPI
    google_ads.py         OAuth + uploadClickConversions
    generic_webhook.py    POST assinado
    dispatch.py           orquestra os destinos e registra cada tentativa
```

## Notas

- O payload de request é gravado **antes** do envio, então um destino que recusa
  ainda deixa visível o JSON exato que foi montado.
- `event_id` é único por conversão; o Meta deduplica por ele, então o retry é seguro.
- O webhook responde 200 mesmo em erro de processamento — a Meta reentrega em loop
  caso contrário, e reentregar um payload quebrado não resolve nada. O erro fica no log.
- Sem App Secret configurado, a validação de assinatura é ignorada. Preencha antes de
  expor isso em produção.
