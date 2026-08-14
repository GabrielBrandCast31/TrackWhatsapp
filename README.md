# WhatsApp CRM & Conversion Tracker

Plataforma para conectar um número de WhatsApp (Cloud API oficial) com dois fluxos
que se encontram no mesmo funil:

- **Passivo** — captura leads vindos de anúncios **Click to WhatsApp** com o
  identificador de clique e dispara o evento de conversão de volta para a campanha.
- **Ativo** — varre potenciais clientes no Google Maps dentro de um raio (via Apify),
  monta um CRM com os telefones e dispara a abordagem pelo WhatsApp. Quem responde
  vira lead e entra no mesmo fluxo de conversão.

Destinos de conversão suportados: **Meta Conversions API**, **Google Ads (conversões
offline)** e **webhook genérico** (n8n / Make / GTM server-side).

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

Para a prospecção, preencha também o **token do Apify** na aba *Prospecção → Conta Apify
→ configurar* (Console do Apify → Settings → Integrations → API token). Se ele estiver no
`.env` como `APIFY_TOKEN`, já vem preenchido.

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

## Prospecção ativa (varredura por raio)

```
endereço ──geocode──▶ lat/lng + raio ──Apify──▶ Google Maps ──▶ prospects no CRM
                                                                      │
                                                        abordagem no WhatsApp
                                                                      │
                                              resposta ──▶ Contato ──▶ conversão
```

Aba **Prospecção**. Digite um endereço (o geocoder é o Nominatim/OpenStreetMap, sem
chave), escolha o raio e os termos de busca. A área vai para o actor
`compass/crawler-google-places` como um GeoJSON:

```json
{ "type": "Point", "coordinates": [-46.651918, -23.5648865], "radiusKm": 2 }
```

O Google raciocina por *viewport*, não por raio exato — então o import recalcula a
distância de cada lugar com haversine e descarta o que passou do raio (com 10% de
folga na borda). A distância fica visível em cada prospect.

O que o import faz com cada lugar:

| Etapa | Detalhe |
|---|---|
| Normaliza o telefone | `+55 11 3229-1681` → `+551132291681`; sem DDI, assume Brasil pelo DDD |
| Classifica | **celular** vs **fixo** — mandar mensagem para fixo queima cota e reputação |
| Deduplica | por `place_id` e por telefone canônico, atravessando varreduras diferentes |
| Descarta | fechado permanentemente, ou fora do raio pedido |

**Custo.** O Apify cobra por lugar encontrado. A varredura de 8 lugares que validou
esse fluxo custou US$ 0,04 — o crédito gratuito de US$ 5/mês dá algumas centenas de
prospects. Use *Quantidade por termo* como trava de gasto: cada termo é uma varredura
independente.

### Abordagem ativa

Aba **CRM**: filtre (só celular, por varredura, por etapa), selecione e dispare.

O disparo entra numa **fila** com intervalo configurável entre envios e limite diário —
50 disparos com 8s de intervalo levariam minutos, e a requisição HTTP estouraria. O
worker roda em background e retoma sozinho se o backend reiniciar. Cada tentativa grava
request e response crus, igual ao log de conversões.

⚠️ **Mensagem fria só entrega por template aprovado.** Texto livre da Cloud API só
funciona dentro da janela de 24h depois de a pessoa te escrever. Para lista fria, crie
um template (categoria *Marketing* ou *Utility*) no Gerenciador do WhatsApp e espere a
aprovação — a aba lista os templates do seu WABA e marca quais estão aprovados. Isso é
regra da Meta, não limitação daqui.

Nas variáveis do template (e no texto livre) você pode usar `{nome}`, `{categoria}` e
`{cidade}` — cada envio é preenchido com os dados daquele prospect.

Trava de segurança: `outreach_enabled` começa **desligado**. Nada é enviado até você
ligar em *CRM → Abordagem ativa → configurar*.

### Como a resposta fecha o ciclo

Quando o prospect responde, o webhook da Meta chega e o `ingest` liga a mensagem ao
registro do CRM: o prospect ganha `contact_id`, vira etapa **Respondeu**, e o contato
aparece na aba Leads pronto para disparar conversão.

O match não é por igualdade de string: no Brasil o `wa_id` que a Meta entrega costuma
vir **sem o nono dígito** (`5511988887777` → `551188887777`) enquanto o Maps devolve
**com**. `phones.match_key` gera uma chave canônica sem o nono dígito e é por ela que os
dois lados se reconhecem.

### Etapas do CRM

`novo` → `contatado` → `respondeu` → `qualificado` → `ganho` / `perdido`

`contatado` é automático no envio; `respondeu` é automático na resposta. O resto é
manual, e mover à mão nunca é rebaixado pelo automático.

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
  __init__.py             carrega o .env antes de qualquer submodulo
  main.py                 app + /api/health, /api/stats
  ingest.py               webhook da Meta -> Contato + Mensagem, e liga a resposta ao CRM
  tracking.py             extração de ctwa_clid / gclid / wbraid / UTMs
  phones.py               E.164, celular vs fixo, chave canônica do nono dígito
  settings_store.py       config env + override no banco, com mascaramento de segredo
  models.py               contacts, messages, conversions, dispatches, webhook_logs,
                          prospect_searches, prospects, outreaches
  routers/                config, webhook, contacts, conversions, prospecting
  services/
    whatsapp_cloud.py     Graph API: status, subscribe, envio de texto e template
    apify.py              dispara o actor, acompanha o run, normaliza o lugar
    geo.py                geocode (Nominatim), haversine, área circular
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
- A sincronização da varredura é preguiçosa: as rotas de listagem conferem no Apify
  qualquer busca ainda rodando e importam quando termina. Sem worker separado, nada fica
  pendurado se o processo reiniciar — e ainda dá pra forçar com *sincronizar*.
- Apagar uma varredura **não** apaga os prospects dela. A varredura é só a procedência;
  os prospects são o CRM.
- Número em ficha do Google Maps é dado de contato comercial público, mas abordagem em
  massa tem consequência prática: reclamação de spam derruba a nota de qualidade do seu
  número na Meta e pode limitar o envio. O intervalo entre envios, o limite diário e o
  filtro de "só celular" existem para isso — mantenha o volume baixo e a mensagem
  relevante.
