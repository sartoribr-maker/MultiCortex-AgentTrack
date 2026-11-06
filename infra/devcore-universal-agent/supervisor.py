#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MultiCortex Universal Agent supervisor.

Python 3.6+; standard library only.
Enrollment protocol v1 (local development).
"""

import json
import secrets
import os
import signal
import sys
import threading
import urllib.error
import urllib.request

from discovery import discover
from fallback_monitor import collect_fallback
from operational_collector import collect_operational, suspend_operational


BASE_URL = os.environ.get("MULTICORTEX_MONITOR_URL", "").rstrip("/")
BOOTSTRAP_TOKEN = os.environ.get("MULTICORTEX_BOOTSTRAP_TOKEN", "")
STATE_DIR = os.environ.get(
    "MULTICORTEX_AGENT_STATE_DIR", "/var/lib/multicortex-agent"
)
POLL_SECONDS = 30
RUNNING = True
STOP_EVENT = threading.Event()
TRANSIENT_HTTP = (408, 429, 500, 502, 503, 504)


class Stopped(Exception):
    pass


class ProtocolError(Exception):
    pass


def wait_interruptibly(seconds):
    STOP_EVENT.wait(seconds)
    if not RUNNING:
        raise Stopped()


def stop_handler(_signum, _frame):
    global RUNNING
    RUNNING = False
    STOP_EVENT.set()
    suspend_operational()



def api_request(path, payload=None, token=None, enrollment_key=None):
    if not BASE_URL.startswith("https://"):
        raise RuntimeError("Monitor Central exige HTTPS")

    headers = {"Accept": "application/json"}

    if token:
        headers["Authorization"] = "Bearer " + token

    if enrollment_key:
        headers["X-Agent-Enrollment-Key"] = enrollment_key

    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(
        BASE_URL + path, data=data, headers=headers
    )

    # Enrollment is idempotent for the same UUID/key. Other POSTs are not.
    delays = (1, 2, 4) if payload is None or path.endswith("/enroll") else ()

    for attempt in range(len(delays) + 1):
        if not RUNNING:
            raise Stopped()
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                body = response.read()
                return json.loads(body.decode("utf-8")) if body else {}

        except urllib.error.HTTPError as error:
            if error.code not in TRANSIENT_HTTP:
                raise

            if attempt == len(delays):
                raise

            print(
                "[multicortex] HTTP temporário:",
                error.code,
                "tentativa:",
                attempt + 1,
                flush=True
            )

        except (urllib.error.URLError, OSError) as error:
            if attempt == len(delays):
                raise

            print(
                "[multicortex] Comunicação indisponível; nova tentativa",
                attempt + 2,
                flush=True
            )

        wait_interruptibly(delays[attempt])




def read_operational_token(state_dir):
    path = os.path.join(state_dir, "operational-token")

    if os.path.islink(path):
        raise RuntimeError("Link simbólico não permitido")

    if not os.path.exists(path):
        return None

    mode = os.stat(path).st_mode & 0o777

    if mode & 0o077:
        raise RuntimeError("Permissões inseguras na credencial")

    with open(path, "r") as handle:
        token = handle.read().strip()

    if len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
        raise RuntimeError("Formato de credencial inválido")

    return token


def save_operational_token(state_dir, token):
    if not isinstance(token, str):
        raise RuntimeError("Credencial inválida")

    if len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
        raise RuntimeError("Formato de credencial inválido")

    os.makedirs(state_dir, mode=0o700, exist_ok=True)

    path = os.path.join(state_dir, "operational-token")

    if os.path.islink(path):
        raise RuntimeError("Link simbólico não permitido")

    temporary = path + ".tmp-" + secrets.token_hex(8)

    fd = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600
    )

    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(token)
            handle.flush()
            os.fsync(handle.fileno())

        os.replace(temporary, path)

        directory_fd = os.open(state_dir, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def delete_operational_token(state_dir):
    path = os.path.join(state_dir, "operational-token")

    if os.path.islink(path):
        raise RuntimeError("Link simbólico não permitido")

    try:
        os.unlink(path)
    except FileNotFoundError:
        pass







def main():
    if not RUNNING:
        return
    if not BASE_URL.startswith("https://"):
        raise RuntimeError("Monitor Central exige HTTPS")
    if not BOOTSTRAP_TOKEN:
        raise RuntimeError("Bootstrap token não configurado")

    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)

    if os.path.islink(STATE_DIR):
        raise RuntimeError("Diretório de estado não pode ser link simbólico")

    os.chmod(STATE_DIR, 0o700)

    identity = discover(STATE_DIR)

    key_path = os.path.join(STATE_DIR, "enrollment-key")

    if not os.path.exists(key_path):
        fd = os.open(
            key_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600
        )
        with os.fdopen(fd, "w") as handle:
            handle.write(secrets.token_hex(32))

    if os.path.islink(key_path):
        raise RuntimeError("Chave de inscrição não pode ser link simbólico")

    key_mode = os.stat(key_path).st_mode & 0o777

    if key_mode & 0o077:
        raise RuntimeError("Permissões inseguras na chave de inscrição")

    with open(key_path) as handle:
        enrollment_key = handle.read().strip()

    if len(enrollment_key) != 64 or any(
        c not in "0123456789abcdef" for c in enrollment_key
    ):
        raise RuntimeError("Formato inválido da chave de inscrição")

    identity["enrollment_key"] = enrollment_key
    agent_id = identity["agent_id"]

    print("[multicortex] Agent:", agent_id, flush=True)

    operational_token = read_operational_token(STATE_DIR)
    run_supervisor(identity, enrollment_key, operational_token)


def checked_status(response):
    if not isinstance(response, dict):
        raise ProtocolError()
    state = response.get("status")
    if state not in ("pending", "approved", "revoked"):
        raise ProtocolError()
    return state


def mark_credential_attempt(path):
    # Durable intent: a lost response must not cause a second issuance on restart.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write("administrative recovery required\n")
        handle.flush()
        os.fsync(handle.fileno())
    directory_fd = os.open(STATE_DIR, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def read_generation(state_dir):
    path = os.path.join(state_dir, "credential-generation")
    if os.path.islink(path):
        raise RuntimeError("Link simbólico não permitido")
    try:
        with open(path) as handle:
            if os.fstat(handle.fileno()).st_mode & 0o077:
                raise RuntimeError("Permissões inseguras na geração")
            text = handle.read().strip()
        if not text.isdigit() or len(text) > 10 or int(text) > 2147483647:
            raise RuntimeError("Geração inválida")
        return int(text)
    except FileNotFoundError:
        return 0


def save_generation(state_dir, generation):
    from operational_collector import atomic
    # Scalar JSON integer is also a plain decimal readable by read_generation.
    atomic(os.path.join(state_dir, "credential-generation"), generation)


def run_supervisor(identity, enrollment_key, operational_token):
    agent_id = identity["agent_id"]
    enrolled = False
    auth_path = os.path.join(STATE_DIR, "telemetry-auth-blocked")
    telemetry_blocked = os.path.lexists(auth_path)
    attempt_path = os.path.join(STATE_DIR, "credential-attempted")
    failures = 0
    generation = read_generation(STATE_DIR)
    while RUNNING:
        operation = "enroll" if not enrolled else "status"
        delay = POLL_SECONDS
        try:
            if not enrolled:
                response = api_request(
                    "/api/devcore/agents/enroll", {"identity": identity},
                    token=BOOTSTRAP_TOKEN)
                checked_status(response)
                if response.get("id") != agent_id:
                    raise ProtocolError()
                enrolled = True
            if not RUNNING:
                break
            operation = "status"
            status = api_request("/api/devcore/agents/status/" + agent_id,
                                 enrollment_key=enrollment_key)
            state = checked_status(status)
            remote_generation = status.get("credential_generation", 0)
            if type(remote_generation) is not int or not generation <= remote_generation <= 2147483647:
                raise ProtocolError()
            if remote_generation > generation:
                # Only an authenticated status response can attest an explicit
                # administrative reapproval. Network/401 errors never reach here.
                suspend_operational()
                delete_operational_token(STATE_DIR)
                operational_token = None
                for marker in (attempt_path, auth_path):
                    if os.path.islink(marker):
                        raise RuntimeError("Link simbólico não permitido")
                    try:
                        os.unlink(marker)
                    except FileNotFoundError:
                        pass
                save_generation(STATE_DIR, remote_generation)
                generation = remote_generation
                telemetry_blocked = False
                print("[multicortex] Reemissão autorizada administrativamente", flush=True)
            if not RUNNING:
                break
            if state in ("pending", "revoked"):
                suspend_operational()
                delete_operational_token(STATE_DIR)
                operational_token = None
                print("[multicortex] Estado:", state, flush=True)
                # Remain idle to observe an explicit future administrative
                # reapproval, without collecting or requesting credentials.
            elif not telemetry_blocked:
                if operational_token is None:
                    operation = "credential"
                    if os.path.lexists(attempt_path):
                        raise ProtocolError()
                    mark_credential_attempt(attempt_path)
                    if not RUNNING:
                        break
                    response = api_request(
                        "/api/devcore/agents/" + agent_id + "/credential",
                        payload={}, enrollment_key=enrollment_key)
                    if not isinstance(response, dict) or response.get("status") != "approved":
                        raise ProtocolError()
                    token = response.get("token")
                    save_operational_token(STATE_DIR, token)
                    operational_token = token
                if not RUNNING:
                    break
                operation = "collection"
                snapshot = collect_fallback(approved=True)
                if (not isinstance(snapshot, dict)
                        or snapshot.get("status") != "fallback_active"
                        or snapshot.get("monitoring_started") is not True
                        or not isinstance(snapshot.get("data"), dict)):
                    raise ProtocolError()
                if not RUNNING:
                    break
                collected = snapshot["data"]
                payload = {
                    "agent_id": agent_id,
                    "timestamp": __import__("datetime").datetime.utcnow().strftime(
                        "%Y-%m-%dT%H:%M:%SZ"),
                    "agent_version": identity["agent_version"],
                    "metrics": {"gpu": collected.get("gpus"),
                                "llama": collected.get("servers"), "fallback": True}
                }
                payload["metrics"]["operational"] = collect_operational(
                    approved=True, servers=collected.get("servers") or [],
                    state_dir=STATE_DIR, salt=enrollment_key)
                if not RUNNING:
                    suspend_operational()
                    break
                operation = "telemetry"
                api_request("/api/devcore/agents/" + agent_id + "/telemetry",
                            payload=payload, token=operational_token)
                print("[multicortex] Telemetria enviada", flush=True)
            failures = 0
        except Stopped:
            suspend_operational()
            break
        except Exception as error:
            suspend_operational()
            # Never log server bodies, exception strings, keys or headers.
            if operation == "collection" and not isinstance(error, (OSError, ValueError, ProtocolError)):
                print("[multicortex] Falha local de coleta", flush=True)
            elif isinstance(error, urllib.error.HTTPError):
                print("[multicortex] Falha HTTP em", operation, error.code, flush=True)
                if operation == "telemetry" and error.code in (401, 403):
                    telemetry_blocked = True
                    if not os.path.lexists(auth_path):
                        mark_credential_attempt(auth_path)
                if error.code not in TRANSIENT_HTTP:
                    delay = 300
            elif isinstance(error, (urllib.error.URLError, OSError, ValueError, ProtocolError, RuntimeError)):
                print("[multicortex] Operação suspensa:", operation, flush=True)
            else:
                raise
            failures += 1
            delay = max(delay, min(300, POLL_SECONDS * (2 ** min(failures - 1, 4))))
        if RUNNING:
            try:
                wait_interruptibly(delay)
            except Stopped:
                break

    suspend_operational()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)
    try:
        main()
    except Stopped:
        pass
    except (RuntimeError, urllib.error.URLError, ValueError, OSError):
        print("[multicortex] Configuração ou estado local inválido", file=sys.stderr)
        sys.exit(1)
