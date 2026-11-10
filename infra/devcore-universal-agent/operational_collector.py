#!/usr/bin/env python3
"""Approval-gated operational metrics; existing read-only source or owned capture.

No inference requests, model restarts, port interception or credential rotation.
Python 3.6+, standard library. Capture is opt-in and has a short approval lease.
"""
import copy
import glob
import hashlib
import hmac
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone

_CAPTURE = None
_LAST_BUILD = 0
_CAPTURE_STARTED = 0
MAX_BYTES = 180000


def invalid_constant(_value):
    raise ValueError("non-finite JSON")


def transport_metrics(raw):
    # Local exporters may grow new fields. Forward only the documented metrics
    # contract, never arbitrary headers, bodies or debugging fields.
    required = "schema agent_version generated_at host utc_offset_minutes slots sources today hourly_24h timeline_today daily".split()
    if not all(key in raw for key in required):
        raise ValueError("incomplete metrics")
    value = {key: copy.deepcopy(raw[key]) for key in required}
    def select(data, keys):
        if not isinstance(data, dict):
            raise ValueError("invalid metrics object")
        return {key: data[key] for key in keys.split() if key in data}
    value["today"] = select(value["today"], "date requests requests_ok errors_4xx errors_5xx cancelled_499 error_rate developers latency_s ttfb_s samples conn_peak saturation_pct inflight other_requests gpu developer_list server")
    value["sources"] = {key: select(value["sources"][key], "last_ts lines_ok lines_invalid") for key in ("samples", "access_log")}
    for key in ("latency_s", "ttfb_s"):
        value["today"][key] = select(value["today"][key], "p50 p95")
    value["today"]["gpu"] = select(value["today"]["gpu"], "util_avg util_max mem_mb_avg mem_mb_max mem_mb_total")
    for key in ("conn_peak", "saturation_pct"):
        value["today"][key] = select(value["today"][key], "devcore site total")
    if "inflight" in value["today"]:
        value["today"]["inflight"] = {key: select(value["today"]["inflight"][key], "devcore other total") for key in ("peak", "saturation_pct")}
    if "server" in value["today"]:
        server = select(value["today"]["server"], "ctx_per_slot context_exceeded context_exceeded_max_tokens errors_other context_tokens decode_tps prefill_tps_p50")
        for key in ("context_tokens", "decode_tps"):
            server[key] = select(server[key], "p50 p95 p10")
        value["today"]["server"] = server
    if "developer_list" in value["today"]:
        value["today"]["developer_list"] = [select(row, "ip requests requests_ok errors_4xx errors_5xx cancelled_499 first_seen last_seen active_s latency_p50 ttfb_p50") for row in value["today"]["developer_list"][:200]]
    value["hourly_24h"] = [select(row, "start requests errors p50 p95 ttfb_p50 ttfb_p95") for row in value["hourly_24h"][-48:]]
    timeline = value["timeline_today"]
    value["timeline_today"] = {"interval_s": timeline["interval_s"], "points": [select(row, "t conn_devcore_max conn_site_max inflight_devcore_max inflight_other_max gpu_util_avg gpu_util_max gpu_mem_mb_max") for row in timeline["points"][-2000:]]}
    value["daily"] = [select(row, "date requests errors developers p50 p95 conn_peak_total saturation_pct_total inflight_peak_total inflight_saturation_pct_total gpu_util_avg") for row in value["daily"][-400:]]
    return value


def transport_live(raw):
    required = "schema kind capture_version generated_at slots window_s developers inflight gpu".split()
    if not all(key in raw for key in required):
        return None
    value = {key: raw[key] for key in required}
    value["developers"] = {key: raw["developers"][key] for key in ("online", "active")}
    value["inflight"] = {key: raw["inflight"][key] for key in ("devcore", "other")}
    value["gpu"] = {key: raw["gpu"][key] for key in ("util", "mem_mb", "mem_mb_total")}
    return value


def read_json(path):
    if os.path.islink(path):
        raise ValueError("source symlink")
    with open(path, "rb") as handle:
        raw = handle.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("source size")
    value = json.loads(raw.decode("utf-8"), parse_constant=invalid_constant)
    if not isinstance(value, dict):
        raise ValueError("source format")
    return value


def fresh(value, seconds, now=None):
    try:
        from request_metrics_core import parse_ts
        parsed = parse_ts(value["generated_at"])
        if parsed is None:
            return False
        stamp = parsed.timestamp()
        age = (time.time() if now is None else now) - stamp
        return -10 <= age <= seconds
    except (KeyError, ValueError, TypeError):
        return False


def unavailable(reason):
    return {"version": 1, "status": "unavailable", "reason": reason,
            "source": None, "metrics": None, "live": None, "developer_identity": "pseudonymous"}


def anonymize(metrics, salt):
    value = copy.deepcopy(metrics)
    for developer in value.get("today", {}).get("developer_list", []):
        ip = developer.get("ip", "")
        developer["ip"] = "dev-" + hmac.new(salt.encode("utf-8"), str(ip).encode("utf-8"), hashlib.sha256).hexdigest()[:20]
    return value


def suspend_operational():
    global _CAPTURE
    import signal
    process, _CAPTURE = _CAPTURE, None
    if process is None:
        return
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=6)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def atomic(path, value):
    import tempfile
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".operational-", dir=directory)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


POD_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def capture_enabled(environ):
    """Explicit 1/0 wins; on a RunPod POD (RUNPOD_POD_ID set) capture is on by default."""
    value = environ.get("MULTICORTEX_CAPTURE_ENABLED", "").strip()
    if value in ("0", "1"):
        return value == "1"
    return bool(POD_ID.match(environ.get("RUNPOD_POD_ID", "").strip()))


def devcore_hosts(environ, port):
    """Explicit list wins; otherwise the RunPod HTTP proxy host seen in X-Forwarded-Host."""
    explicit = environ.get("MULTICORTEX_DEVCORE_HOSTS", "").strip()
    if explicit:
        return explicit
    pod_id = environ.get("RUNPOD_POD_ID", "").strip()
    if not POD_ID.match(pod_id) or not str(port).isdigit():
        return ""
    return "{0}-{1}.proxy.runpod.net,devcore01.multicortex.com.br".format(pod_id.lower(), port)


def owned_source(servers, state_dir):
    global _CAPTURE, _LAST_BUILD, _CAPTURE_STARTED
    if not capture_enabled(os.environ):
        return None, None, "source_not_configured"
    if shutil.which("tcpdump") is None:
        return None, None, "tcpdump_unavailable"
    port = os.environ.get("MULTICORTEX_LLAMA_PORT", "")
    choices = [s for s in servers if s.get("port") and s.get("slots")]
    if port:
        choices = [s for s in choices if str(s["port"]) == port]
    if len(choices) != 1:
        return None, None, "server_selection_required"
    hosts = devcore_hosts(os.environ, choices[0]["port"])
    if not hosts or any(c in hosts for c in "\r\n%"):
        return None, None, "hosts_required"
    root = os.path.join(state_dir, "operational")
    os.makedirs(root, mode=0o700, exist_ok=True)
    log_dir = os.path.join(root, "logs")
    os.makedirs(log_dir, mode=0o700, exist_ok=True)
    lease = os.path.join(root, "approval-lease.json")
    from capture_guard import process_start
    atomic(lease, {"expires_at": time.time() + 45, "owner_pid": os.getpid(), "owner_start": process_start(os.getpid())})
    config = os.path.join(root, "collection.conf")
    selected = choices[0]
    if _CAPTURE is None or _CAPTURE.poll() is not None:
        text = ("[capture]\nport = {port}\ninterface = any\nbpf_extra = \n"
                "log_dir = {log}\nlive_output = {root}/live.json\nwrite_samples = true\n"
                "retention_days = 45\nlive_interval_s = 10\n"
                "[agent]\nslots = {slots}\ndevcore_hosts = {hosts}\n"
                "push_url = \nserver_unit = \nstate_dir = {root}\n"
                "samples_glob = {log}/samples.csv-*\naccess_log_glob = {log}/requests-*.log\n"
                "developer_details = true\n").format(port=selected["port"], slots=selected["slots"],
                                                     hosts=hosts, log=log_dir, root=root)
        fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
        _CAPTURE_STARTED = time.time()
        _CAPTURE = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(__file__),
                                   "capture_guard.py"), "--lease", lease, "--config", config],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
    live_path = os.path.join(root, "live.json")
    if not os.path.isfile(live_path):
        return None, None, "capture_warming_up"
    snapshot = read_json(live_path)
    try:
        stamp = datetime.strptime(snapshot["generated_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    except (ValueError, KeyError, TypeError):
        return None, None, "capture_warming_up"
    if stamp < int(_CAPTURE_STARTED) or not fresh(snapshot, 45) or _CAPTURE.poll() is not None:
        return None, None, "capture_unavailable"
    if not any(os.path.getsize(path) > 0 for path in glob.glob(os.path.join(log_dir, "requests-*.log"))):
        return None, None, "http_not_observed"
    if time.time() - _LAST_BUILD >= 60:
        import request_metrics_core as core
        cfg = core.load_config(config)
        cache_path = os.path.join(root, "aggregation-state.json")
        previous = core.load_state(cache_path)
        metrics, state = core.build_metrics(cfg, datetime.now(timezone.utc), previous)
        atomic(cache_path, state)
        atomic(os.path.join(root, "metrics.json"), metrics)
        _LAST_BUILD = time.time()
    return os.path.join(root, "metrics.json"), os.path.join(root, "live.json"), None


def collect_operational(approved=False, servers=None, state_dir=None, salt=""):
    if approved is not True:
        suspend_operational()
        return unavailable("approval_required")
    if not salt:
        return unavailable("identity_required")
    try:
        metrics_path = os.environ.get("MULTICORTEX_OPERATIONAL_METRICS_FILE", "/srv/www/devcore-metrics/metrics.json")
        live_path = os.environ.get("MULTICORTEX_OPERATIONAL_LIVE_FILE", "/var/lib/devcore-metrics/live.json")
        source = "existing"
        if not os.path.isfile(metrics_path):
            metrics_path, live_path, problem = owned_source(servers or [], state_dir)
            if problem:
                return unavailable(problem)
            source = "capture"
        if source == "existing":
            suspend_operational()
        metrics = read_json(metrics_path)
        expected_host = os.environ.get("MULTICORTEX_OPERATIONAL_HOST", socket.gethostname())
        if metrics.get("schema") != 1 or metrics.get("host") != expected_host:
            return unavailable("source_identity_mismatch")
        detected = [server for server in (servers or []) if server.get("slots")]
        if len(detected) == 1 and metrics.get("slots") != detected[0]["slots"]:
            return unavailable("source_identity_mismatch")
        if source == "existing" and len(detected) > 1 and not os.environ.get("MULTICORTEX_LLAMA_PORT"):
            return unavailable("server_selection_required")
        if not fresh(metrics, 180):
            return unavailable("source_stale")
        live = None
        if os.path.isfile(live_path):
            candidate = read_json(live_path)
            if candidate.get("schema") == 1 and candidate.get("kind") == "live" and fresh(candidate, 45):
                live = transport_live(candidate)
        metrics = transport_metrics(metrics)
        return {"version": 1, "status": "available", "reason": None, "source": source,
                "metrics": anonymize(metrics, salt), "live": live, "developer_identity": "pseudonymous"}
    except Exception:
        suspend_operational()
        return unavailable("collection_failed")
