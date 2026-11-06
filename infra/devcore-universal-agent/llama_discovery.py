#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Discover running llama.cpp servers using /proc.

Python 3.6+; standard library only.
Read-only: does not connect to or modify server processes.
"""

import json
import os
import re


SERVER_NAMES = ("llama-server", "server")


def option_value(args, names):
    """Return the last value supplied for a CLI option."""
    result = None
    for index, arg in enumerate(args):
        for name in names:
            if arg == name and index + 1 < len(args):
                result = args[index + 1]
            elif arg.startswith(name + "="):
                result = arg[len(name) + 1:]
    return result


def positive_integer(value):
    if value is None or not re.match(r"^[0-9]+$", value):
        return None
    number = int(value)
    return number if number > 0 else None


def parse_server(pid, args):
    if not args:
        return None

    executable = os.path.basename(args[0])

    # "server" is accepted only when its command line contains
    # recognizable llama.cpp options.
    if executable == "llama-server" or executable.startswith("multicortex-server-"):
        pass
    elif executable == "server" and any(
        arg == "--parallel" or arg.startswith("--parallel=")
        for arg in args[1:]
    ):
        pass
    else:
        return None

    port = positive_integer(option_value(args[1:], ("--port", "-p")))
    if port is not None and port > 65535:
        port = None

    slots = positive_integer(
        option_value(args[1:], ("--parallel", "-np"))
    )

    return {
        "pid": int(pid),
        "executable": executable,
        "port": port,
        "slots": slots,
    }


def discover_servers(proc_root="/proc"):
    servers = []

    try:
        entries = os.listdir(proc_root)
    except OSError:
        return servers

    for entry in entries:
        if not entry.isdigit():
            continue

        path = os.path.join(proc_root, entry, "cmdline")
        try:
            with open(path, "rb") as handle:
                raw = handle.read(65536)
        except (OSError, IOError):
            continue

        args = [
            item.decode("utf-8", "replace")
            for item in raw.split(b"\0") if item
        ]

        server = parse_server(entry, args)
        if server is not None:
            servers.append(server)

    return sorted(servers, key=lambda item: item["pid"])


if __name__ == "__main__":
    print(json.dumps(discover_servers(), indent=2, sort_keys=True))
