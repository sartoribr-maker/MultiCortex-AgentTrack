#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MultiCortex Universal Agent - Restricted fallback monitoring.

Python 3.6+; standard library only.
No packet capture, scheduling or network transmission.
"""

import importlib.util
import os


BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def load_module(name):
    path = os.path.join(BASE_DIR, name + ".py")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def collect_fallback(approved=False):
    """Collect operational data only when explicitly approved.

    This local flag is a temporary development guard, not a
    substitute for server-side authorization.
    """
    if approved is not True:
        return {
            "status": "pending_approval",
            "monitoring_started": False,
            "data": None,
        }

    gpu = load_module("gpu_discovery")
    llama = load_module("llama_discovery")

    return {
        "status": "fallback_active",
        "monitoring_started": True,
        "data": {
            "gpus": gpu.discover_gpus(),
            "servers": llama.discover_servers(),
        },
    }


if __name__ == "__main__":
    print("Fallback module ready; no monitoring started.")
