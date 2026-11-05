#!/usr/bin/env bash
# DevCore VM metrics agent — removal.
#
#   sudo ./uninstall.sh [--purge]
#
# Removes the timer, the capture service, nginx location/token and the agent code.
# --purge also removes metrics.json, history, agent.conf, push token and request logs.
set -Eeuo pipefail

PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1
[[ $EUID -eq 0 ]] || { echo "ERRO: execute com sudo." >&2; exit 1; }

MARKER="# devcore-metrics"
TOKEN_MAP=/etc/nginx/conf.d/devcore-metrics-token.conf
SUFFIX=".bak-devcore-metrics-uninstall-$(date +%Y%m%d-%H%M%S)"

systemctl disable --now devcore-metrics.timer devcore-capture.service 2>/dev/null || true
systemctl stop devcore-metrics.service 2>/dev/null || true
rm -f /etc/systemd/system/devcore-metrics.timer /etc/systemd/system/devcore-metrics.service \
  /etc/systemd/system/devcore-capture.service
systemctl daemon-reload

# Remove the include line from every vhost that has it (with backup).
while IFS= read -r vhost; do
  cp -p "$vhost" "$vhost$SUFFIX"
  sed -i "\|$MARKER\$|d" "$vhost"
  echo "Include removido de $vhost (backup: $vhost$SUFFIX)"
done < <(grep -rlF "$MARKER" /etc/nginx 2>/dev/null | grep -v '\.bak' || true)

rm -rf /etc/nginx/devcore-metrics
rm -f "$TOKEN_MAP" "$TOKEN_MAP".bak-devcore-metrics-*

if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
else
  nginx -t || true
  echo "ERRO: nginx -t falhou após a remoção; revise os backups *$SUFFIX." >&2
  exit 1
fi

rm -rf /usr/local/lib/devcore-metrics
if [[ $PURGE -eq 1 ]]; then
  rm -rf /srv/www/devcore-metrics /var/lib/devcore-metrics /etc/devcore-metrics
  # Only our request logs; samples.csv belongs to the existing POC monitoring.
  rm -f /var/log/devcore-poc/requests-*.log
  echo "Dados, histórico e configuração removidos."
else
  echo "Mantidos: /srv/www/devcore-metrics, /var/lib/devcore-metrics, /etc/devcore-metrics (use --purge)."
fi
echo "Agente removido. llama.cpp e as rotas /v1 não foram alterados."
