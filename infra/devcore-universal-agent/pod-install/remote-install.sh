#!/bin/bash
# Executado DENTRO da POD (root) por scripts/instalar-agente-pod.sh.
# Recebe em /tmp/mc-install/: kit.zip, kit.sha256 e bootstrap (0600). Idempotente:
# rodar de novo atualiza o código e reinicia o agente mantendo identidade e aprovação.
set -u
umask 077
WORK=/tmp/mc-install
DEST=/opt/multicortex/devcore-universal-agent
START=/opt/multicortex/start-agent.sh
TOKEN_FILE=/root/.multicortex-bootstrap
MONITOR_URL=${MULTICORTEX_MONITOR_URL:-https://devcore.multicortex.com.br/agenttrack}
say() { echo "[mc] $*"; }
fail() { echo "[mc] ERRO: $*"; rm -rf "$WORK"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

[ "$(id -u)" = 0 ] || fail "é preciso entrar na POD como root"
POD="${RUNPOD_POD_ID:-}"
case "$POD" in ''|*[!A-Za-z0-9_-]*) fail "RUNPOD_POD_ID ausente ou inválido: esta máquina não parece uma POD RunPod" ;; esac
say "POD $POD ($(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-Linux}"))"

# 1. Dependências
missing=""
command -v python3 >/dev/null 2>&1 || missing="$missing python3"
command -v tcpdump >/dev/null 2>&1 || [ -x /usr/sbin/tcpdump ] || missing="$missing tcpdump"
if [ -n "$missing" ]; then
  say "Instalando:$missing"
  if command -v zypper >/dev/null 2>&1; then zypper -n in --no-recommends $missing ca-certificates >/tmp/mc-deps.log 2>&1
  elif command -v apt-get >/dev/null 2>&1; then { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $missing ca-certificates; } >/tmp/mc-deps.log 2>&1
  elif command -v dnf >/dev/null 2>&1; then dnf -y install $missing ca-certificates >/tmp/mc-deps.log 2>&1
  elif command -v yum >/dev/null 2>&1; then yum -y install $missing ca-certificates >/tmp/mc-deps.log 2>&1
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache $missing ca-certificates >/tmp/mc-deps.log 2>&1
  else fail "gerenciador de pacotes desconhecido; instale$missing"; fi || fail "falha ao instalar$missing (ver /tmp/mc-deps.log)"
fi
python3 -c 'import sys; sys.exit(sys.version_info < (3, 6))' || fail "Python 3.6+ necessário"
say "Python $(python3 -c 'import platform; print(platform.python_version())') e tcpdump OK"

# 2. Código do agente (valida hash do pacote e de cada arquivo)
[ "$(sha256sum "$WORK/kit.zip" | cut -d' ' -f1)" = "$(cat "$WORK/kit.sha256")" ] || fail "pacote corrompido na transferência"
python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$WORK/kit.zip" "$WORK/kit" || fail "não foi possível abrir o pacote"
KIT=$(ls -d "$WORK"/kit/devcore-universal-agent-template-* 2>/dev/null | head -n1)
[ -n "$KIT" ] || fail "pacote sem diretório do kit"
export MULTICORTEX_AGENT_STATE_DIR="$( [ -d /workspace ] && echo /workspace || echo /root )/devcore-agent-state/$POD"
SERVICE="$DEST/agent_service.py"
same=0
if [ -d "$DEST" ]; then
  python3 -I - "$KIT/MANIFEST.json" "$DEST" <<'PY' && same=1
import hashlib, json, os, sys
manifest = json.load(open(sys.argv[1]))["sha256"]
for name, digest in manifest.items():
    path = os.path.join(sys.argv[2], name)
    if not os.path.isfile(path) or hashlib.sha256(open(path, "rb").read()).hexdigest() != digest:
        sys.exit(1)
PY
fi
if [ "$same" = 1 ]; then
  say "Agente já está na versão do pacote"
else
  rm -rf "$DEST.new"
  python3 -I "$KIT/install.py" --install-dir "$DEST.new" >/dev/null || fail "instalador recusou o pacote"
  if [ -d "$DEST" ]; then
    python3 "$SERVICE" stop >/dev/null 2>&1
    for _ in $(seq 1 20); do python3 "$SERVICE" status 2>/dev/null | grep -q "Em execução" || break; sleep 1; done
    mv "$DEST" "$DEST.bak-$(date -u +%Y%m%d%H%M%S)"
  fi
  mv "$DEST.new" "$DEST"
  say "Agente $(python3 -c "import sys; sys.path.insert(0, '$DEST'); import discovery; print(discovery.AGENT_VERSION)") instalado em $DEST"
fi

# 3. Token de inscrição e script de início (rodar de novo após reiniciar a POD)
install -m 600 "$WORK/bootstrap" "$TOKEN_FILE"
cat > "$START" <<EOF
#!/bin/sh
# MultiCortex DevCore Monitor: inicia o agente desta POD. Rodar após cada reinício da POD.
export MULTICORTEX_MONITOR_URL=$MONITOR_URL
export MULTICORTEX_BOOTSTRAP_TOKEN_FILE=$TOKEN_FILE
export MULTICORTEX_AGENT_STATE_DIR=$MULTICORTEX_AGENT_STATE_DIR
# Opcional: hosts DevCore explícitos (senão: <POD>-<porta>.proxy.runpod.net).
[ -s /root/.multicortex-hosts ] && { MULTICORTEX_DEVCORE_HOSTS=\$(head -n1 /root/.multicortex-hosts); export MULTICORTEX_DEVCORE_HOSTS; }
exec python3 $DEST/template_boot.py
EOF
chmod 700 "$START"

# 4. (Re)iniciar
python3 "$SERVICE" status 2>/dev/null | grep -q "Em execução" && {
  python3 "$SERVICE" stop >/dev/null 2>&1
  for _ in $(seq 1 20); do python3 "$SERVICE" status 2>/dev/null | grep -q "Em execução" || break; sleep 1; done
}
LOG="$MULTICORTEX_AGENT_STATE_DIR/agent.log"
before=$(cat "$LOG" 2>/dev/null | wc -l)
sh "$START" >/dev/null 2>&1 || fail "agente não iniciou; ver $MULTICORTEX_AGENT_STATE_DIR/agent.log"
state=""
for _ in $(seq 1 20); do
  sleep 1
  state=$(tail -n +$((before + 1)) "$LOG" 2>/dev/null | grep -a -o -E "Estado: [a-z]+|Telemetria enviada" | tail -n1)
  [ -n "$state" ] && break
done
python3 "$SERVICE" status 2>/dev/null | grep -q "Em execução" || fail "agente parou; ver $MULTICORTEX_AGENT_STATE_DIR/agent.log"
say "AGENT_ID=$(cat "$MULTICORTEX_AGENT_STATE_DIR/agent-id" 2>/dev/null)"
case "$state" in
  "Telemetria enviada"|"Estado: approved") say "STATUS=aprovado" ;;
  "Estado: pending") say "STATUS=aguardando-aprovacao" ;;
  *) say "STATUS=${state:-iniciando}" ;;
esac
say "OK"
