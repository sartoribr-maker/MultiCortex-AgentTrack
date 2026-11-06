#!/bin/sh
# Run the agent alongside the template's ORIGINAL command; never replace it.
# Do not enable shell tracing: runtime environment can contain a bootstrap secret.
AGENT_HOME=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
if [ "$#" -eq 0 ]; then
    echo '[multicortex] Informe o entrypoint/comando original do template.' >&2
    exit 2
fi
if ! python3 "$AGENT_HOME/template_boot.py"; then
    echo '[multicortex] Monitoramento indisponível; confira configuração. Iniciando comando original.' >&2
fi
# Avoid passing enrollment bootstrap to the model server through this wrapper.
unset MULTICORTEX_BOOTSTRAP_TOKEN MULTICORTEX_BOOTSTRAP_TOKEN_FILE
exec "$@"
