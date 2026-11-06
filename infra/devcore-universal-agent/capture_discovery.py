#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MultiCortex Universal Agent - Capture capability discovery.

Python 3.6+; standard library only.
Does not start packet capture or monitoring.
"""

import json
import os
import shutil
import subprocess


CAP_NET_ADMIN = 12
CAP_NET_RAW = 13


def linux_capabilities(status_path="/proc/self/status"):
    result = {
        "net_raw": False,
        "net_admin": False,
        "readable": False,
    }

    try:
        with open(status_path, "r") as handle:
            for line in handle:
                if line.startswith("CapEff:"):
                    mask = int(line.split(":", 1)[1].strip(), 16)
                    result["net_raw"] = bool(mask & (1 << CAP_NET_RAW))
                    result["net_admin"] = bool(mask & (1 << CAP_NET_ADMIN))
                    result["readable"] = True
                    break
    except (OSError, ValueError):
        pass

    return result


def tcpdump_interfaces(binary, timeout=3):
    try:
        output = subprocess.check_output(
            [binary, "-D"],
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            universal_newlines=True,
        )
    except (OSError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired):
        return []

    interfaces = []

    for line in output.splitlines():
        entry = line.split(" ", 1)[0]
        if "." not in entry:
            continue
        number, name = entry.split(".", 1)
        if number.isdigit() and name:
            interfaces.append(name)

    return interfaces


def discover_capture():
    binary = shutil.which("tcpdump")
    caps = linux_capabilities()
    interfaces = tcpdump_interfaces(binary) if binary else []

    preferred = None
    for candidate in ("any", "lo", "eth0"):
        if candidate in interfaces:
            preferred = candidate
            break

    return {
        "tcpdump_installed": bool(binary),
        "interfaces": interfaces,
        "preferred_interface": preferred,
        "capabilities": caps,
        "capture_permission_verified": False,
        "monitoring_started": False,
    }


if __name__ == "__main__":
    print(json.dumps(discover_capture(), indent=2, sort_keys=True))
