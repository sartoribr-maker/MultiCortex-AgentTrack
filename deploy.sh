#!/usr/bin/env bash
# DevCore Monitor — deploy do contêiner devcore-monitor-app-1 (127.0.0.1:3002) no EC2.
# Build local da imagem, envio por docker save | ssh, rollback para a imagem anterior.
# Não altera nginx, Apache, DNS, o site nem o agente da VM/pod.
set -Eeuo pipefail

REMOTE_HOST="${REMOTE_HOST:-ec2-user@52.207.145.100}"
REMOTE_DIR="/opt/multicortex/devcore-monitor"
PROJECT="devcore-monitor"
CONTAINER="devcore-monitor-app-1"
PORT=3002

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
fail() { echo "ERRO: $*" >&2; exit 1; }

[[ -f Dockerfile && -f docker-compose.prod.yml && -f package.json ]] || fail "Execute na raiz do projeto DevCore Monitor."
for cmd in git npm npx python3 docker ssh scp gzip; do
  command -v "$cmd" >/dev/null || fail "Comando ausente: $cmd"
done
# Docker local: direto quando o usuário tem acesso; senão, com sudo (pede senha).
DOCKER=(docker)
docker info >/dev/null 2>&1 || DOCKER=(sudo docker)
[[ -z "$(git status --porcelain)" ]] || fail "Árvore Git com alterações. Faça commit antes do deploy."
COMMIT="$(git rev-parse --short HEAD)"

say "1/6 — Validando código (tipos, lint, testes, build)"
npm run typecheck
npx eslint .
npm test
npm run build

say "2/6 — Conferindo o servidor (somente leitura)"
ssh "$REMOTE_HOST" "REMOTE_DIR='$REMOTE_DIR' CONTAINER='$CONTAINER' PORT='$PORT' bash -se" <<'REMOTE'
set -Eeuo pipefail
test -d "$REMOTE_DIR" || { echo "ERRO: crie $REMOTE_DIR (veja docs/devcore-dashboard.md, seção 5)." >&2; exit 1; }
ENV_FILE="$REMOTE_DIR/.env.production"
sudo test -f "$ENV_FILE" || { echo "ERRO: falta $ENV_FILE." >&2; exit 1; }
# Confere presença (uma vez só) e formato das variáveis; nunca mostra os valores.
for var in AUTH_SECRET AUTH_URL DEVCORE_USERS DEVCORE_METRICS_TOKEN_DEVCORE_DEMO_01; do
  sudo grep -Eq "^${var}=.+" "$ENV_FILE" || { echo "ERRO: $var ausente ou vazia em $ENV_FILE." >&2; exit 1; }
  [[ "$(sudo grep -c "^${var}=" "$ENV_FILE")" == 1 ]] || { echo "ERRO: $var aparece mais de uma vez em $ENV_FILE." >&2; exit 1; }
done
sudo grep -Eq '^AUTH_URL=https://devcore\.multicortex\.com\.br/?$' "$ENV_FILE" \
  || { echo "ERRO: AUTH_URL deve ser https://devcore.multicortex.com.br." >&2; exit 1; }
sudo grep -Eq '^AUTH_SECRET=.{32,}$' "$ENV_FILE" || { echo "ERRO: AUTH_SECRET curto demais." >&2; exit 1; }
sudo grep -Eq '^DEVCORE_METRICS_TOKEN_DEVCORE_DEMO_01="?[A-Za-z0-9_-]{32,}"?$' "$ENV_FILE" \
  || { echo "ERRO: DEVCORE_METRICS_TOKEN_DEVCORE_DEMO_01 com formato inválido." >&2; exit 1; }
# Cada entrada: email:hash(base64 ou bcrypt)[:Nome], separadas por vírgula (scripts/hash-password.ts).
USER_RE='[^@:,[:space:]<>]+@[^@:,[:space:]<>]+\.[^@:,[:space:]<>]+:[A-Za-z0-9+/=$.]{50,}(:[^,:<>]*)?'
sudo grep -Eq "^DEVCORE_USERS=${USER_RE}(,${USER_RE})*$" "$ENV_FILE" \
  || { echo "ERRO: DEVCORE_USERS com formato inválido (gere com npm run hash-password)." >&2; exit 1; }
# A porta precisa estar livre ou ser deste mesmo contêiner.
if ss -ltn | grep -Eq "127.0.0.1:${PORT}\b|:${PORT}\b"; then
  sudo docker ps --filter "name=^${CONTAINER}$" --format '{{.Ports}}' | grep -q "${PORT}->3000" \
    || { echo "ERRO: porta $PORT ocupada por outro processo." >&2; exit 1; }
fi
echo 'Diretório, variáveis e porta: OK'
REMOTE

say "3/6 — Construindo a imagem localmente"
"${DOCKER[@]}" build -t "devcore-monitor:$COMMIT" -t devcore-monitor:current .

say "4/6 — Enviando a imagem (docker save | ssh)"
"${DOCKER[@]}" save "devcore-monitor:$COMMIT" | gzip | ssh "$REMOTE_HOST" 'gunzip | sudo docker load'
scp -q docker-compose.prod.yml "$REMOTE_HOST:$REMOTE_DIR/docker-compose.prod.yml"

say "5/6 — Guardando a imagem anterior e recriando o contêiner"
ssh "$REMOTE_HOST" "REMOTE_DIR='$REMOTE_DIR' PROJECT='$PROJECT' CONTAINER='$CONTAINER' COMMIT='$COMMIT' bash -se" <<'REMOTE'
set -Eeuo pipefail
cd "$REMOTE_DIR"
if CURRENT_IMAGE="$(sudo docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null)"; then
  sudo docker tag "$CURRENT_IMAGE" devcore-monitor:rollback
  echo "Imagem anterior guardada como devcore-monitor:rollback"
fi
sudo docker tag "devcore-monitor:$COMMIT" devcore-monitor:current
sudo docker compose -p "$PROJECT" -f docker-compose.prod.yml up -d --force-recreate app
REMOTE

rollback() {
  echo 'FALHA NA VALIDAÇÃO: voltando para a imagem anterior...' >&2
  ssh "$REMOTE_HOST" "REMOTE_DIR='$REMOTE_DIR' PROJECT='$PROJECT' bash -se" <<'REMOTE'
set -Eeuo pipefail
cd "$REMOTE_DIR"
if sudo docker image inspect devcore-monitor:rollback >/dev/null 2>&1; then
  sudo docker tag devcore-monitor:rollback devcore-monitor:current
  sudo docker compose -p "$PROJECT" -f docker-compose.prod.yml up -d --force-recreate app
  echo 'Rollback concluído.'
else
  echo 'Primeiro deploy: não há imagem anterior. Contêiner parado.' >&2
  sudo docker compose -p "$PROJECT" -f docker-compose.prod.yml stop app
fi
REMOTE
}

say "6/6 — Health check (127.0.0.1:$PORT)"
HEALTH_OK=0
for attempt in {1..12}; do
  if ssh "$REMOTE_HOST" "CONTAINER='$CONTAINER' PORT='$PORT' COMMIT='$COMMIT' bash -se" <<'REMOTE'
set -Eeuo pipefail
H='Host: devcore.multicortex.com.br'
test "$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' -H "$H" "http://127.0.0.1:$PORT/entrar")" = 200
test "$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' -H "$H" "http://127.0.0.1:$PORT/")" = 307
curl -sSI --max-time 8 -H "$H" "http://127.0.0.1:$PORT/entrar" | grep -qi '^x-robots-tag: noindex, nofollow, noarchive'
# Ingestão viva: sem token responde 401 (não 404/5xx).
test "$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/devcore/ingest/devcore-demo-01")" = 401
test "$(sudo docker inspect "$CONTAINER" --format '{{.Image}}')" = "$(sudo docker image inspect "devcore-monitor:$COMMIT" --format '{{.Id}}')"
REMOTE
  then HEALTH_OK=1; break; fi
  echo "Aguardando o app: tentativa $attempt/12"; sleep 5
done
if [[ "$HEALTH_OK" != 1 ]]; then rollback; fail "O app não passou no health check."; fi

say "DEPLOY CONCLUÍDO — devcore-monitor:$COMMIT em 127.0.0.1:$PORT"
echo "As métricas ficam na memória: o painel mostra 'aguardando envio' por até 1 min."
