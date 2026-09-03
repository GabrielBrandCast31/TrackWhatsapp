# WhatsApp Conversion Tracker — Evolution API

Rastreia conversa de WhatsApp vinda de anúncio **Click to WhatsApp** e devolve o evento
de conversão para a campanha, com o valor certo, no momento certo.

O canal é a **Evolution API**. É ela que entrega a mensagem crua do WhatsApp — e é na
mensagem crua que vem o `ctwaClid`, o identificador que amarra a conversa ao anúncio.
Sem ele o Meta não tem como atribuir nada.

```
anúncio CTWA ──clique──▶ WhatsApp ──Evolution API──▶ esta plataforma ──evento──▶ Meta
                                          │                              │
                       contextInfo.externalAdReply.ctwaClid    action_source=business_messaging
                                                               user_data.ctwa_clid
```

**O disparo é a palavra-chave do atendente.** A pessoa dizer "oi" não é conversão. O que
vale é o atendente responder no chat com o termo que só aparece quando o atendimento
aconteceu de verdade — "Agradecemos a confiança", "Seu horário está confirmado". Você
cadastra esse termo, e o evento sai sozinho quando ele aparecer. Cada regra tem um
**simulador**: cole a mensagem e veja, antes de valer no chat, se dispararia e com que
valor.

Cada linha é uma **instância da Evolution**, com Pixel, token e palavras-chave próprios.
Um seletor no topo do painel define qual linha você está olhando.

## A tela

| Aba | O que faz |
|---|---|
| **Conexão** | cadastra a instância (URL, apikey, nome), pareia por QR e grava o webhook |
| **Rastreamento** | Pixel + token da API de Conversões, e as regras de palavra-chave com simulador |
| **CRM** | as conversas daquele número, em kanban, lista ou caixa de entrada |
| **Leads** | quem chegou, com a atribuição extraída; disparo manual quando você quiser |
| **Conversões** | log de cada evento: payload que saiu, resposta do Meta, retry |
| **Admin** | prospecção no mapa, CRM, abordagem ativa, Cloud API, destinos extras e usuários (só perfil admin) |

O painel inteiro fica atrás de **login** — veja [Login e usuários](#login-e-usuários).

## Subir

```bash
cp .env.example .env
docker compose up --build
```

- Painel: http://localhost:3030 (abre no login)
- API: http://localhost:8040 (docs em `/docs`) — publicada só no localhost da máquina

No primeiro acesso, entre com `ADMIN_USER` / `ADMIN_PASSWORD` do `.env`.

### Na VPS

```bash
cp .env.example .env
# obrigatórios antes de expor:
#   JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))")
#   ADMIN_PASSWORD=<uma senha sua>
#   PUBLIC_BASE_URL=https://seu.dominio
docker compose up --build -d
docker compose logs -f backend      # confere que não sobrou WARNING de senha/segredo padrão
```

Só a porta `3030` (o nginx do frontend) precisa sair pra internet — ela serve o painel e
faz proxy de `/api` e `/webhook`. O backend fica em `127.0.0.1:8040`, e o Postgres, só na
rede interna do compose. Ponha um proxy com TLS (Caddy, Nginx, Traefik) na frente da 3030
e aponte `PUBLIC_BASE_URL` pro domínio HTTPS — a Evolution precisa alcançar o webhook por
HTTPS, e o token de login não deve trafegar em texto claro.

Depois de subir: entre no painel, vá em **Admin → Usuários**, crie a conta de cada pessoa
e troque a senha do admin inicial.

### Sem docker

```bash
# backend (precisa de Python 3.11+ — o código usa `str | None` em anotações avaliadas em runtime)
cd backend && python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8040

# frontend
cd frontend && npm install && npm run dev
```

## Conectar a Evolution API

A Evolution precisa alcançar esta aplicação por HTTPS público. Em dev:

```bash
ngrok http 3030          # o frontend faz proxy de /webhook e /api pro backend
```

Ponha o host do ngrok em `PUBLIC_BASE_URL` no `.env` e reinicie o backend.

Aba **Conexão** → *Adicionar linha*:

| Campo | O que é |
|---|---|
| Nome da linha | como você reconhece o cliente no seletor do topo |
| Instância | o nome exato da instância na sua Evolution (`/instance/fetchInstances`) |
| URL da Evolution API | `https://evo.seudominio.com` |
| apikey | o header `apikey` — a chave global ou a da instância |

Depois, nos botões da linha:

1. **Conectar (QR)** — se a instância ainda não estiver pareada.
2. **Configurar webhook** — grava a URL desta linha na instância. **Sem isso nada é
   rastreado.** Os eventos assinados são `MESSAGES_UPSERT`, `SEND_MESSAGE`,
   `MESSAGES_UPDATE` e `CONNECTION_UPDATE`.
3. **Verificar status** — confere o pareamento e se o webhook aponta pra cá.

A URL do webhook termina com um **token secreto por linha**. É ele que autentica o POST:
sem o token certo, a requisição é recusada com 401. Trate essa URL como senha; se ela
vazar, edite a linha e gere outro token.

Existe também uma URL única (`/webhook/evolution`), roteada pelo campo `instance` do
payload e autenticada pela `apikey` que a própria Evolution manda no corpo. Serve para
quem prefere apontar todas as instâncias para o mesmo endereço.

## Pixel e token

Aba **Rastreamento** → *Meta — Pixel e token da API*, por linha:

| Campo | Onde achar |
|---|---|
| Pixel / Dataset ID | Events Manager → sua fonte de dados → Configurações |
| Token da API de Conversões | Events Manager → Configurações → Gerar token de acesso |
| Test Event Code | Events Manager → Test Events (usado só nas regras marcadas como teste) |

O evento sai assim:

```json
{
  "event_name": "Lead",
  "action_source": "business_messaging",
  "messaging_channel": "whatsapp",
  "user_data": { "ctwa_clid": "...", "ph": ["<sha256 do telefone>"] },
  "custom_data": { "value": 1250.0, "currency": "BRL" }
}
```

O `ctwa_clid` vai **em claro** (é assim que o Meta espera); telefone e e-mail vão em
SHA-256.

## Eventos por palavra-chave

Aba **Rastreamento** → *Eventos de conversão por palavra-chave*. Cada regra tem:

| Campo | O que faz |
|---|---|
| **Evento** | `Lead`, `Schedule`, `Purchase`… (os eventos padrão do Meta) |
| **Palavra-chave** | o termo que precisa aparecer na mensagem |
| **Ampla / Exata** | *Ampla*: todas as palavras aparecem, em qualquer ordem. *Exata*: a frase inteira aparece na mesma ordem. As duas ignoram acento, maiúscula e pontuação |
| **Valor** | *Sem valor*, *Valor fixo*, ou *Extrair da mensagem* (lê o `R$ 1.250,00` que o atendente escreveu) |
| **Quem escreve** | o atendente (padrão), o cliente, ou qualquer um dos dois |
| **Só com `ctwa_clid`** | ligado por padrão: evento sem atribuição não serve pra campanha nenhuma |
| **Um disparo por lead** | ligado por padrão: o atendente repetir a frase não vira duas conversões |
| **Modo teste** | usa o Test Event Code — aparece em *Test Events* e não afeta a otimização |

### O simulador

Cole no campo *Simular mensagem enviada* o que o atendente escreveria. O veredito vem
na hora: **dispararia** (com o valor que sairia) ou **não dispararia** (com o motivo).

O simulador chama a **mesma função** que o webhook usa para decidir o disparo real — não
existe uma segunda implementação "aproximada" no frontend. Se ele disse que dispara,
dispara.

Exemplos com a regra `Agradecemos a confiança`, modo *Exata*, valor *Extrair*:

| Mensagem do atendente | Resultado |
|---|---|
| `Agradecemos a confiança! Ficou R$ 1.250,00` | dispara `Lead` com R$ 1.250,00 |
| `agradecemos a confianca, ficou 250,00` | dispara `Lead` com R$ 250,00 |
| `Agradecemos, de verdade, a confiança` | não dispara (no modo *Exata* a frase precisa ser contígua) |
| `Obrigado pela confiança` | não dispara |

Números que são hora ou data (`às 15:30`, `dia 12`) são ignorados na extração de valor.

## CRM de cada número

Aba **CRM**, sempre da linha selecionada no topo: as conversas de um cliente nunca
aparecem na base de outro.

O registro do CRM **é a própria conversa** — não há uma tabela de "card" paralela que
pudesse divergir do que aconteceu no chat. Na mesma lista convivem:

- quem chegou pelo anúncio (com `ctwa_clid`, marcado como **anúncio**);
- quem mandou mensagem por conta própria depois de a instância ser conectada;
- quem já estava na agenda do número, trazido pelo botão **Sincronizar** (marcado como
  **da agenda**).

### Sincronizar

O botão puxa da instância, em duas chamadas, a agenda (`/chat/findContacts`) e as
conversas (`/chat/findChats`) — e guarda a última mensagem de cada conversa, então o
chat já abre com conteúdo. Grupo, status e newsletter são descartados.

As duas chamadas são independentes: se a Evolution recusar as conversas (é o que
acontece quando ela roda **sem banco**, `DATABASE_ENABLED=false`), a agenda sozinha já
povoa o CRM e a tela avisa o que falhou.

O histórico completo de uma conversa vem **sob demanda**, no botão *puxar histórico*
dentro do chat (`/chat/findMessages`). Puxar isso para todo mundo de uma vez seria lento
e quase todo descartado.

⚠️ **Histórico importado não dispara regra de palavra-chave.** As regras marcam o momento
em que o atendimento acontece; reprocessar meses de conversa antiga mandaria uma enxurrada
de eventos falsos para o Meta.

### As três visualizações

Mesmos dados, mesmos endpoints — muda o que cada uma coloca na frente:

| Visualização | Para quê |
|---|---|
| **Kanban** | mover a conversa entre `Novo` → `Atendendo` → `Qualificado` → `Ganho`/`Perdido` arrastando o card |
| **Lista** | tabela com busca e filtros, com o detalhe ao lado — bom para varrer volume |
| **Caixa de entrada** | conversas por última mensagem, thread ao lado — bom para atender |

Em qualquer uma, clicar abre o mesmo painel: etapa, nota interna, conversa, caixa de
resposta, a atribuição do anúncio e o disparo manual de conversão.

A busca cobre nome, telefone, nota **e o texto das mensagens** da conversa.

### Etapas

`novo` → `atendendo` → `qualificado` → `ganho` / `perdido`

`atendendo` é automático: quando o atendente responde uma conversa que está em `novo`,
o card avança sozinho. Etapa movida à mão nunca é rebaixada pelo automático.

### Responder pelo CRM

A caixa de resposta manda a mensagem pela Evolution. A mensagem **não** é gravada no ato:
a Evolution devolve o evento `SEND_MESSAGE` no webhook, e é por lá que ela entra — junto
com a avaliação das regras de palavra-chave. Ou seja, responder pelo CRM com o termo
configurado dispara o evento igual a responder pelo celular. Gravar dos dois lados
duplicaria conversa e disparo.

## Testar sem gastar clique em anúncio

Aba **Leads** → *Simular lead*. Injeta um payload idêntico ao da Evolution, com
`contextInfo.externalAdReply.ctwaClid` preenchido — o lead aparece na lista com a
atribuição extraída, pronto para as regras valerem em cima dele.

No detalhe do lead:

- **Ver payload** monta o JSON sem enviar nada.
- **Disparar conversão** envia de verdade e grava request + response.
- **Modo teste** manda o `test_event_code`.

A aba **Conversões** mostra o log completo, marcando o que veio de palavra-chave, e tem
retry por destino que falhou.

## Login e usuários

O painel abre numa tela de login. Sem sessão válida, **todo** `/api` responde 401 — só
`/api/health`, `/api/auth/login` e os `/webhook/*` respondem sem token (esses últimos se
autenticam sozinhos, pelo token na URL ou pela assinatura do payload).

**Como funciona.** O login devolve dois JWT assinados em HS256: um *access* curto (1h por
padrão), que vai em `Authorization: Bearer` a cada chamada, e um *refresh* longo (7 dias),
que o painel usa sozinho para renovar o access sem pedir a senha de novo. A senha nunca é
guardada: vai para o banco como PBKDF2-SHA256 com salt por usuário. Todo token carrega
uma marca da senha atual — **trocar a senha derruba na hora toda sessão emitida antes**,
inclusive a de quem tivesse copiado o token. Desativar ou apagar alguém também vale na
hora: o usuário é revalidado no banco a cada requisição, não só quando o token expira.

**Dois perfis:**

| Perfil | Vê |
|---|---|
| `operação` | Conexão, Rastreamento, CRM da linha, Leads e Conversões |
| `admin` | tudo isso mais a aba **Admin** |

A aba **Admin** guarda o que saiu da tela principal, e continua inteiro:

- **Prospecção** — varredura de potenciais clientes no Google Maps por raio (Apify)
- **CRM** — o funil dos prospects e a abordagem ativa no WhatsApp
- **Cloud API** — o canal oficial da Meta, para quem já usava a versão anterior
- **Destinos** — Google Ads (conversões offline) e webhook genérico
- **Manual** — o passo a passo com checklist de configuração
- **Usuários** — quem entra no painel: criar, trocar perfil, desativar, redefinir senha

A proteção mora no `include_router` do backend: qualquer rota nova já nasce fechada, sem
depender de alguém lembrar de decorar a função. O último administrador ativo não pode ser
rebaixado, desativado nem apagado — senão ninguém mais entra no cadastro.

**Primeiro acesso.** Base sem nenhum usuário ganha um admin com `ADMIN_USER` /
`ADMIN_PASSWORD` do `.env` (padrão `gabriel` / `gabriel123`). Depois disso o cadastro vive
no painel, e essas duas variáveis não valem mais nada. Cada um troca a própria senha pelo
botão **senha** no topo; um admin redefine a de outra pessoa em **Admin → Usuários**.

⚠️ **Antes de expor na internet**, defina no `.env`:

```bash
JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))")
ADMIN_PASSWORD=<uma senha sua>
```

`JWT_SECRET` é a chave que assina os tokens. Em branco, é sorteada a cada subida do
backend: seguro, mas todo mundo cai do login no restart (e o token de um worker não vale
no outro). Com a senha padrão em uso, o backend registra um `WARNING` no log — o
`gabriel123` está aqui no README, ou seja, é público.

O login tem trava de força bruta por IP + usuário (`LOGIN_MAX_FAILS`, 8 tentativas em
`LOGIN_FAIL_WINDOW_SECONDS`, 300s), e responde a mesma mensagem para usuário inexistente,
senha errada e conta desativada.

Bateria de fumaça do login (SQLite descartável, sem docker e sem rede):

```bash
cd backend && PYTHONPATH=$PWD ./.venv/bin/python tests/test_auth.py
```

### Prospecção ativa (varredura por raio)

```
endereço ──geocode──▶ lat/lng + raio ──Apify──▶ Google Maps ──▶ prospects no CRM
                                                                      │
                                                        abordagem no WhatsApp
                                                                      │
                                              resposta ──▶ Lead ──▶ conversão
```

Digite um endereço (o geocoder é o Nominatim/OpenStreetMap, sem chave), escolha o raio e
os termos de busca. A área vai para o actor `compass/crawler-google-places` como um
GeoJSON:

```json
{ "type": "Point", "coordinates": [-46.651918, -23.5648865], "radiusKm": 2 }
```

O Google raciocina por *viewport*, não por raio exato — então o import recalcula a
distância de cada lugar com haversine e descarta o que passou do raio (com 10% de folga
na borda).

| Etapa do import | Detalhe |
|---|---|
| Normaliza o telefone | `+55 11 3229-1681` → `+551132291681`; sem DDI, assume Brasil pelo DDD |
| Classifica | **celular** vs **fixo** — mandar mensagem para fixo queima cota e reputação |
| Deduplica | por `place_id` e por telefone canônico, atravessando varreduras |
| Descarta | fechado permanentemente, ou fora do raio pedido |

**Custo.** O Apify cobra por lugar encontrado. A varredura de 8 lugares que validou esse
fluxo custou US$ 0,04. Use *Quantidade por termo* como trava de gasto.

O token do Apify fica em *Prospecção → Conta Apify → configurar* (Console do Apify →
Settings → Integrations → API token), ou em `APIFY_TOKEN` no `.env`.

### Abordagem ativa

Aba **CRM**: filtre (só celular, por varredura, por etapa), selecione e dispare.

O disparo entra numa **fila** com intervalo configurável entre envios e limite diário. O
worker roda em background e retoma sozinho se o backend reiniciar. Cada tentativa grava
request e response crus.

Numa linha da **Evolution** o envio é texto livre — não há template aprovado nem janela
de 24h. Numa linha da **Cloud API**, mensagem fria só entrega por template aprovado pela
Meta (a aba lista os templates do WABA e marca quais estão aprovados); texto livre só
funciona dentro da janela de 24h. Isso é regra da Meta, não limitação daqui.

No texto e nas variáveis do template dá pra usar `{nome}`, `{categoria}` e `{cidade}` —
cada envio é preenchido com os dados daquele prospect.

Trava de segurança: `outreach_enabled` começa **desligado**.

### Como a resposta fecha o ciclo

Quando o prospect responde, o webhook chega e o ingest liga a mensagem ao registro do
CRM: o prospect ganha `contact_id`, vira etapa **Respondeu**, e aparece em Leads pronto
para o evento.

O match não é por igualdade de string: no Brasil o número costuma vir **sem o nono
dígito** de um lado e **com** do outro. `phones.match_key` gera uma chave canônica sem o
nono dígito e é por ela que os dois lados se reconhecem.

Etapas: `novo` → `contatado` → `respondeu` → `qualificado` → `ganho` / `perdido`.
`contatado` é automático no envio; `respondeu`, na resposta. Mover à mão nunca é
rebaixado pelo automático.

## Estrutura

```
backend/app/
  __init__.py             carrega o .env antes de qualquer submodulo
  main.py                 app, /api/health, /api/stats e o include dos routers
                          (é aqui que cada grupo ganha a dependência de login/admin)
  auth.py                 hash de senha, emissão/validação de JWT e as dependências
                          require_user / require_admin
  evolution_ingest.py     webhook da Evolution -> lead com atribuição -> regra -> evento
  crm.py                  traz agenda, conversas e histórico da instância pro CRM da linha
  ingest.py               mesmo caminho para o payload da Cloud API (canal legado)
  firing.py               criação + envio de um evento: o caminho único de disparo
  tracking.py             extração de ctwa_clid / gclid / wbraid / UTMs
  phones.py               E.164, celular vs fixo, chave canônica do nono dígito
  settings_store.py       config env + override no banco, com mascaramento de segredo
  numbers.py              resolve a linha em jogo e funde credenciais + overrides no
                          formato de config que o resto do sistema já consumia
  models.py               users, wa_numbers, keyword_rules, contacts (é também o card do
                          CRM), messages, conversions, dispatches, webhook_logs,
                          prospects, prospect_searches, outreaches
  migrations.py           ALTER TABLE idempotente rodado no startup
  routers/
    evolution.py          instâncias: cadastro, QR, webhook, Pixel/token, simulação
    rules.py              regras de palavra-chave + /simulate
    crm.py                conversas da linha: etapa, nota, sync, resposta e disparo
    auth.py               login, refresh, troca de senha e cadastro de usuários
    webhook.py            /webhook/evolution (token por linha) e /webhook/whatsapp
    contacts.py           leads e o log cru dos webhooks
    conversions.py        disparo manual, histórico e retry
    config.py             config global (admin)
    numbers.py            linhas da Cloud API (admin)
    prospecting.py        varredura, CRM e fila de abordagem (admin)
  services/
    evolution.py          cliente da Evolution API, com fallback de formato v2 -> v1
    rules.py              motor das palavras-chave: normalização, match e valor
    meta_capi.py          montagem e envio do evento CAPI
    whatsapp_cloud.py     Graph API: status, subscribe, texto e template
    apify.py              dispara o actor, acompanha o run, normaliza o lugar
    geo.py                geocode (Nominatim), haversine, área circular
    google_ads.py         OAuth + uploadClickConversions
    generic_webhook.py    POST assinado
    dispatch.py           orquestra os destinos e registra cada tentativa

backend/tests/
  test_auth.py            fumaça do login: 401 sem token, papéis, refresh, troca de senha
```

## Notas

- O `externalAdReply` pode vir em profundidades diferentes conforme o tipo de mensagem
  (texto, imagem com legenda, botão). A busca do `ctwaClid` é recursiva, em vez de fixar
  um caminho que muda a cada tipo.
- A atribuição **nunca é sobrescrita**. O bloco do anúncio só vem na primeira mensagem
  depois do clique; nas seguintes o lead já carrega o `ctwa_clid`, e o ingest só preenche
  campo que ainda estava vazio.
- Mensagem repetida não vira lead nem evento duplicado: o `key.id` da Evolution é a
  chave de dedupe, e a reentrega do mesmo evento é ignorada.
- Grupo, status e newsletter são descartados na entrada — não são conversa de pessoa.
- O resumo da última mensagem e o não-lido ficam desnormalizados em `contacts`: a lista do
  CRM precisa deles em uma consulta só, e juntar `messages` por linha da tela não escala.
  O sync nunca rebaixa esse resumo — o que o webhook gravou em tempo real é mais fresco.
- O payload de request é gravado **antes** do envio, então um destino que recusa ainda
  deixa visível o JSON exato que foi montado.
- `event_id` é único por conversão; o Meta deduplica por ele, então o retry é seguro.
- O webhook responde 200 mesmo em erro de processamento — reentregar em loop um payload
  quebrado não resolve nada, e o motivo fica no log.
- O token da URL do webhook autentica **por linha**: um POST com o token de um cliente
  não escreve na base de outro.
- O cap diário e o intervalo da abordagem contam **por linha** — cada número tem a sua
  reputação, então somar o volume de todos penalizaria quem não disparou.
- O dedupe do import de prospects também é por linha: a mesma empresa pode ser lead de
  dois clientes diferentes sem uma varredura anular a outra.
- Apagar uma varredura **não** apaga os prospects dela. A varredura é só a procedência.
- A Evolution API não é um produto oficial da Meta. Ela conecta como dispositivo pareado,
  o que significa risco de bloqueio do número se o volume e o conteúdo parecerem spam.
  Número em ficha do Google Maps é dado de contato comercial público, mas abordagem em
  massa tem consequência prática — o intervalo entre envios, o limite diário e o filtro
  de "só celular" existem para isso.
