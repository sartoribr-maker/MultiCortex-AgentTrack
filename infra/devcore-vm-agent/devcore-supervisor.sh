#!/usr/bin/env bash
# DevCore metrics without systemd (containers such as a RunPod pod): keeps the
# passive capture running and runs the metrics agent once a minute.
# Started by install-pod.sh with setsid; stop with: install-pod.sh --stop
LIB_DIR=/usr/local/lib/devcore-metrics
CONF=/etc/devcore-metrics/agent.conf
LOG=/var/log/devcore-poc/supervisor.log

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

capture_loop() {
  while true; do
    nice -n 5 python3 -I "$LIB_DIR/devcore_http_capture.py" --config "$CONF"
    echo "$(stamp) captura terminou (código $?); reinicia em 5 s"
    sleep 5
  done
}

agent_loop() {
  while true; do
    sleep $((60 - $(date +%s) % 60))
    nice -n 10 timeout 50 python3 -I "$LIB_DIR/devcore_metrics_agent.py" --config "$CONF" 2>&1 | sed "s/^/$(stamp) /"
    # Only status lines land here, but keep the file small anyway.
    if [[ $(stat -c %s "$LOG" 2>/dev/null || echo 0) -gt 1048576 ]]; then : > "$LOG"; fi
  done
}

echo "$(stamp) supervisor iniciado (pid $$)"
capture_loop 2>&1 &
agent_loop &
trap 'kill 0' TERM INT
wait
