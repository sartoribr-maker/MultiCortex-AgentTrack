#!/usr/bin/env bash
# DevCore metrics agent for a container without systemd or nginx (RunPod pod).
#
#   ./install-pod.sh --push-url https://site.multicortex.com.br/api/devcore/ingest/<vm-id>
#                    [--slots N] [--host EXTRA_DEVCORE_HOST]... [--rotate-token]
#   ./install-pod.sh --stop
#
# Token: DEVCORE_METRICS_TOKEN (env) > existing push.token > newly generated.
# A newly generated token is shown ONCE on this terminal; it is never logged.
# Slots default to the --parallel of the running llama.cpp server. Does not
# touch llama.cpp. The container disk is reset with the pod: run it again then.
set -Eeuo pipefail

PUSH_URL=""
SLOTS=""
HOSTS=(devcore01.multicortex.com.br)
ROTATE=0
STOP=0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LIB_DIR=/usr/local/lib/devcore-metrics
CONF_DIR=/etc/devcore-metrics
OUT_DIR=/srv/www/devcore-metrics
STATE_DIR=/var/lib/devcore-metrics
LOG_DIR=/var/log/devcore-poc
PID_FILE=/run/devcore-metrics.pid

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
fail() { echo "ERRO: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --push-url) PUSH_URL="$2"; shift 2 ;;
    --slots) SLOTS="$2"; shift 2 ;;
    --host) HOSTS+=("$2"); shift 2 ;;
    --rotate-token) ROTATE=1; shift ;;
    --stop) STOP=1; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) fail "Opção desconhecida: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || fail "Execute como root."
# The RunPod proxy replaces X-Forwarded-Host: traffic via devcore01 arrives with
# the pod's proxy host.
[[ -n "${RUNPOD_POD_ID:-}" ]] && HOSTS+=("${RUNPOD_POD_ID}-7080.proxy.runpod.net")

stop_supervisor() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill -TERM -- "-$(cat "$PID_FILE")" 2>/dev/null || true   # whole group: loops, agent, tcpdump
    sleep 2
  fi
  rm -f "$PID_FILE"
}

if [[ $STOP -eq 1 ]]; then stop_supervisor; echo "Coleta parada."; exit 0; fi

[[ "$PUSH_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9/_.-]+$ ]] || fail "--push-url https://host/caminho é obrigatório"
for host in "${HOSTS[@]}"; do [[ "$host" =~ ^[A-Za-z0-9.-]+$ ]] || fail "Host inválido: $host"; done

say "1/5 — Pacotes"
missing=()
command -v python3 >/dev/null || missing+=(python3)
command -v tcpdump >/dev/null || missing+=(tcpdump)
command -v curl >/dev/null || missing+=(curl)
if [[ ${#missing[@]} -gt 0 ]]; then
  command -v zypper >/dev/null || fail "Instale: ${missing[*]}"
  zypper -n --no-refresh in --no-recommends "${missing[@]}" >/dev/null
fi
command -v nvidia-smi >/dev/null || echo "AVISO: nvidia-smi ausente; o painel mostra a GPU como —"

if [[ -z "$SLOTS" ]]; then
  # Last --parallel of the running llama.cpp server (port 7080).
  for pid in $(ls /proc | grep -E '^[0-9]+$'); do
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    if [[ "$cmd" == *"--port 7080"* && "$cmd" == *"--parallel "* ]]; then
      SLOTS="$(grep -oE -- '--parallel [0-9]+' <<<"$cmd" | tail -n1 | awk '{print $2}')"
      break
    fi
  done
fi
[[ "$SLOTS" =~ ^[1-9][0-9]*$ ]] || fail "Não identifiquei os slots do llama.cpp. Use --slots N."
echo "slots: $SLOTS · hosts DevCore: ${HOSTS[*]}"

say "2/5 — Arquivos do agente"
install -d -m 0755 "$LIB_DIR" "$CONF_DIR" "$OUT_DIR" "$LOG_DIR"
install -d -m 0700 "$STATE_DIR"
install -m 0755 "$HERE/devcore_metrics_agent.py" "$HERE/devcore_http_capture.py" "$HERE/devcore-supervisor.sh" "$LIB_DIR/"
host_list="$(IFS=,; echo "${HOSTS[*]}")"
if [[ ! -f "$CONF_DIR/agent.conf" ]]; then
  # No nginx (capture log only), no systemd journal, and the capture writes the
  # GPU samples (no POC sampler in the container).
  sed -e "s|^access_log_glob = .*|access_log_glob = $LOG_DIR/requests-*.log*|" \
      -e "s|^devcore_hosts = .*|devcore_hosts = $host_list|" \
      -e "s|^slots = .*|slots = $SLOTS|" \
      -e "s|^server_unit = .*|server_unit =|" \
      -e "s|^live_output = .*|&\nwrite_samples = true|" \
      "$HERE/agent.conf.example" > "$CONF_DIR/agent.conf"
  chmod 644 "$CONF_DIR/agent.conf"
else
  sed -i -e "s|^slots = .*|slots = $SLOTS|" -e "s|^devcore_hosts = .*|devcore_hosts = $host_list|" "$CONF_DIR/agent.conf"
fi
printf '# Managed by install-pod.sh\n[agent]\npush_url = %s\npush_token_file = %s/push.token\n' "$PUSH_URL" "$CONF_DIR" > "$CONF_DIR/push.conf"
chmod 644 "$CONF_DIR/push.conf"

say "3/5 — Token de acesso"
TOKEN="${DEVCORE_METRICS_TOKEN:-}"
NEW_TOKEN=0
if [[ -z "$TOKEN" && $ROTATE -eq 0 && -s "$CONF_DIR/push.token" ]]; then TOKEN="$(cat "$CONF_DIR/push.token")"; fi
if [[ -z "$TOKEN" ]]; then TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"; NEW_TOKEN=1; fi
[[ "$TOKEN" =~ ^[A-Za-z0-9_-]{32,}$ ]] || fail "Token deve ter ao menos 32 caracteres [A-Za-z0-9_-]."
( umask 077; printf '%s\n' "$TOKEN" > "$CONF_DIR/push.token" )
chmod 600 "$CONF_DIR/push.token"

say "4/5 — Primeira geração do metrics.json e envio ao site"
python3 -I "$LIB_DIR/devcore_metrics_agent.py" --config "$CONF_DIR/agent.conf"
test -s "$OUT_DIR/metrics.json"
echo "Envio: sem linha 'push:' acima = enviado. HTTP 401 = o site ainda não tem este token."

say "5/5 — Captura passiva e agente (supervisor, sem systemd)"
stop_supervisor
setsid nohup "$LIB_DIR/devcore-supervisor.sh" >> "$LOG_DIR/supervisor.log" 2>&1 < /dev/null &
echo $! > "$PID_FILE"
sleep 3
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null && pgrep -f devcore_http_capture.py >/dev/null; then
  echo "Supervisor ativo (pid $(cat "$PID_FILE")). Log: $LOG_DIR/supervisor.log"
else
  tail -n 20 "$LOG_DIR/supervisor.log" >&2
  fail "A captura não iniciou."
fi

if [[ $NEW_TOKEN -eq 1 ]]; then
  cat <<EOF

================================================================
TOKEN GERADO (exibido somente agora). Guarde no servidor do site:
  DEVCORE_METRICS_TOKEN_<ID_DA_VM>=$TOKEN
================================================================
EOF
fi
say "Instalação concluída. Parar: $0 --stop"
