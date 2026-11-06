#!/usr/bin/env python3
"""Persistent configuration and detached operation for the Universal Agent.

Python 3.6+, Linux, standard library. This does not install a boot hook.
"""
import argparse
import fcntl
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import re
import signal
import subprocess
import sys
import tempfile
import time

STATE_DIR = os.environ.get("MULTICORTEX_AGENT_STATE_DIR", "/workspace/devcore-agent-state")
SCRIPT = os.path.realpath(__file__)


def state_path(name):
    return os.path.join(STATE_DIR, name)


def prepare_state():
    if os.path.islink(STATE_DIR):
        raise RuntimeError("Diretório de estado não pode ser link simbólico")
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)


def secure_open(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    if os.fstat(fd).st_mode & 0o077:
        os.close(fd)
        raise RuntimeError("Permissões inseguras em arquivo de serviço")
    return fd


def configure():
    prepare_state()
    url = os.environ.get("MULTICORTEX_MONITOR_URL", "").rstrip("/")
    token = os.environ.get("MULTICORTEX_BOOTSTRAP_TOKEN", "")
    if not url.startswith("https://") or not re.fullmatch(r"[a-f0-9]{64}", token):
        raise RuntimeError("URL HTTPS e bootstrap válido devem estar exportados")
    path = state_path("service-config.json")
    if os.path.lexists(path):
        raise RuntimeError("Configuração já existe; não será sobrescrita")
    fd, temporary = tempfile.mkstemp(prefix=".service-config-", dir=STATE_DIR)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump({"monitor_url": url, "bootstrap_token": token}, handle)
            handle.flush()
            os.fsync(handle.fileno())
        # Fail rather than overwrite a concurrent configuration.
        os.link(temporary, path)
        directory = os.open(STATE_DIR, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(temporary)
    print("Configuração salva com permissão 0600; segredo não exibido")


def load_config():
    path = state_path("service-config.json")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as handle:
        if os.fstat(handle.fileno()).st_mode & 0o077:
            raise RuntimeError("Permissões inseguras na configuração")
        config = json.load(handle)
    if (not isinstance(config, dict)
            or not isinstance(config.get("monitor_url"), str)
            or not config["monitor_url"].startswith("https://")
            or not isinstance(config.get("bootstrap_token"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", config["bootstrap_token"])):
        raise RuntimeError("Configuração inválida")
    return config


def running_pid():
    try:
        fd = os.open(state_path("service.pid"), os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as handle:
            pid = int(handle.read().strip())
        if pid <= 1:
            return None
        proc = "/proc/" + str(pid)
        if os.stat(proc).st_uid != os.getuid():
            return None
        with open(proc + "/cmdline", "rb") as handle:
            args = handle.read().split(b"\0")
        if SCRIPT.encode() not in args or b"run" not in args:
            return None
        return pid
    except (OSError, ValueError):
        return None


class LogStream:
    def __init__(self, logger):
        self.logger = logger
        self.pending = ""

    def write(self, value):
        self.pending += value
        while "\n" in self.pending:
            line, self.pending = self.pending.split("\n", 1)
            self.logger.info(line)
        return len(value)

    def flush(self):
        # print(..., flush=True) flushes after its terminating newline.
        for handler in self.logger.handlers:
            handler.flush()


def run():
    prepare_state()
    lock = secure_open(state_path("service.lock"))
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock)
        print("Serviço já está em execução")
        return
    try:
        config = load_config()
        os.environ["MULTICORTEX_MONITOR_URL"] = config["monitor_url"]
        os.environ["MULTICORTEX_BOOTSTRAP_TOKEN"] = config["bootstrap_token"]
        os.environ["MULTICORTEX_AGENT_STATE_DIR"] = STATE_DIR
        log_path = state_path("agent.log")
        fd = secure_open(log_path)
        os.close(fd)
        logger = logging.getLogger("multicortex-service")
        logger.setLevel(logging.INFO)
        handler = RotatingFileHandler(log_path, maxBytes=1024 * 1024, backupCount=3, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
        logger.addHandler(handler)
        import supervisor
        signal.signal(signal.SIGTERM, supervisor.stop_handler)
        signal.signal(signal.SIGINT, supervisor.stop_handler)
        pid_fd = secure_open(state_path("service.pid"))
        with os.fdopen(pid_fd, "w") as handle:
            handle.write(str(os.getpid()))
            handle.flush()
            os.fsync(handle.fileno())
        previous_out, previous_err = sys.stdout, sys.stderr
        sys.stdout = sys.stderr = LogStream(logger)
        try:
            logger.info("Serviço iniciado")
            supervisor.main()
        except Exception:
            # Exception text may contain server data or authentication material.
            logger.error("Serviço encerrado por erro; verificar configuração e estado local")
            raise SystemExit(1)
        finally:
            logger.info("Serviço encerrado")
            sys.stdout, sys.stderr = previous_out, previous_err
            handler.close()
            logger.removeHandler(handler)
            os.unlink(state_path("service.pid"))
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("configure", "start", "run", "status", "stop"))
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "configure":
        configure()
    elif args.command == "run":
        run()
    elif args.command == "status":
        pid = running_pid()
        print("Em execução (PID {})".format(pid) if pid else "Parado")
    elif args.command == "stop":
        pid = running_pid()
        if pid:
            os.kill(pid, signal.SIGTERM)
            print("Encerramento solicitado; aguarde a operação atual terminar")
        else:
            print("Parado")
    else:
        prepare_state()
        load_config()
        if running_pid():
            print("Serviço já está em execução")
            return
        child = subprocess.Popen([sys.executable, SCRIPT, "run"], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True, close_fds=True)
        for _ in range(30):
            if running_pid():
                print("Serviço iniciado em segundo plano; logs em " + state_path("agent.log"))
                return
            if child.poll() is not None:
                raise RuntimeError("Serviço não iniciou; execute 'run' para diagnóstico")
            time.sleep(0.1)
        raise RuntimeError("Inicialização ainda não confirmada; consulte status e logs")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError):
        print("Falha de configuração ou operação do serviço; nenhum segredo foi exibido", file=sys.stderr)
        sys.exit(1)
