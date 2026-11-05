#!/usr/bin/env bash
# DevCore VM metrics agent — idempotent installer (openSUSE Leap 15.6).
#
#   sudo ./install.sh [--push-url https://site.multicortex.com.br/api/devcore/ingest/<vm-id>]
#                     [--server-name devcore01.multicortex.com.br] [--vhost FILE]
#                     [--allow-ip 52.207.145.100] [--rotate-token] [--no-capture]
#
# Token: DEVCORE_METRICS_TOKEN (env) > existing token > newly generated.
# A newly generated token is shown ONCE on this terminal; it is never logged.
# Does not touch llama.cpp nor the existing /v1 locations.
set -Eeuo pipefail

SERVER_NAME="devcore01.multicortex.com.br"
VHOST=""
ALLOW_IPS=()
ROTATE=0
PUSH_URL=""
CAPTURE=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LIB_DIR=/usr/local/lib/devcore-metrics
CONF_DIR=/etc/devcore-metrics
OUT_DIR=/srv/www/devcore-metrics
STATE_DIR=/var/lib/devcore-metrics
NGINX_SNIPPET_DIR=/etc/nginx/devcore-metrics
TOKEN_MAP=/etc/nginx/conf.d/devcore-metrics-token.conf
MARKER="# devcore-metrics"

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
fail() { echo "ERRO: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-name) SERVER_NAME="$2"; shift 2 ;;
    --vhost) VHOST="$2"; shift 2 ;;
    --allow-ip) ALLOW_IPS+=("$2"); shift 2 ;;
    --rotate-token) ROTATE=1; shift ;;
    --push-url) PUSH_URL="$2"; shift 2 ;;
    --no-capture) CAPTURE=0; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) fail "Opção desconhecida: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || fail "Execute com sudo."
for cmd in python3 nginx systemctl curl; do command -v "$cmd" >/dev/null || fail "Comando ausente: $cmd"; done
[[ -z "$PUSH_URL" || "$PUSH_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9/_.-]+$ ]] || fail "--push-url deve ser https://host/caminho"
if [[ $CAPTURE -eq 1 ]]; then command -v tcpdump >/dev/null || fail "tcpdump ausente (sudo zypper in tcpdump) ou use --no-capture."; fi
for ip in "${ALLOW_IPS[@]}"; do [[ "$ip" =~ ^[0-9a-fA-F:.]+(/[0-9]+)?$ ]] || fail "IP inválido: $ip"; done

if [[ -z "$VHOST" ]]; then
  mapfile -t CANDIDATES < <(grep -rlE "server_name[^;]*[[:space:]]${SERVER_NAME//./\\.}[[:space:];]" /etc/nginx 2>/dev/null \
    | grep -v -e '\.bak' -e "$NGINX_SNIPPET_DIR" || true)
  # The metrics location belongs to the HTTPS server (e.g. devcore01-ssl.conf),
  # never to the port-80 one.
  for candidate in "${CANDIDATES[@]}"; do
    if grep -qE '^[[:space:]]*listen[[:space:]][^;]*443' "$candidate"; then VHOST="$candidate"; break; fi
  done
  if [[ -z "$VHOST" && ${#CANDIDATES[@]} -eq 1 ]]; then VHOST="${CANDIDATES[0]}"; fi
  [[ -n "$VHOST" || ${#CANDIDATES[@]} -eq 0 ]] || fail "Vários vhosts para $SERVER_NAME e nenhum com listen 443: ${CANDIDATES[*]}. Use --vhost ARQUIVO."
fi
[[ -n "$VHOST" && -f "$VHOST" ]] || fail "vhost de $SERVER_NAME não encontrado. Use --vhost ARQUIVO."
echo "vhost: $VHOST"

say "1/6 — Token de acesso"
TOKEN="${DEVCORE_METRICS_TOKEN:-}"
NEW_TOKEN=0
if [[ -z "$TOKEN" && $ROTATE -eq 0 && -f "$TOKEN_MAP" ]]; then
  TOKEN="$(sed -n 's/^[[:space:]]*"~^Bearer \([A-Za-z0-9_-]*\)\$".*/\1/p' "$TOKEN_MAP" | head -n1)"
fi
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  NEW_TOKEN=1
fi
[[ "$TOKEN" =~ ^[A-Za-z0-9_-]{32,}$ ]] || fail "Token deve ter ao menos 32 caracteres [A-Za-z0-9_-]."

BACKUP_SUFFIX=".bak-devcore-metrics-$(date +%Y%m%d-%H%M%S)"
RESTORE=()
restore() {
  echo "Restaurando configuração nginx anterior..." >&2
  for item in "${RESTORE[@]}"; do
    src="${item%%|*}"; dst="${item##*|}"
    if [[ "$src" == "-" ]]; then rm -f "$dst"; else cp -p "$src" "$dst"; fi
  done
}

say "2/6 — Arquivos do agente"
install -d -m 0755 "$LIB_DIR" "$CONF_DIR" "$OUT_DIR" "$NGINX_SNIPPET_DIR"
install -d -m 0700 "$STATE_DIR"
install -m 0755 "$HERE/devcore_metrics_agent.py" "$LIB_DIR/devcore_metrics_agent.py"
[[ -f "$CONF_DIR/agent.conf" ]] || install -m 0644 "$HERE/agent.conf.example" "$CONF_DIR/agent.conf"
# Upgrade from 1.0: the old example pinned the nginx log only; add the capture log.
sed -i 's|^access_log_glob = /var/log/nginx/devcore01.access.log\*$|access_log_glob = /var/log/devcore-poc/requests-*.log*,/var/log/nginx/devcore01.access.log*|' "$CONF_DIR/agent.conf"
install -m 0644 "$HERE/devcore-metrics.service" /etc/systemd/system/devcore-metrics.service
install -m 0644 "$HERE/devcore-metrics.timer" /etc/systemd/system/devcore-metrics.timer
if [[ $CAPTURE -eq 1 ]]; then
  install -d -m 0755 /var/log/devcore-poc
  install -m 0755 "$HERE/devcore_http_capture.py" "$LIB_DIR/devcore_http_capture.py"
  install -m 0644 "$HERE/devcore-capture.service" /etc/systemd/system/devcore-capture.service
fi
# Push (outbound HTTPS to the site): same token as the nginx endpoint.
if [[ -n "$PUSH_URL" ]]; then
  printf '# Managed by install.sh\n[agent]\npush_url = %s\npush_token_file = %s/push.token\n' "$PUSH_URL" "$CONF_DIR" > "$CONF_DIR/push.conf"
  chmod 644 "$CONF_DIR/push.conf"
fi
if [[ -f "$CONF_DIR/push.conf" ]]; then
  ( umask 077; printf '%s\n' "$TOKEN" > "$CONF_DIR/push.token" )
  chmod 600 "$CONF_DIR/push.token"
fi

say "3/6 — Primeira geração do metrics.json (e envio ao site, se configurado)"
python3 -I "$LIB_DIR/devcore_metrics_agent.py" --config "$CONF_DIR/agent.conf"
test -s "$OUT_DIR/metrics.json"
if [[ -f "$CONF_DIR/push.conf" ]]; then
  echo "Envio: sem linha 'push:' acima = enviado. HTTP 401/404 = site ainda sem token/deploy (o timer tenta de novo a cada minuto)."
fi

say "4/6 — Configuração nginx (token + location)"
if [[ -f "$TOKEN_MAP" ]]; then cp -p "$TOKEN_MAP" "$TOKEN_MAP$BACKUP_SUFFIX"; RESTORE+=("$TOKEN_MAP$BACKUP_SUFFIX|$TOKEN_MAP"); else RESTORE+=("-|$TOKEN_MAP"); fi
# Anchored, case-sensitive regex key: a long literal key would overflow the
# default map_hash_bucket_size, and a regex entry is not hashed.
( umask 077
  printf '# Managed by devcore-vm-agent/install.sh — SECRET, keep mode 600.\nmap $http_authorization $devcore_metrics_authorized {\n    default 0;\n    "~^Bearer %s$" 1;\n}\n' "$TOKEN" > "$TOKEN_MAP.tmp"
  mv -f "$TOKEN_MAP.tmp" "$TOKEN_MAP" )
chown root:root "$TOKEN_MAP"; chmod 600 "$TOKEN_MAP"

LOCATION="$NGINX_SNIPPET_DIR/location.conf"
if [[ -f "$LOCATION" ]]; then cp -p "$LOCATION" "$LOCATION$BACKUP_SUFFIX"; RESTORE+=("$LOCATION$BACKUP_SUFFIX|$LOCATION"); else RESTORE+=("-|$LOCATION"); fi
ALLOW_LINE=""
if [[ ${#ALLOW_IPS[@]} -gt 0 ]]; then
  for ip in "${ALLOW_IPS[@]}"; do ALLOW_LINE+="allow $ip; "; done
  ALLOW_LINE+="deny all;"
fi
sed "s|#ALLOW_LINE#|$ALLOW_LINE|" "$HERE/nginx-location.conf" > "$LOCATION"
chmod 644 "$LOCATION"

if ! grep -qF "$MARKER" "$VHOST"; then
  cp -p "$VHOST" "$VHOST$BACKUP_SUFFIX"; RESTORE+=("$VHOST$BACKUP_SUFFIX|$VHOST")
  sed -i -E "/^[[:space:]]*server_name[^;]*[[:space:]]${SERVER_NAME//./\\.}[[:space:];]/a\\    include $LOCATION; $MARKER" "$VHOST"
  grep -qF "$MARKER" "$VHOST" || { restore; fail "Não consegui incluir o location no vhost."; }
fi

if ! NGINX_TEST="$(nginx -t 2>&1)"; then
  echo "$NGINX_TEST" >&2
  restore
  fail "nginx -t falhou; configuração anterior restaurada."
fi
# The map must be in the http context (conf.d/*.conf). Check without printing secrets.
if ! nginx -T 2>/dev/null | grep -q 'devcore_metrics_authorized {'; then
  restore
  fail "$TOKEN_MAP não é incluído pelo nginx.conf (contexto http). Configuração restaurada."
fi
systemctl reload nginx

say "5/6 — Timer systemd"
systemctl daemon-reload
systemctl enable --now devcore-metrics.timer
systemctl start devcore-metrics.service
if [[ $CAPTURE -eq 1 ]]; then
  systemctl enable devcore-capture.service
  systemctl restart devcore-capture.service   # picks up a new version on reinstall
  sleep 2
  if systemctl is-active --quiet devcore-capture.service; then echo "Captura passiva: ativa"
  else echo "AVISO: captura passiva não iniciou (journalctl -u devcore-capture)"; fi
fi

say "6/6 — Verificação local"
sleep 2  # nginx reload is asynchronous
HEADER_FILE="$(mktemp)"; trap 'rm -f "$HEADER_FILE"' EXIT
chmod 600 "$HEADER_FILE"
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$HEADER_FILE"
URL="https://$SERVER_NAME/poc/metrics.json"
RESOLVE=(--resolve "$SERVER_NAME:443:127.0.0.1")
NO_TOKEN="$(curl -sk "${RESOLVE[@]}" -o /dev/null -w '%{http_code}' "$URL")"
WITH_TOKEN="$(curl -sk "${RESOLVE[@]}" -H @"$HEADER_FILE" -o /dev/null -w '%{http_code}' "$URL")"
echo "Sem token: $NO_TOKEN (esperado 401) · Com token: $WITH_TOKEN (esperado 200; 403 se --allow-ip não incluir 127.0.0.1)"
if [[ "$NO_TOKEN" != 401 ]]; then
  restore
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  fail "Endpoint sem token retornou $NO_TOKEN (esperado 401). Configuração nginx anterior restaurada; confira --vhost."
fi

if [[ $NEW_TOKEN -eq 1 ]]; then
  cat <<EOF

================================================================
TOKEN GERADO (exibido somente agora). Guarde no servidor do site:
  DEVCORE_METRICS_TOKEN_<ID_DA_VM>=$TOKEN
================================================================
EOF
fi
say "Instalação concluída. Remoção: sudo $HERE/uninstall.sh [--purge]"
