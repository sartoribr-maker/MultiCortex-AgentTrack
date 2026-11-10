#!/usr/bin/env python3
"""Initialize one POD's runtime configuration, then start its detached agent.

Never run this during image build. Python 3.6+, standard library only.
"""
import json
import os
import re
import sys
import tempfile


def select_state(environ):
    pod_id = environ.get("RUNPOD_POD_ID", "").strip()
    if pod_id and not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", pod_id):
        raise RuntimeError("RUNPOD_POD_ID inválido")
    explicit = environ.get("MULTICORTEX_AGENT_STATE_DIR", "")
    if not explicit and not pod_id:
        raise RuntimeError("Informe RUNPOD_POD_ID ou um diretório de estado exclusivo")
    # /workspace is the RunPod persistent volume; PODs without it keep state under /root.
    base = "/workspace" if os.path.isdir("/workspace") else "/root"
    state = explicit or os.path.join(base, "devcore-agent-state", pod_id)
    if not os.path.isabs(state):
        raise RuntimeError("Diretório de estado deve ser absoluto")
    state = os.path.normpath(state)
    if state == "/":
        raise RuntimeError("Diretório de estado inválido")
    current = state
    while current != "/":
        if os.path.islink(current):
            raise RuntimeError("Link simbólico no caminho de estado")
        current = os.path.dirname(current)
    return state, pod_id


def claim_state(state, pod_id):
    path = os.path.join(state, "template-owner.json")
    if os.path.lexists(path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as handle:
            if os.fstat(handle.fileno()).st_mode & 0o077:
                raise RuntimeError("Permissões inseguras no marcador da POD")
            owner = json.load(handle)
        if owner != {"pod_id": pod_id}:
            raise RuntimeError("Estado pertence a outra POD; não reutilizar identidade clonada")
        return
    # Existing installations must be migrated deliberately, never claimed implicitly.
    protected = ("agent-id", "enrollment-key", "operational-token", "service-config.json", "credential-generation", "credential-attempted", "telemetry-auth-blocked")
    if any(os.path.lexists(os.path.join(state, name)) for name in protected):
        raise RuntimeError("Estado preexistente sem marcador; migração administrativa necessária")
    fd, temporary = tempfile.mkstemp(prefix=".template-owner-", dir=state)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump({"pod_id": pod_id}, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, path)
        directory = os.open(state, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(temporary)


def runtime_token(environ):
    token = environ.get("MULTICORTEX_BOOTSTRAP_TOKEN", "")
    secret_file = environ.get("MULTICORTEX_BOOTSTRAP_TOKEN_FILE", "")
    if token and secret_file:
        raise RuntimeError("Use somente uma origem para o bootstrap")
    if secret_file:
        fd = os.open(secret_file, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as handle:
            if os.fstat(handle.fileno()).st_mode & 0o077:
                raise RuntimeError("Arquivo de bootstrap exige permissão 0600")
            token = handle.read().strip()
    if token and not re.fullmatch(r"[a-f0-9]{64}", token):
        raise RuntimeError("Formato de bootstrap inválido")
    return token


def start():
    state, pod_id = select_state(os.environ)
    os.environ["MULTICORTEX_AGENT_STATE_DIR"] = state
    # Import after selecting state: agent_service resolves it at module load time.
    import agent_service as service
    service.prepare_state()
    claim_state(state, pod_id)
    token = runtime_token(os.environ)
    url = os.environ.get("MULTICORTEX_MONITOR_URL", "").rstrip("/")
    config_path = os.path.join(state, "service-config.json")
    if not os.path.lexists(config_path):
        if not url or not token:
            raise RuntimeError("Primeiro boot exige URL HTTPS e bootstrap em runtime")
        os.environ["MULTICORTEX_BOOTSTRAP_TOKEN"] = token
        service.configure()
    else:
        config = service.load_config()
        if ((url and url != config["monitor_url"])
                or (token and token != config["bootstrap_token"])):
            raise RuntimeError("Configuração diverge do estado persistido; revisar administrativamente")
    # Reuse service CLI so all locking, logging and PID checks have one owner.
    import subprocess
    subprocess.check_call([sys.executable, os.path.join(os.path.dirname(__file__),
                                                      "agent_service.py"), "start"])


if __name__ == "__main__":
    try:
        os.umask(0o077)
        start()
    except Exception:
        # Never print exception strings: they may contain credentials.
        print("[multicortex] Agente não iniciou: verificar runtime, bootstrap e estado exclusivo da POD", file=sys.stderr)
        sys.exit(1)
