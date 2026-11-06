#!/usr/bin/env python3
"""Run an owned capture only while the supervisor's approval lease is valid."""
import argparse
import fcntl
import json
import os
import signal
import subprocess
import sys
import threading
import time


def process_start(pid):
    try:
        with open("/proc/{}/stat".format(int(pid))) as handle:
            fields = handle.read().rsplit(") ", 1)[1].split()
            return None if fields[0] in ("Z", "X") else fields[19]
    except (OSError, ValueError, IndexError):
        return None


def lease_valid(path, now=None, expected=None):
    try:
        with open(path) as handle:
            value = json.load(handle)
        expiry = value.get("expires_at")
        owner = (value.get("owner_pid"), value.get("owner_start"))
        if not isinstance(owner[0], int) or owner[0] <= 1 or not owner[1] or process_start(owner[0]) != owner[1]:
            return False
        if expected is not None and owner != expected:
            return False
        current = time.time() if now is None else now
        return isinstance(expiry, (float, int)) and current < expiry <= current + 60
    except (OSError, ValueError, AttributeError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lease", required=True)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    if os.getpgrp() != os.getpid() or not lease_valid(args.lease):
        return 1
    lock = os.open(args.lease + ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock)
        return 1
    with open(args.lease) as handle:
        value = json.load(handle)
    owner = (value["owner_pid"], value["owner_start"])
    worker = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(__file__),
                               "http_capture_core.py"), "--config", args.config],
                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL)
    try:
        while not stopping.wait(.5) and lease_valid(args.lease, expected=owner):
            if worker.poll() is not None:
                return 1
    finally:
        # Guardian, parser and tcpdump share this private process group. Killing
        # the group also handles parent crashes during child creation.
        os.killpg(os.getpgrp(), signal.SIGTERM)
        try:
            worker.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        os.killpg(os.getpgrp(), signal.SIGKILL)
    return 0


if __name__ == "__main__":
    sys.exit(main())
