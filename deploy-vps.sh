#!/usr/bin/env bash
# deploy-vps.sh — sobe a Evolution + o tracker na VPS e deixa os dois falando.
#
# Uso (na VPS, na pasta do tracker):
#   bash deploy-vps.sh                 # faz tudo
#   bash deploy-vps.sh --dry-run       # so mostra o que faria, nao muda nada
#
# Variaveis opcionais:
#   EVO_DIR=/caminho/evolution   pasta do compose da Evolution (padrao: ../evolution)
#   EVO_HOST_PORT=8083           porta do HOST so pro painel /manager
#   PUBLIC_IP=1.2.3.4            IP publico, se a deteccao automatica falhar
#   DOMAIN=track.agenciabrandcast.com.br
#                                subdominio do painel (este e o padrao). O script
#                                instala nginx + certbot no host, emite o certificado
#                                Let's Encrypt e poe o nginx em 80/443 na frente da 3031.
#                                DOMAIN= (vazio) pula tudo isso e fica so em http://IP:3031.
#   CERT_EMAIL=voce@dominio      email pros avisos de expiracao do Let's Encrypt (opcional)
#   PUBLIC_URL=https://dominio   endereco publico do painel. Padrao: https://$DOMAIN,
#                                ou http://IP:3031 quando DOMAIN vazio — nesse caso a
#                                tela de Conexao mostra uma URL de webhook http://, que
#                                a Evolution recusa.
#
# Na sua maquina de dev vale o mesmo script, so trocando o endereco publico:
#   PUBLIC_IP=localhost bash deploy-vps.sh
# (sem isso ele grava o IP publico no PUBLIC_BASE_URL, que em dev nao resolve)
#
# O QUE ESTE SCRIPT RESOLVE
# O tracker chamava a Evolution por uma porta do host (host.docker.internal:8080,
# depois :8083). Na VPS a 8080 e do dashboard-meta-gateway, entao o /instance/create
# caia no frontend daquele projeto, que respondia 404 com uma pagina HTML. Aqui a
# chamada passa a ser container->container pela rede evolution-net, em
# http://evolution_api:8080 — essa 8080 e a de DENTRO do container da Evolution,
# nao encosta na 8080 do host.
#
# E corrige o banco: a URL tambem mora em settings/wa_numbers (settings_store.py:
# "default vem do .env, override vem do banco"), e o banco vence o .env. Trocar so
# o arquivo deixava o erro identico.

set -euo pipefail

# `evolution_api` e o container_name da Evolution: o Docker sempre o resolve na
# rede, com ou sem alias declarado no compose dela. Um alias extra pode nao
# existir num container que subiu antes de ele ser adicionado — foi assim que
# "Name or service not known" apareceu na hora de cadastrar linha.
EVO_INTERNAL_URL="http://evolution_api:8080"
TRACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVO_DIR="${EVO_DIR:-$(cd "$TRACK_DIR/.." && pwd)/evolution}"
EVO_HOST_PORT="${EVO_HOST_PORT:-8083}"
# ${DOMAIN-...} (sem ':') pra que DOMAIN= vazio desligue o TLS de proposito.
DOMAIN="${DOMAIN-track.agenciabrandcast.com.br}"
CERT_EMAIL="${CERT_EMAIL:-}"
APP_PORT=3031   # porta do frontend no host (docker-compose.yml)
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

c_err=$'\033[0;31m'; c_ok=$'\033[0;32m'; c_inf=$'\033[0;36m'; c_wrn=$'\033[0;33m'; c_off=$'\033[0m'
err()  { echo "${c_err}[erro]${c_off} $*" >&2; exit 1; }
info() { echo "${c_inf}[info]${c_off} $*"; }
ok()   { echo "${c_ok}[ok]${c_off} $*"; }
warn() { echo "${c_wrn}[aviso]${c_off} $*"; }
step() { echo; echo "${c_inf}=====${c_off} $* ${c_inf}=====${c_off}"; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then echo "  (dry-run) $*"; else "$@"; fi; }

[ "$DRY_RUN" -eq 1 ] && warn "modo dry-run: nada sera alterado."

# ---------------------------------------------------------------- 1. requisitos
step "1/8 Requisitos"

command -v docker >/dev/null || err "docker nao encontrado."
docker compose version >/dev/null 2>&1 || err "'docker compose' (v2) nao encontrado. Este script nao usa docker-compose v1."
[ -f "$TRACK_DIR/docker-compose.yml" ] || err "nao achei docker-compose.yml em $TRACK_DIR"
[ -f "$TRACK_DIR/.env" ] || err "nao achei $TRACK_DIR/.env — copie o da sua maquina (rsync) antes de rodar."

if [ ! -d "$EVO_DIR" ]; then
  err "nao achei a pasta da Evolution em $EVO_DIR.
  Ela nao esta em nenhum git, entao precisa vir por rsync da sua maquina:
    rsync -av ~/Documents/Gabriel/Teste/evolution/ usuario@ESTA-VPS:$EVO_DIR/
  Ou aponte outra pasta:  EVO_DIR=/caminho bash deploy-vps.sh"
fi
[ -f "$EVO_DIR/.env" ] || err "nao achei $EVO_DIR/.env (esta no .gitignore da Evolution — copie por rsync)."
ok "docker, compose e as duas pastas no lugar."

# O TLS mexe no host (apt, /etc/nginx, /etc/letsencrypt): checa antes de tocar nos .env.
SUDO=""
if [ -n "$DOMAIN" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null || err "o passo de TLS precisa de root. Rode como root ou instale o sudo."
    SUDO="sudo"
  fi
  command -v nginx >/dev/null && command -v certbot >/dev/null || command -v apt-get >/dev/null \
    || err "nginx/certbot nao instalados e nao achei apt-get pra instalar. Instale os dois e rode de novo."
  # Se a 80 ja e de outro servico (um container, um Caddy...), o nginx nao sobe.
  if ! command -v nginx >/dev/null && ss -ltn 2>/dev/null | grep -qE ':80 '; then
    err "a porta 80 do host ja esta ocupada e nao e um nginx. O certificado precisa dela.
  Veja quem e:  $SUDO ss -ltnp | grep ':80 '"
  fi
  ok "TLS: vai emitir certificado para ${DOMAIN}."
fi

# A porta do host so serve pro painel /manager. Se ja for do evolution_api, tudo bem.
if [ -z "$(docker ps -q -f name='^evolution_api$')" ] && ss -ltn 2>/dev/null | grep -q ":${EVO_HOST_PORT} "; then
  err "a porta ${EVO_HOST_PORT} do host ja esta ocupada por outro servico.
  Escolha outra:  EVO_HOST_PORT=8085 bash deploy-vps.sh
  (isso muda so o acesso ao painel /manager; o tracker nao usa porta do host)"
fi

# ------------------------------------------------------------------ 2. IP/env
step "2/8 Ajustando os .env para esta maquina"

IP="${PUBLIC_IP:-$(curl -s --max-time 8 ifconfig.me || true)}"
[ -n "$IP" ] || IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || err "nao consegui descobrir o IP. Passe manualmente: PUBLIC_IP=1.2.3.4 bash deploy-vps.sh"
info "IP desta maquina: $IP"

# Com dominio + nginx do host na frente, quem responde ao mundo e o nginx em
# https://dominio — nao a 3031 direto.
if [ -n "$DOMAIN" ]; then
  PUBLIC_URL="${PUBLIC_URL:-https://${DOMAIN}}"
else
  PUBLIC_URL="${PUBLIC_URL:-http://${IP}:${APP_PORT}}"
fi
info "URL publica do painel: $PUBLIC_URL"

# Estes tres sao os unicos valores que diferem entre a sua maquina e a VPS.
set_kv() { # arquivo chave valor
  local f="$1" k="$2" v="$3"
  grep -q "^${k}=" "$f" || err "chave ${k} nao existe em ${f}"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  (dry-run) ${f}: ${k}=${v}"
  else
    sed -i "s#^${k}=.*#${k}=${v}#" "$f"
    echo "  ${k}=${v}"
  fi
}
# Igual ao set_kv, mas cria a chave se ela nao existir: vale pras chaves novas,
# que nao estao no .env de quem ja tinha a aplicacao rodando antes delas.
set_or_add_kv() { # arquivo chave valor
  local f="$1" k="$2" v="$3"
  if grep -q "^${k}=" "$f"; then
    set_kv "$f" "$k" "$v"
  elif [ "$DRY_RUN" -eq 1 ]; then
    echo "  (dry-run) ${f}: + ${k}=${v}"
  else
    printf '\n%s=%s\n' "$k" "$v" >> "$f"
    echo "  + ${k}=${v}"
  fi
}

set_kv "$TRACK_DIR/.env" PUBLIC_BASE_URL     "$PUBLIC_URL"
set_kv "$TRACK_DIR/.env" EVOLUTION_BASE_URL  "$EVO_INTERNAL_URL"
# A Evolution chama o backend pela rede interna do Docker. Sem isso, a entrega do
# webhook passaria pelo dominio publico e ficaria refem de DNS, TLS e proxy — e
# uma URL publica que para de responder derruba o rastreio inteiro em silencio.
set_or_add_kv "$TRACK_DIR/.env" EVOLUTION_CALLBACK_BASE_URL "http://backend:8000"
set_kv "$EVO_DIR/.env"   SERVER_URL          "http://${IP}:${EVO_HOST_PORT}"
ok ".env ajustados."

# ------------------------------------------------------------- 3. sobe a evolution
step "3/8 Subindo a Evolution (ela cria a rede evolution-net)"

run docker compose --project-directory "$EVO_DIR" up -d
if [ "$DRY_RUN" -eq 0 ]; then
  docker network inspect evolution-net -f '{{.Name}}' >/dev/null 2>&1 \
    || err "a rede evolution-net nao foi criada — veja: docker compose --project-directory $EVO_DIR logs"
  ok "evolution-net existe."
fi

# --------------------------------------------------------------- 4. espera subir
step "4/8 Esperando a Evolution responder"

if [ "$DRY_RUN" -eq 0 ]; then
  KEY="$(grep '^AUTHENTICATION_API_KEY=' "$EVO_DIR/.env" | cut -d= -f2-)"
  [ -n "$KEY" ] || err "AUTHENTICATION_API_KEY vazia em $EVO_DIR/.env"
  # A primeira subida roda as migrations do Postgres e demora bem mais que as seguintes.
  for i in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
            -H "apikey: $KEY" "http://127.0.0.1:${EVO_HOST_PORT}/instance/fetchInstances" || true)"
    [ "$code" = "200" ] && { ok "Evolution respondeu 200 (tentativa $i)."; break; }
    [ "$i" = "60" ] && err "a Evolution nao respondeu em ~2min (ultimo status: ${code:-sem resposta}).
  Veja o log:  docker compose --project-directory $EVO_DIR logs --tail=50 api"
    sleep 2
  done
  # A apikey do tracker precisa ser a mesma, senao a proxima etapa passa e o uso falha.
  TRACK_KEY="$(grep '^EVOLUTION_API_KEY=' "$TRACK_DIR/.env" | cut -d= -f2-)"
  [ "$TRACK_KEY" = "$KEY" ] || warn "EVOLUTION_API_KEY do tracker != AUTHENTICATION_API_KEY da Evolution.
  A conexao vai falhar com 401. Iguale as duas antes de usar o painel."
fi

# ----------------------------------------------------------------- 5. sobe o track
step "5/8 Subindo o tracker"

run docker compose --project-directory "$TRACK_DIR" up -d
if [ "$DRY_RUN" -eq 0 ]; then
  for i in $(seq 1 30); do
    docker compose --project-directory "$TRACK_DIR" exec -T backend \
      curl -fsS -o /dev/null --max-time 5 http://localhost:8000/api/health 2>/dev/null \
      && { ok "backend do tracker de pe."; break; }
    [ "$i" = "30" ] && err "o backend nao respondeu.  docker compose --project-directory $TRACK_DIR logs --tail=50 backend"
    sleep 2
  done
fi

# -------------------------------------------------------------------- 6. o banco
step "6/8 Corrigindo a URL gravada no banco"

# settings.value e coluna JSON (models.py:24) — o '||' de merge so existe em jsonb,
# por isso o cast de ida e volta. wa_numbers so e tocado onde a URL aponta pro
# host/localhost: uma linha que use outra Evolution externa fica intacta.
SQL="
\\echo '--- antes ---'
select value->>'evo_base_url' as global from settings where key='config';
select id, evo_base_url from wa_numbers where evo_base_url is not null;

update settings
   set value = (value::jsonb || jsonb_build_object('evo_base_url','${EVO_INTERNAL_URL}'))::json
 where key='config';

update wa_numbers
   set evo_base_url = '${EVO_INTERNAL_URL}'
 where evo_base_url ~ '(host\\.docker\\.internal|localhost|127\\.0\\.0\\.1)';

\\echo '--- depois ---'
select value->>'evo_base_url' as global from settings where key='config';
select id, evo_base_url from wa_numbers where evo_base_url is not null;
"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  (dry-run) rodaria no postgres do tracker:"; echo "$SQL" | sed 's/^/    /'
else
  echo "$SQL" | docker compose --project-directory "$TRACK_DIR" exec -T db psql -U tracker -d tracker
  ok "banco atualizado."
fi

# ---------------------------------------------------------------- 7. dominio + TLS
step "7/8 Dominio ${DOMAIN:-(nenhum)} + certificado"

# Liga o subdominio ao painel: nginx do HOST em 80/443 -> 127.0.0.1:3031 (o nginx do
# container, que ja faz o proxy de /api, /t e /webhook pro backend). O certificado
# e do Let's Encrypt pelo desafio HTTP (webroot), que funciona com a nuvem laranja
# da Cloudflare ligada: a Cloudflare repassa o /.well-known pra ca, e o bloco 443
# tambem responde o desafio, entao a renovacao passa mesmo com "Always Use HTTPS".
write_root() { # arquivo — conteudo vem do stdin
  if [ "$DRY_RUN" -eq 1 ]; then echo "  (dry-run) escreveria $1:"; sed 's/^/    /'
  else $SUDO tee "$1" >/dev/null; fi
}

if [ -z "$DOMAIN" ]; then
  info "DOMAIN vazio: sem nginx no host nem certificado. Painel fica em $PUBLIC_URL."
else
  if ! command -v nginx >/dev/null || ! command -v certbot >/dev/null; then
    info "instalando nginx e certbot..."
    run $SUDO apt-get update -qq
    run $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx certbot
  fi

  WEBROOT=/var/www/certbot
  if [ -d /etc/nginx/sites-available ]; then
    NGX_CONF="/etc/nginx/sites-available/${DOMAIN}"
    NGX_LINK="/etc/nginx/sites-enabled/${DOMAIN}"
  else
    NGX_CONF="/etc/nginx/conf.d/${DOMAIN}.conf"; NGX_LINK=""
  fi
  CF_SNIPPET=/etc/nginx/snippets/cloudflare-realip.conf
  CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
  run $SUDO mkdir -p "$WEBROOT/.well-known/acme-challenge" /etc/nginx/snippets

  # Com a Cloudflare na frente, o $remote_addr e o IP da Cloudflare, nao o do lead.
  # O backend usa o IP no geo da jornada e na trava de forca bruta do login: aqui
  # o nginx volta a enxergar o IP real pelo CF-Connecting-IP, mas so quando quem
  # manda o cabecalho e de fato a Cloudflare (lista oficial de faixas).
  cf_ips="$( { curl -fsS --max-time 8 https://www.cloudflare.com/ips-v4; echo; \
               curl -fsS --max-time 8 https://www.cloudflare.com/ips-v6; } 2>/dev/null \
             | grep -E '^[0-9a-f:.]+/[0-9]+$' || true)"
  if [ -n "$cf_ips" ]; then
    { echo "# faixas da Cloudflare — gerado pelo deploy-vps.sh"
      echo "$cf_ips" | sed 's/.*/set_real_ip_from &;/'
      echo "real_ip_header CF-Connecting-IP;"; } | write_root "$CF_SNIPPET"
  elif [ ! -f "$CF_SNIPPET" ]; then
    warn "nao baixei as faixas da Cloudflare: o backend vai ver o IP da Cloudflare em vez do lead."
    echo "# vazio: faixas da Cloudflare indisponiveis no deploy" | write_root "$CF_SNIPPET"
  fi

  # O mesmo proxy vale pro 80 (antes do certificado) e pro 443.
  proxy_block="
    location ^~ /.well-known/acme-challenge/ { root ${WEBROOT}; default_type text/plain; }

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;   # analise com IA e varredura de prospeccao demoram
        client_max_body_size 25m;
    }"

  render_http_only() {
    cat <<NGX
# ${DOMAIN} -> tracker (porta ${APP_PORT}). Gerado pelo deploy-vps.sh — rode-o de novo em vez de editar.
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    include ${CF_SNIPPET};
${proxy_block}
}
NGX
  }

  render_https() {
    cat <<NGX
# ${DOMAIN} -> tracker (porta ${APP_PORT}). Gerado pelo deploy-vps.sh — rode-o de novo em vez de editar.
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    include ${CF_SNIPPET};
    location ^~ /.well-known/acme-challenge/ { root ${WEBROOT}; default_type text/plain; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${DOMAIN};
    include ${CF_SNIPPET};

    ssl_certificate     ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000" always;
${proxy_block}
}
NGX
  }

  # nginx < 1.25 nao conhece "http2 on;": nele o http2 vai no proprio listen.
  ngx_ver="$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -n1 || true)"
  http2_compat() {
    if [ -n "$ngx_ver" ] && [ "$(printf '%s\n1.25\n' "$ngx_ver" | sort -V | head -n1)" != "1.25" ]; then
      sed -e '/http2 on;/d' -e 's/listen \(.*\)443 ssl;/listen \1443 ssl http2;/'
    else
      cat
    fi
  }

  reload_nginx() {
    [ -n "$NGX_LINK" ] && run $SUDO ln -sf "$NGX_CONF" "$NGX_LINK"
    if [ "$DRY_RUN" -eq 1 ]; then echo "  (dry-run) nginx -t && systemctl reload nginx"; return; fi
    $SUDO nginx -t >/dev/null 2>&1 || { $SUDO nginx -t; err "config do nginx invalida (acima)."; }
    $SUDO systemctl enable nginx >/dev/null 2>&1 || true
    $SUDO systemctl reload nginx 2>/dev/null || $SUDO systemctl restart nginx
  }

  if $SUDO test -f "$CERT_DIR/fullchain.pem" 2>/dev/null; then
    ok "certificado ja existe em $CERT_DIR — so reescrevo a config."
  else
    # Primeiro so a porta 80, pra o Let's Encrypt validar: um bloco 443 apontando
    # pra um certificado que ainda nao existe derrubaria o nginx inteiro.
    render_http_only | write_root "$NGX_CONF"
    reload_nginx

    if [ "$DRY_RUN" -eq 0 ]; then
      # Antes de gastar tentativa no Let's Encrypt (limite de falhas por hora),
      # confirma que http://DOMAIN chega neste nginx — DNS e Cloudflare certos.
      probe="probe-$$"
      echo ok | $SUDO tee "$WEBROOT/.well-known/acme-challenge/$probe" >/dev/null
      got="$(curl -s --max-time 10 "http://${DOMAIN}/.well-known/acme-challenge/$probe" || true)"
      $SUDO rm -f "$WEBROOT/.well-known/acme-challenge/$probe"
      [ "$got" = "ok" ] || err "http://${DOMAIN} nao chega neste servidor (resposta: '${got:0:80}').
  Confira na Cloudflare o registro A '${DOMAIN%%.*}' apontando pra ${IP},
  e se as portas 80 e 443 estao abertas no firewall da VPS/provedor.
  Resolucao atual:  getent hosts ${DOMAIN}"
      ok "http://${DOMAIN} chega neste nginx."
    fi

    email_args=(--register-unsafely-without-email)
    [ -n "$CERT_EMAIL" ] && email_args=(--email "$CERT_EMAIL")
    # --deploy-hook fica gravado na renovacao: o timer do certbot renova sozinho
    # e recarrega o nginx com o certificado novo.
    run $SUDO certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
      --agree-tos --non-interactive "${email_args[@]}" \
      --deploy-hook "systemctl reload nginx" \
      || err "o certbot falhou. Log: $SUDO tail -n 50 /var/log/letsencrypt/letsencrypt.log"
    ok "certificado emitido."
  fi

  render_https | http2_compat | write_root "$NGX_CONF"
  reload_nginx
  ok "nginx servindo https://${DOMAIN} -> 127.0.0.1:${APP_PORT}."
fi

# ----------------------------------------------------------------- 8. verificacao
step "8/8 Verificacao ponta a ponta"

if [ "$DRY_RUN" -eq 0 ]; then
  code="$(docker compose --project-directory "$TRACK_DIR" exec -T backend \
          curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$EVO_INTERNAL_URL/" || true)"
  [ -n "$code" ] && [ "$code" != "000" ] \
    && ok "o backend do tracker alcanca a Evolution (HTTP $code)." \
    || err "o backend ainda nao alcanca $EVO_INTERNAL_URL.
  Confira se o backend entrou na rede:
    docker inspect -f '{{json .NetworkSettings.Networks}}' \$(docker compose --project-directory $TRACK_DIR ps -q backend)"

  if [ -n "$DOMAIN" ]; then
    # --resolve vai direto neste servidor, sem passar pela Cloudflare: prova que o
    # certificado de origem e valido (o que o modo "Full (strict)" dela exige).
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
            --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/api/health" || true)"
    [ "$code" = "200" ] \
      && ok "https://${DOMAIN} responde com certificado valido (HTTP 200)." \
      || warn "https://${DOMAIN}/api/health direto na origem deu HTTP ${code:-sem resposta}.
  Veja:  $SUDO tail -n 30 /var/log/nginx/error.log"
  fi

  echo
  ok "Pronto."
  echo "  Painel do tracker : ${PUBLIC_URL}"
  echo "  Painel da Evolution: http://127.0.0.1:${EVO_HOST_PORT}/manager"
  echo "                       (so localhost — use: ssh -L ${EVO_HOST_PORT}:127.0.0.1:${EVO_HOST_PORT} usuario@${IP})"
  echo
  echo "Agora crie a linha pelo painel e leia o QR code. O que este script NAO faz:"
  echo "  - parear o WhatsApp (o QR e manual, por design)"
  if [ -n "$DOMAIN" ]; then
    echo "  - abrir as portas 80 e 443 no firewall do seu provedor (a 3031 nao precisa mais)"
    echo "  - na Cloudflare: SSL/TLS -> modo 'Full (strict)'. 'Flexible' entra em loop de redirect."
  else
    echo "  - abrir a porta 3031 no firewall do seu provedor"
  fi
fi
