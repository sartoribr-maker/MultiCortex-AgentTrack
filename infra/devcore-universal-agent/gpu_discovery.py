#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MultiCortex Universal Agent - NVIDIA GPU discovery.

Python 3.6+; standard library only.
Read-only GPU telemetry using nvidia-smi.
"""

import csv
import io
import json
import subprocess


GPU_FIELDS = (
    "index,name,uuid,memory.total,memory.used,"
    "utilization.gpu,temperature.gpu"
)


def parse_number(value):
    value = value.strip()
    if value in ("", "N/A", "[N/A]", "Not Supported"):
        return None
    try:
        return int(value)
    except ValueError:
        return None


def parse_gpu_output(output):
    devices = []

    for row in csv.reader(io.StringIO(output)):
        if len(row) != 7:
            continue

        index = parse_number(row[0])
        if index is None:
            continue

        total = parse_number(row[3])
        used = parse_number(row[4])

        devices.append({
            "index": index,
            "name": row[1].strip(),
            "uuid": row[2].strip(),
            "memory_total_mib": total,
            "memory_used_mib": used,
            "memory_free_mib": (
                max(0, total - used)
                if total is not None and used is not None
                else None
            ),
            "utilization_percent": parse_number(row[5]),
            "temperature_c": parse_number(row[6]),
        })

    return devices


def discover_gpus(timeout=5):
    command = [
        "nvidia-smi",
        "--query-gpu=" + GPU_FIELDS,
        "--format=csv,noheader,nounits",
    ]

    try:
        output = subprocess.check_output(
            command,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            universal_newlines=True,
        )
    except (OSError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired):
        return {
            "available": False,
            "count": 0,
            "devices": [],
        }

    devices = parse_gpu_output(output)

    return {
        "available": bool(devices),
        "count": len(devices),
        "devices": devices,
    }


if __name__ == "__main__":
    print(json.dumps(discover_gpus(), indent=2, sort_keys=True))
