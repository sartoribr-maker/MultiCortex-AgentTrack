#!/usr/bin/env python3
"""Install immutable agent code only; no enrollment, secrets or runtime state."""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

FILES = ("supervisor.py", "discovery.py", "fallback_monitor.py", "gpu_discovery.py",
         "llama_discovery.py", "agent_service.py", "template_boot.py", "entrypoint-agent.sh",
         "operational_collector.py", "capture_guard.py", "http_capture_core.py", "request_metrics_core.py")


def install(source, target):
    if sys.version_info < (3, 6):
        raise RuntimeError("Python 3.6+ necessário")
    if not os.path.isabs(str(target)) or str(target) == "/":
        raise RuntimeError("Destino deve ser absoluto e exclusivo")
    if os.path.lexists(str(target)):
        raise RuntimeError("Destino já existe; não será sobrescrito")
    with (source / "MANIFEST.json").open() as handle:
        manifest = json.load(handle)
    if set(manifest["sha256"]) != set(FILES):
        raise RuntimeError("Manifesto inválido")
    for name in FILES:
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("Arquivo inválido no pacote")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != manifest["sha256"][name]:
            raise RuntimeError("Integridade inválida")
        if name.endswith(".py"):
            ast.parse(data, filename=name)
    target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".agent-install-", dir=str(target.parent)))
    try:
        for name in FILES:
            shutil.copyfile(str(source / name), str(temporary / name))
            os.chmod(str(temporary / name), 0o755 if name.endswith(".sh") else 0o644)
        os.chmod(str(temporary), 0o755)
        os.rename(str(temporary), str(target))
    finally:
        if temporary.exists():
            shutil.rmtree(str(temporary))
    print("Código instalado em " + str(target))
    print("Nenhuma identidade, credencial ou configuração de boot foi criada")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-dir", default="/opt/multicortex/devcore-universal-agent")
    args = parser.parse_args()
    install(Path(__file__).resolve().parent, Path(args.install_dir))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError, SyntaxError):
        print("Falha na instalação: confira versão Python, integridade e destino livre", file=sys.stderr)
        sys.exit(1)
