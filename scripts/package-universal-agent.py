#!/usr/bin/env python3
"""Build an allowlisted, credential-free installer kit for template administrators."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "infra/devcore-universal-agent"
KIT_NAME = "devcore-universal-agent-template-v3"
FILES = ("supervisor.py", "discovery.py", "fallback_monitor.py", "gpu_discovery.py",
         "llama_discovery.py", "agent_service.py", "template_boot.py", "entrypoint-agent.sh",
         "operational_collector.py", "capture_guard.py", "http_capture_core.py", "request_metrics_core.py")


def build(destination):
    members = {name: (AGENT / name).read_bytes() for name in FILES}
    manifest = {"kit_version": "3", "agent_version": "2.2.0", "sha256": {
        name: hashlib.sha256(data).hexdigest() for name, data in members.items()}}
    members["MANIFEST.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    for name in ("install.py", "README.md", "Dockerfile.example"):
        members[name] = (AGENT / "template-kit" / name).read_bytes()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(str(destination), "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(members.items()):
            info = zipfile.ZipInfo(KIT_NAME + "/" + name,
                                   date_time=(2026, 11, 6, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100755 if name.endswith(".sh") else 0o100644) << 16
            archive.writestr(info, data)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    destination.with_suffix(destination.suffix + ".sha256").write_text(
        digest + "  " + destination.name + "\n")
    return digest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(ROOT / "artifacts/devcore-universal-agent-template-v3.zip"))
    args = parser.parse_args()
    target = Path(args.output).resolve()
    print(str(target))
    print("SHA256: " + build(target))
