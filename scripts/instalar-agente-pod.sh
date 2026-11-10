#!/usr/bin/env bash
# Instala (ou atualiza) o agente DevCore Monitor numa POD RunPod com um único comando.
#
# Uso — cole o SSH que o administrador da infra passou, depois do nome do script:
#   scripts/instalar-agente-pod.sh ssh 4vtw3ny63c0ucm-64411d48@ssh.runpod.io -i ~/.ssh/id_ed25519
#
# O que faz: instala python3/tcpdump na POD, envia o pacote do agente (hash conferido),
# grava o token de inscrição (lido do EC2 sem aparecer na tela) e inicia o agente.
# Depois é só autorizar a POD no painel. Rodar de novo é seguro: atualiza e reinicia
# mantendo identidade e aprovação. Após reiniciar a POD: rode este comando de novo.
#
# Variáveis opcionais:
#   MULTICORTEX_BOOTSTRAP_FILE  arquivo local (0600) com o token, em vez de ler do EC2
#   MULTICORTEX_EC2             acesso SSH ao EC2 (padrão ec2-user@52.207.145.100)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
KIT="$ROOT/artifacts/devcore-universal-agent-template-v3.zip"
REMOTE="$ROOT/infra/devcore-universal-agent/pod-install/remote-install.sh"
EC2="${MULTICORTEX_EC2:-ec2-user@52.207.145.100}"
ENV_RELEASE=/opt/multicortex/devcore-agenttrack/.env.release
PANEL=https://devcore.multicortex.com.br
W=/tmp/mc-install

say() { printf '%s\n' "$*"; }
fail() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

# SSH da POD: aceita colado com ou sem aspas e com ou sem a palavra "ssh".
if [ $# -eq 1 ]; then read -r -a ARGS <<<"$1"; else ARGS=("$@"); fi
[ ${#ARGS[@]} -gt 0 ] && [ "${ARGS[0]}" = ssh ] && ARGS=("${ARGS[@]:1}")
[ ${#ARGS[@]} -gt 0 ] || { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
for i in "${!ARGS[@]}"; do case "${ARGS[$i]}" in "~/"*) ARGS[$i]="$HOME/${ARGS[$i]#\~/}" ;; esac; done

[ -f "$KIT" ] && [ -f "$KIT.sha256" ] && [ -f "$REMOTE" ] || fail "pacote do agente ausente; rode: python3 scripts/package-universal-agent.py"
SHA=$(cut -d' ' -f1 "$KIT.sha256")
[ "$(sha256sum "$KIT" | cut -d' ' -f1)" = "$SHA" ] || fail "pacote $KIT não confere com o .sha256"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; umask 077
say "1/3 Obtendo o token de inscrição (não é exibido)…"
if [ -n "${MULTICORTEX_BOOTSTRAP_FILE:-}" ]; then
  tr -d '"\r\n ' <"$MULTICORTEX_BOOTSTRAP_FILE" >"$TMP/bootstrap"
else
  ssh -o ConnectTimeout=15 "$EC2" "sudo sed -n 's/^DEVCORE_BOOTSTRAP_TOKEN=//p' $ENV_RELEASE" | tr -d '"\r\n ' >"$TMP/bootstrap" \
    || fail "não consegui ler o token no EC2 ($EC2)"
fi
grep -qE '^[a-f0-9]{64}$' "$TMP/bootstrap" || fail "token de inscrição em formato inesperado"

# Arquivo -> linhas "echo <base64> >> destino" (o proxy SSH da RunPod não tem scp).
send() {
  printf 'rm -f %s/%s.b64\n' "$W" "$1"
  base64 -w 76 "$2" | sed "s|^|echo |; s|\$| >> $W/$1.b64|"
  printf 'base64 -d %s/%s.b64 > %s/%s && rm -f %s/%s.b64\n' "$W" "$1" "$W" "$1" "$W" "$1"
}

say "2/3 Conectando na POD e instalando (1–3 min)…"
{
  printf 'stty -echo 2>/dev/null; umask 077; rm -rf %s; mkdir -p %s\n' "$W" "$W"
  sleep 5
  send kit.zip "$KIT"
  printf 'echo %s > %s/kit.sha256\n' "$SHA" "$W"
  send bootstrap "$TMP/bootstrap"
  send remote-install.sh "$REMOTE"
  printf 'bash %s/remote-install.sh; stty echo 2>/dev/null; exit\n' "$W"
} | ssh -tt -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 "${ARGS[@]}" 2>&1 \
  | tr -d '\r' | grep --line-buffered -a -o '\[mc\] .*' | tee "$TMP/out" | sed -u 's/^\[mc\] /    /' || true

grep -q '^\[mc\] OK$' "$TMP/out" || fail "a instalação não terminou; veja as mensagens acima"
AGENT=$(sed -n 's/^\[mc\] AGENT_ID=//p' "$TMP/out")
STATUS=$(sed -n 's/^\[mc\] STATUS=//p' "$TMP/out")
say "3/3 Pronto. Agente $AGENT"
if [ "$STATUS" = aguardando-aprovacao ]; then
  say "    Falta autorizar: $PANEL → POC → PODs e autorizações → vincular e Autorizar monitoramento."
else
  say "    Status: $STATUS"
fi
