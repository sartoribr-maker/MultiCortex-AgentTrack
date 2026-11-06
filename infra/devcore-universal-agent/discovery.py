#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MultiCortex Universal Agent - Environment Discovery.

Python 3.6+ / standard library only.
No network access, monitoring or telemetry.
"""

import argparse
import json
import os
import socket
import tempfile
import uuid


AGENT_VERSION = "2.1.0-rc1"
DEFAULT_STATE_DIR = "/var/lib/devcore-universal-agent"


def detect_environment(environ=None):
    env = os.environ if environ is None else environ
    pod_id = env.get("RUNPOD_POD_ID", "").strip()
    return {
        "platform": "runpod" if pod_id else "unknown",
        "pod_id": pod_id or None,
        "hostname": socket.gethostname(),
    }


def get_agent_id(state_dir):
    """Create or reuse the installation UUID."""
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    path = os.path.join(state_dir, "agent-id")

    try:
        with open(path, "r") as handle:
            return str(uuid.UUID(handle.read().strip()))
    except FileNotFoundError:
        pass

    agent_id = str(uuid.uuid4())
    fd, tmp = tempfile.mkstemp(prefix=".agent-id-", dir=state_dir)

    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(agent_id + "\n")
            handle.flush()
            os.fsync(handle.fileno())

        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

    return agent_id


def discover(state_dir, environ=None):
    result = detect_environment(environ)
    result.update({
        "agent_id": get_agent_id(state_dir),
        "agent_version": AGENT_VERSION,
    })
    return result


def main():
    parser = argparse.ArgumentParser(
        description="MultiCortex Universal Agent - Discovery"
    )
    parser.add_argument(
        "--state-dir",
        default=DEFAULT_STATE_DIR,
        help="Directory for the local agent identity"
    )
    args = parser.parse_args()
    print(json.dumps(discover(args.state_dir), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
