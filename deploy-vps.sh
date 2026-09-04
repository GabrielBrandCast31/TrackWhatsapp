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
# http://evolution-api:8080 — essa 8080 e a de DENTRO do container da Evolution,
# nao encosta na 8080 do host.
#
# E corrige o banco: a URL tambem mora em settings/wa_numbers (settings_store.py:
# "default vem do .env, override vem do banco"), e o banco vence o .env. Trocar so
# o arquivo deixava o erro identico.

set -euo pipefail

EVO_INTERNAL_URL="http://evolution-api:8080"
TRACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVO_DIR="${EVO_DIR:-$(cd "$TRACK_DIR/.." && pwd)/evolution}"
EVO_HOST_PORT="${EVO_HOST_PORT:-8083}"
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
step "1/7 Requisitos"

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

# A porta do host so serve pro painel /manager. Se ja for do evolution_api, tudo bem.
if [ -z "$(docker ps -q -f name='^evolution_api$')" ] && ss -ltn 2>/dev/null | grep -q ":${EVO_HOST_PORT} "; then
  err "a porta ${EVO_HOST_PORT} do host ja esta ocupada por outro servico.
  Escolha outra:  EVO_HOST_PORT=8085 bash deploy-vps.sh
  (isso muda so o acesso ao painel /manager; o tracker nao usa porta do host)"
fi

# ------------------------------------------------------------------ 2. IP/env
step "2/7 Ajustando os .env para esta maquina"

IP="${PUBLIC_IP:-$(curl -s --max-time 8 ifconfig.me || true)}"
[ -n "$IP" ] || IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || err "nao consegui descobrir o IP. Passe manualmente: PUBLIC_IP=1.2.3.4 bash deploy-vps.sh"
info "IP desta maquina: $IP"

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
set_kv "$TRACK_DIR/.env" PUBLIC_BASE_URL     "http://${IP}:3031"
set_kv "$TRACK_DIR/.env" EVOLUTION_BASE_URL  "$EVO_INTERNAL_URL"
set_kv "$EVO_DIR/.env"   SERVER_URL          "http://${IP}:${EVO_HOST_PORT}"
ok ".env ajustados."

# ------------------------------------------------------------- 3. sobe a evolution
step "3/7 Subindo a Evolution (ela cria a rede evolution-net)"

run docker compose --project-directory "$EVO_DIR" up -d
if [ "$DRY_RUN" -eq 0 ]; then
  docker network inspect evolution-net -f '{{.Name}}' >/dev/null 2>&1 \
    || err "a rede evolution-net nao foi criada — veja: docker compose --project-directory $EVO_DIR logs"
  ok "evolution-net existe."
fi

# --------------------------------------------------------------- 4. espera subir
step "4/7 Esperando a Evolution responder"

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
step "5/7 Subindo o tracker"

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
step "6/7 Corrigindo a URL gravada no banco"

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

# ----------------------------------------------------------------- 7. verificacao
step "7/7 Verificacao ponta a ponta"

if [ "$DRY_RUN" -eq 0 ]; then
  code="$(docker compose --project-directory "$TRACK_DIR" exec -T backend \
          curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$EVO_INTERNAL_URL/" || true)"
  [ -n "$code" ] && [ "$code" != "000" ] \
    && ok "o backend do tracker alcanca a Evolution (HTTP $code)." \
    || err "o backend ainda nao alcanca $EVO_INTERNAL_URL.
  Confira se o backend entrou na rede:
    docker inspect -f '{{json .NetworkSettings.Networks}}' \$(docker compose --project-directory $TRACK_DIR ps -q backend)"

  echo
  ok "Pronto."
  echo "  Painel do tracker : http://${IP}:3031"
  echo "  Painel da Evolution: http://127.0.0.1:${EVO_HOST_PORT}/manager"
  echo "                       (so localhost — use: ssh -L ${EVO_HOST_PORT}:127.0.0.1:${EVO_HOST_PORT} usuario@${IP})"
  echo
  echo "Agora crie a linha pelo painel e leia o QR code. O que este script NAO faz:"
  echo "  - parear o WhatsApp (o QR e manual, por design)"
  echo "  - abrir a porta 3031 no firewall do seu provedor"
fi
