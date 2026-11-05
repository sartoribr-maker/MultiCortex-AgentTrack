#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DevCore VM metrics agent.

Reads the POC monitoring sample file, the request logs and (since 1.2) the
llama.cpp server journal, aggregates them in Brasilia time and atomically writes a versioned metrics.json that
nginx serves (token protected) to the MultiCortex dashboard.

Compatible with Python 3.6 (openSUSE Leap 15.6), standard library only.
Since 1.3, today.developer_list breaks today's usage down by developer IP for
the staff-only dashboard (developer_details = false keeps the output to counts
only). The persisted daily history never contains IP addresses.
"""
from __future__ import print_function

import argparse
import configparser
import glob
import gzip
import io
import json
import os
import ssl
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

AGENT_VERSION = "1.3.0"
SCHEMA_VERSION = 1

DEFAULTS = {
    "samples_glob": "/var/log/devcore-poc/samples.csv*",
    # Comma-separated. requests-*.log comes from devcore_http_capture.py (traffic
    # via the Apache gateway); the nginx log covers direct access to the VM.
    "access_log_glob": "/var/log/devcore-poc/requests-*.log*,/var/log/nginx/devcore01.access.log*",
    # Requests whose host (X-Forwarded-Host) is not listed count as "other".
    "devcore_hosts": "devcore01.multicortex.com.br",
    "output": "/srv/www/devcore-metrics/metrics.json",
    "state_dir": "/var/lib/devcore-metrics",
    "slots": "8",
    "chat_path": "/v1/chat/completions",
    "api_prefix": "/v1/",
    "retention_days": "45",
    "utc_offset_minutes": "-180",
    "timeline_interval_s": "300",
    "host": "",
    # systemd unit of llama.cpp; its journal gives the reasons for 400/5xx,
    # context size and generation speed. Empty disables it.
    "server_unit": "multicortex-server",
    # Per-developer (IP) breakdown of today in metrics.json; "false" = counts only.
    "developer_details": "true",
    "push_url": "",
    "push_token_file": "/etc/devcore-metrics/push.token",
}

UTC = timezone.utc
# Days are finalized (cached in state) only after this grace period, so lines
# still buffered around midnight are not lost.
FINALIZE_GRACE = timedelta(minutes=10)
# Calls closer than this belong to the same working session (same as the live
# card's online window): the gaps in between count as time active.
SESSION_GAP_S = 300
MAX_DEVELOPERS = 200

ACCESS_RE = re.compile(
    r'^(?P<ts>\S+) (?P<ip>\S+) "(?P<method>[A-Z]+) (?P<uri>[^"\s]*)[^"]*" '
    r'(?P<status>\d{3}) (?P<bytes>\S+) rt=(?P<rt>\S+) urt=(?P<urt>.*?) uht=(?P<uht>.*?)(?: host=(?P<host>\S+))?\s*$'
)
# llama.cpp server log lines (journalctl -o cat).
CTX_EXCEEDED_RE = re.compile(r'request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)')
CTX_SEQ_RE = re.compile(r'n_ctx_seq \((\d+)\)')
RELEASE_RE = re.compile(r'stop processing: n_tokens = (\d+)')
DECODE_RE = re.compile(r'\|\s+eval time = .*?,\s+([\d.]+) tokens per second')
PREFILL_RE = re.compile(r'prompt eval time = .*?,\s+([\d.]+) tokens per second')
SERVER_ERROR_RE = re.compile(r'^[\d.]+ E ')
ISO_RE = re.compile(
    r'^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6})\d*)?'
    r'(Z|[+-]\d{2}:?\d{2})?$'
)


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------

def parse_ts(value):
    """Parse ISO 8601 (with Z/offset, or naive = UTC) or epoch seconds."""
    value = (value or "").strip()
    if not value:
        return None
    if re.match(r'^\d+(\.\d+)?$', value):
        try:
            return datetime.fromtimestamp(float(value), UTC)
        except (OverflowError, OSError, ValueError):
            return None
    m = ISO_RE.match(value)
    if not m:
        return None
    year, month, day, hour, minute, second, frac, tz = m.groups()
    try:
        micro = int((frac or "0").ljust(6, "0"))
        dt = datetime(int(year), int(month), int(day), int(hour), int(minute), int(second), micro)
    except ValueError:
        return None
    if tz in (None, "Z"):
        return dt.replace(tzinfo=UTC)
    sign = 1 if tz[0] == "+" else -1
    digits = tz[1:].replace(":", "")
    offset = timedelta(hours=int(digits[:2]), minutes=int(digits[2:]))
    return dt.replace(tzinfo=timezone(sign * offset))


def parse_number(value):
    """Return a non-negative float, or None for '-', 'na', empty, garbage."""
    value = (value or "").strip()
    if not value or value in ("-", "na", "NA", "N/A", "[N/A]"):
        return None
    try:
        number = float(value)
    except ValueError:
        return None
    if number != number or number < 0:  # NaN or negative
        return None
    return number


def parse_upstream_time(value):
    """nginx lists one value per upstream try ('0.1, 0.2' or '0.1 : 0.2').
    The last try is the one that answered the client."""
    parts = [p for p in re.split(r'[,:]', value or "") if p.strip()]
    if not parts:
        return None
    return parse_number(parts[-1])


def parse_access_line(line):
    m = ACCESS_RE.match(line.rstrip("\r\n"))
    if not m:
        return None
    ts = parse_ts(m.group("ts"))
    if ts is None:
        return None
    uri = m.group("uri").split("?", 1)[0]
    return {
        "ts": ts,
        "ip": m.group("ip"),
        "method": m.group("method"),
        "uri": uri,
        "status": int(m.group("status")),
        "rt": parse_number(m.group("rt")),
        "uht": parse_upstream_time(m.group("uht")),
        # nginx vhost logs carry no host: they are DevCore-only by construction.
        "host": (m.group("host") or "").lower() or None,
    }


def parse_sample_line(line):
    """ts,gpu_util,gpu_mem_mb,conn_site,conn_devcore,slots_busy"""
    fields = [f.strip() for f in line.rstrip("\r\n").split(",")]
    if len(fields) < 5 or fields[0] == "ts":
        return None
    ts = parse_ts(fields[0])
    if ts is None:
        return None
    conn_site = parse_number(fields[3])
    conn_devcore = parse_number(fields[4])
    if conn_site is None and conn_devcore is None:
        return None
    return {
        "ts": ts,
        "gpu_util": parse_number(fields[1]),
        "gpu_mem_mb": parse_number(fields[2]),
        "conn_site": int(conn_site or 0),
        "conn_devcore": int(conn_devcore or 0),
        "slots_busy": parse_number(fields[5]) if len(fields) > 5 else None,
    }


# --------------------------------------------------------------------------
# File reading (current + rotated, gz)
# --------------------------------------------------------------------------

def candidate_files(pattern, not_before):
    """Files matching pattern (comma-separated globs) whose last write is not
    older than not_before. Rotated files are immutable, so older ones can be
    skipped entirely."""
    files = []
    paths = set()
    for item in pattern.split(","):
        if item.strip():
            paths.update(glob.glob(item.strip()))
    for path in paths:
        if not os.path.isfile(path):
            continue
        try:
            mtime = datetime.fromtimestamp(os.path.getmtime(path), UTC)
        except OSError:
            continue
        if not_before is None or mtime >= not_before:
            files.append(path)
    return sorted(files)


def iter_lines(path):
    opener = gzip.open if path.endswith(".gz") else io.open
    try:
        with opener(path, "rt", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                yield line
    except (IOError, OSError, EOFError):
        return


def read_records(pattern, parser, not_before):
    records, stats = [], {"lines_ok": 0, "lines_invalid": 0, "last_ts": None}
    for path in candidate_files(pattern, not_before):
        for line in iter_lines(path):
            if not line.strip():
                continue
            record = parser(line)
            if record is None:
                # A CSV header is not an invalid line.
                if not line.startswith("ts,"):
                    stats["lines_invalid"] += 1
                continue
            stats["lines_ok"] += 1
            if stats["last_ts"] is None or record["ts"] > stats["last_ts"]:
                stats["last_ts"] = record["ts"]
            if not_before is None or record["ts"] >= not_before:
                records.append(record)
    records.sort(key=lambda r: r["ts"])
    return records, stats


# --------------------------------------------------------------------------
# Aggregation
# --------------------------------------------------------------------------

def percentile(values, pct):
    """Linear interpolation between closest ranks (numpy default)."""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 3)
    rank = (len(ordered) - 1) * pct / 100.0
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    value = ordered[low] + (ordered[high] - ordered[low]) * (rank - low)
    return round(value, 3)


def is_loopback(ip):
    # Local tests and health checks on the VM are not developers.
    return ip.startswith("127.") or ip in ("::1", "localhost", "-")


def is_devcore(record, cfg):
    return record.get("host") is None or record["host"].split(":")[0] in cfg["devcore_hosts"]


def inflight(requests, start, end, slots, cfg):
    """Concurrent requests per second in [start, end] (each request occupies a
    slot from ts - rt until ts). Returns (devcore, other) lists of counts."""
    seconds = max(1, int((end - start).total_seconds()) + 1)
    if not any(r["method"] == "POST" and r["rt"] is not None for r in requests):
        return [0] * seconds, [0] * seconds
    diff = {"devcore": [0] * (seconds + 1), "other": [0] * (seconds + 1)}
    for r in requests:
        if r["method"] != "POST" or r["rt"] is None:
            continue
        finish = (r["ts"] - start).total_seconds()
        begin = finish - r["rt"]
        if finish < 0 or begin >= seconds:
            continue
        first, last = max(0, int(begin)), min(seconds - 1, int(finish))
        series = diff["devcore" if is_devcore(r, cfg) else "other"]
        series[first] += 1
        series[last + 1] -= 1
    result = []
    for key in ("devcore", "other"):
        running, counts = 0, []
        for value in diff[key][:seconds]:
            running += value
            counts.append(running)
        result.append(counts)
    return result


def summarize_inflight(dev, other, slots):
    total = [a + b for a, b in zip(dev, other)]
    count = float(len(total)) or 1.0
    return {
        "peak": {"devcore": max(dev or [0]), "other": max(other or [0]), "total": max(total or [0])},
        "saturation_pct": {
            "devcore": round(100 * sum(1 for v in dev if v >= slots) / count, 2),
            "total": round(100 * sum(1 for v in total if v >= slots) / count, 2),
        },
    }


def is_chat(record, cfg):
    return record["method"] == "POST" and record["uri"] == cfg["chat_path"]


def summarize_requests(records, cfg):
    """Request indicators for a set of access-log records."""
    chat = [r for r in records if is_chat(r, cfg)]
    ok = [r for r in chat if 200 <= r["status"] < 300]
    cancelled = sum(1 for r in chat if r["status"] == 499)
    errors_4xx = sum(1 for r in chat if 400 <= r["status"] < 500 and r["status"] != 499)
    errors_5xx = sum(1 for r in chat if r["status"] >= 500)
    considered = len(chat) - cancelled
    latency = [r["rt"] for r in ok if r["rt"] is not None]
    ttfb = [r["uht"] for r in ok if r["uht"] is not None]
    developers = developer_ips(records, cfg)
    return {
        "requests": len(chat),
        "requests_ok": len(ok),
        "errors_4xx": errors_4xx,
        "errors_5xx": errors_5xx,
        "cancelled_499": cancelled,
        "error_rate": round((errors_4xx + errors_5xx) / float(considered), 4) if considered else 0.0,
        "developers": len(developers),
        "latency_s": {"p50": percentile(latency, 50), "p95": percentile(latency, 95)},
        "ttfb_s": {"p50": percentile(ttfb, 50), "p95": percentile(ttfb, 95)},
    }


def developer_ips(records, cfg):
    # A developer is an address with at least one successful API call; this
    # keeps scanners hitting the API without a key (401/404) out of the count.
    return set(
        r["ip"] for r in records
        if r["uri"].startswith(cfg["api_prefix"]) and 200 <= r["status"] < 300 and not is_loopback(r["ip"])
    )


def active_seconds(records):
    """Union of the request intervals [ts - rt, ts], joining gaps up to SESSION_GAP_S."""
    spans = sorted(
        (r["ts"].timestamp() - (r["rt"] or 0.0), r["ts"].timestamp()) for r in records
    )
    total, start, end = 0.0, None, None
    for begin, finish in spans:
        if start is None or begin - end > SESSION_GAP_S:
            if start is not None:
                total += end - start
            start, end = begin, finish
        else:
            end = max(end, finish)
    if start is not None:
        total += end - start
    return int(round(total))


def developer_breakdown(records, cfg, tz):
    """Today's usage per developer IP (same developers as the count), busiest first."""
    by_ip = {}
    for ip in developer_ips(records, cfg):
        by_ip[ip] = []
    for r in records:
        if r["ip"] in by_ip and r["uri"].startswith(cfg["api_prefix"]):
            by_ip[r["ip"]].append(r)
    result = []
    for ip, items in by_ip.items():
        summary = summarize_requests(items, cfg)
        first = min(r["ts"] - timedelta(seconds=r["rt"] or 0.0) for r in items)
        result.append({
            "ip": ip,
            "requests": summary["requests"],
            "requests_ok": summary["requests_ok"],
            "errors_4xx": summary["errors_4xx"],
            "errors_5xx": summary["errors_5xx"],
            "cancelled_499": summary["cancelled_499"],
            "first_seen": iso_local(first.replace(microsecond=0), tz),
            "last_seen": iso_local(max(r["ts"] for r in items).replace(microsecond=0), tz),
            "active_s": active_seconds(items),
            "latency_p50": summary["latency_s"]["p50"],
            "ttfb_p50": summary["ttfb_s"]["p50"],
        })
    result.sort(key=lambda d: (-d["requests"], d["last_seen"], d["ip"]))
    return result[:MAX_DEVELOPERS]


def summarize_server_log(lines, ctx_hint=None):
    """Today's llama.cpp journal: why requests failed, how much context they
    used and how fast tokens were generated. Never stores prompt text."""
    exceeded, requested, ctx, other_errors = 0, [], None, 0
    context, decode, prefill = [], [], []
    for line in lines:
        m = CTX_EXCEEDED_RE.search(line)
        if m:
            exceeded += 1
            requested.append(int(m.group(1)))
            ctx = int(m.group(2))
            continue
        if SERVER_ERROR_RE.match(line):
            other_errors += 1
            continue
        m = RELEASE_RE.search(line)
        if m:
            context.append(int(m.group(1)))
            continue
        m = DECODE_RE.search(line)
        if m:
            decode.append(float(m.group(1)))
            continue
        m = PREFILL_RE.search(line)
        if m:
            prefill.append(float(m.group(1)))
            continue
        m = CTX_SEQ_RE.search(line)
        if m:
            ctx = int(m.group(1))
    return {
        "ctx_per_slot": ctx or ctx_hint,
        "context_exceeded": exceeded,
        "context_exceeded_max_tokens": max(requested) if requested else None,
        "errors_other": other_errors,
        "context_tokens": {"p50": percentile(context, 50), "p95": percentile(context, 95)},
        "decode_tps": {"p50": percentile(decode, 50), "p10": percentile(decode, 10)},
        "prefill_tps_p50": percentile(prefill, 50),
    }


def summarize_samples(samples, slots):
    if not samples:
        return {
            "samples": 0,
            "conn_peak": {"devcore": 0, "site": 0, "total": 0},
            "saturation_pct": {"devcore": 0.0, "total": 0.0},
            "gpu": {"util_avg": None, "util_max": None, "mem_mb_avg": None, "mem_mb_max": None},
        }
    totals = [s["conn_devcore"] + s["conn_site"] for s in samples]
    util = [s["gpu_util"] for s in samples if s["gpu_util"] is not None]
    mem = [s["gpu_mem_mb"] for s in samples if s["gpu_mem_mb"] is not None]
    count = float(len(samples))
    return {
        "samples": len(samples),
        "conn_peak": {
            "devcore": max(s["conn_devcore"] for s in samples),
            "site": max(s["conn_site"] for s in samples),
            "total": max(totals),
        },
        "saturation_pct": {
            "devcore": round(100 * sum(1 for s in samples if s["conn_devcore"] >= slots) / count, 2),
            "total": round(100 * sum(1 for t in totals if t >= slots) / count, 2),
        },
        "gpu": {
            "util_avg": round(sum(util) / len(util), 1) if util else None,
            "util_max": max(util) if util else None,
            "mem_mb_avg": int(round(sum(mem) / len(mem))) if mem else None,
            "mem_mb_max": int(max(mem)) if mem else None,
        },
    }


def local_day_start(dt, tz):
    local = dt.astimezone(tz)
    return local.replace(hour=0, minute=0, second=0, microsecond=0)


def iso_local(dt, tz):
    return dt.astimezone(tz).isoformat()


def hourly_buckets(records, now, tz, cfg):
    current = now.astimezone(tz).replace(minute=0, second=0, microsecond=0)
    starts = [current - timedelta(hours=23 - i) for i in range(24)]
    buckets = [[] for _ in starts]
    first = starts[0]
    for record in records:
        if record["ts"] < first:
            continue
        index = int((record["ts"] - first).total_seconds() // 3600)
        if 0 <= index < 24:
            buckets[index].append(record)
    result = []
    for start, items in zip(starts, buckets):
        summary = summarize_requests(items, cfg)
        result.append({
            "start": start.isoformat(),
            "requests": summary["requests"],
            "errors": summary["errors_4xx"] + summary["errors_5xx"],
            "p50": summary["latency_s"]["p50"],
            "p95": summary["latency_s"]["p95"],
            "ttfb_p50": summary["ttfb_s"]["p50"],
            "ttfb_p95": summary["ttfb_s"]["p95"],
        })
    return result


def timeline(samples, day_start, now, interval_s, dev=None, other=None):
    span = int((now - day_start).total_seconds() // interval_s) + 1
    buckets = [[] for _ in range(max(span, 0))]
    for sample in samples:
        if sample["ts"] < day_start:
            continue
        index = int((sample["ts"] - day_start).total_seconds() // interval_s)
        if 0 <= index < len(buckets):
            buckets[index].append(sample)
    points = []
    for index, items in enumerate(buckets):
        lo, hi = index * interval_s, (index + 1) * interval_s
        dev_max = max(dev[lo:hi] or [0]) if dev else 0
        other_max = max(other[lo:hi] or [0]) if other else 0
        if not items and not (dev_max or other_max):
            continue  # gaps stay gaps; the chart must not invent zeros
        util = [s["gpu_util"] for s in items if s["gpu_util"] is not None]
        mem = [s["gpu_mem_mb"] for s in items if s["gpu_mem_mb"] is not None]
        points.append({
            "t": (day_start + timedelta(seconds=index * interval_s)).isoformat(),
            "conn_devcore_max": max(s["conn_devcore"] for s in items) if items else None,
            "conn_site_max": max(s["conn_site"] for s in items) if items else None,
            "inflight_devcore_max": dev_max,
            "inflight_other_max": other_max,
            "gpu_util_avg": round(sum(util) / len(util), 1) if util else None,
            "gpu_util_max": max(util) if util else None,
            "gpu_mem_mb_max": int(max(mem)) if mem else None,
        })
    return points


def daily_summary(day, requests, samples, cfg, tz):
    devcore = [r for r in requests if is_devcore(r, cfg)]
    req = summarize_requests(devcore, cfg)
    smp = summarize_samples(samples, cfg["slots"])
    start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=tz)
    dev, other = inflight(requests, start, start + timedelta(days=1) - timedelta(seconds=1), cfg["slots"], cfg)
    infl = summarize_inflight(dev, other, cfg["slots"])
    return {
        "date": day,
        "requests": req["requests"],
        "errors": req["errors_4xx"] + req["errors_5xx"],
        "developers": req["developers"],
        "p50": req["latency_s"]["p50"],
        "p95": req["latency_s"]["p95"],
        "conn_peak_total": smp["conn_peak"]["total"],
        "saturation_pct_total": smp["saturation_pct"]["total"],
        "gpu_util_avg": smp["gpu"]["util_avg"],
        "inflight_peak_total": infl["peak"]["total"],
        "inflight_saturation_pct_total": infl["saturation_pct"]["total"],
        "has_data": bool(requests or samples),
    }


def group_by_day(records, tz):
    groups = {}
    for record in records:
        key = record["ts"].astimezone(tz).date().isoformat()
        groups.setdefault(key, []).append(record)
    return groups


# --------------------------------------------------------------------------
# State and output
# --------------------------------------------------------------------------

def load_state(path):
    try:
        with io.open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict) and isinstance(data.get("days"), dict):
            return data
    except (IOError, OSError, ValueError):
        pass
    return {"days": {}, "gpu_mem_mb_total": None}


def atomic_write_json(path, data, mode=0o644):
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(data, handle, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def gpu_memory_total():
    try:
        proc = subprocess.Popen(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True,
        )
        out, _ = proc.communicate(timeout=5)
        values = [parse_number(v) for v in out.splitlines()]
        values = [v for v in values if v is not None]
        return int(sum(values)) if values else None
    except Exception:  # nvidia-smi missing/hung: the dashboard shows "—"
        return None


def build_metrics(cfg, now, state, server_lines=None):
    """Pure aggregation step: returns (metrics, new_state). server_lines are
    today's llama.cpp journal lines (None when unavailable)."""
    tz = timezone(timedelta(minutes=cfg["utc_offset_minutes"]))
    today_start = local_day_start(now, tz)
    today = today_start.date()
    retention_start = today_start - timedelta(days=cfg["retention_days"] - 1)

    days_state = dict(
        (k, v) for k, v in state.get("days", {}).items()
        if k >= retention_start.date().isoformat()
    )
    # Closed days not yet finalized must be recomputed from the logs.
    missing = []
    day = retention_start
    while day < today_start:
        key = day.date().isoformat()
        if key not in days_state:
            missing.append(day)
        day += timedelta(days=1)

    window_start = min(today_start, now - timedelta(hours=24))
    if missing:
        window_start = min(window_start, missing[0])

    requests, access_stats = read_records(cfg["access_log_glob"], parse_access_line, window_start)
    samples, sample_stats = read_records(cfg["samples_glob"], parse_sample_line, window_start)
    # Our own metrics endpoint must never count as usage.
    requests = [r for r in requests if not r["uri"].startswith("/poc/")]

    req_by_day = group_by_day(requests, tz)
    smp_by_day = group_by_day(samples, tz)
    for day in missing:
        key = day.date().isoformat()
        if now - (day + timedelta(days=1)) < FINALIZE_GRACE:
            continue
        days_state[key] = daily_summary(key, req_by_day.get(key, []), smp_by_day.get(key, []), cfg, tz)

    today_key = today.isoformat()
    today_requests = req_by_day.get(today_key, [])
    today_samples = smp_by_day.get(today_key, [])
    today_devcore = [r for r in today_requests if is_devcore(r, cfg)]
    today_req = summarize_requests(today_devcore, cfg)
    today_smp = summarize_samples(today_samples, cfg["slots"])
    dev_inflight, other_inflight = inflight(today_requests, today_start, now, cfg["slots"], cfg)
    today_inflight = summarize_inflight(dev_inflight, other_inflight, cfg["slots"])

    mem_total = state.get("gpu_mem_mb_total") or gpu_memory_total()

    # Daily history from the first day with data, zero-filled afterwards.
    history = [days_state[k] for k in sorted(days_state)]
    today_daily = daily_summary(today_key, today_requests, today_samples, cfg, tz)
    first_index = next((i for i, d in enumerate(history) if d.get("has_data")), None)
    # Copies: removing has_data below must not alter the persisted state.
    daily = [dict(d) for d in history[first_index:]] if first_index is not None else []
    daily.append(today_daily)
    for entry in daily:
        entry.pop("has_data", None)

    today_block = dict(today_req)
    today_block.update({
        "date": today_key,
        "samples": today_smp["samples"],
        "conn_peak": today_smp["conn_peak"],
        "saturation_pct": today_smp["saturation_pct"],
        # Concurrent requests (what really occupies llama.cpp slots), from the logs.
        "inflight": today_inflight,
        "other_requests": sum(1 for r in today_requests if not is_devcore(r, cfg) and is_chat(r, cfg)),
        "gpu": dict(today_smp["gpu"], mem_mb_total=mem_total),
    })
    if cfg["developer_details"]:
        today_block["developer_list"] = developer_breakdown(today_devcore, cfg, tz)
    if server_lines is not None:
        today_block["server"] = summarize_server_log(server_lines, state.get("ctx_per_slot"))

    def source(stats):
        return {
            "last_ts": stats["last_ts"].astimezone(UTC).isoformat().replace("+00:00", "Z") if stats["last_ts"] else None,
            "lines_ok": stats["lines_ok"],
            "lines_invalid": stats["lines_invalid"],
        }

    metrics = {
        "schema": SCHEMA_VERSION,
        "agent_version": AGENT_VERSION,
        "generated_at": now.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "host": cfg["host"],
        "utc_offset_minutes": cfg["utc_offset_minutes"],
        "slots": cfg["slots"],
        "sources": {"samples": source(sample_stats), "access_log": source(access_stats)},
        "today": today_block,
        "hourly_24h": hourly_buckets([r for r in requests if is_devcore(r, cfg)], now, tz, cfg),
        "timeline_today": {
            "interval_s": cfg["timeline_interval_s"],
            "points": timeline(today_samples, today_start, now, cfg["timeline_interval_s"],
                               dev_inflight, other_inflight),
        },
        "daily": daily,
    }
    new_state = {"days": days_state, "gpu_mem_mb_total": mem_total}
    # The context size is logged only at server start: remember it.
    ctx = today_block.get("server", {}).get("ctx_per_slot") or state.get("ctx_per_slot")
    if ctx:
        new_state["ctx_per_slot"] = ctx
    return metrics, new_state


def read_server_journal(unit, since):
    """Lines logged by the llama.cpp unit since `since` (aware datetime), plus
    the latest startup line with the context size. None if journalctl fails."""
    if not unit:
        return None
    base = ["journalctl", "-u", unit, "-o", "cat", "--no-pager", "-q"]
    try:
        proc = subprocess.Popen(
            base + ["--since", "@%d" % int(since.timestamp())],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True, errors="replace",
        )
        out, _ = proc.communicate(timeout=20)
        if proc.returncode != 0:
            return None
        lines = out.splitlines()
    except Exception:  # journalctl missing/hung: the dashboard falls back
        return None
    if not any(CTX_SEQ_RE.search(line) for line in lines):
        try:
            proc = subprocess.Popen(
                base + ["-r", "-n", "1", "--grep", "n_ctx_seq"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True, errors="replace",
            )
            out, _ = proc.communicate(timeout=10)
            lines.extend(out.splitlines())
        except Exception:  # journalctl without --grep (no PCRE2)
            pass
    return lines


def load_config(path):
    parser = configparser.ConfigParser()
    parser.read_dict({"agent": DEFAULTS})
    if path:
        # push.conf (written by install.sh --push-url) sits next to agent.conf.
        parser.read([path, os.path.join(os.path.dirname(path), "push.conf")])
    section = parser["agent"]
    cfg = dict(section)
    for key in ("slots", "retention_days", "utc_offset_minutes", "timeline_interval_s"):
        cfg[key] = int(section[key])
    cfg["developer_details"] = section.getboolean("developer_details")
    cfg["devcore_hosts"] = set(h.strip().lower() for h in section["devcore_hosts"].split(",") if h.strip())
    if not cfg["host"]:
        cfg["host"] = os.uname()[1]
    return cfg


def push_metrics(cfg, metrics, opener=None):
    """POST metrics.json to the site (outbound only: no inbound port needed).
    Returns the HTTP status, or None when push is disabled or failed."""
    url = cfg.get("push_url", "").strip()
    if not url:
        return None
    if not (url.startswith("https://") or url.startswith("http://127.0.0.1") or url.startswith("http://localhost")):
        print("push: URL deve usar https", file=sys.stderr)
        return None
    try:
        with io.open(cfg["push_token_file"], "r", encoding="utf-8") as handle:
            token = handle.read().strip()
    except (IOError, OSError):
        print("push: token ausente em %s" % cfg["push_token_file"], file=sys.stderr)
        return None
    body = json.dumps(metrics, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        "User-Agent": "devcore-metrics-agent/" + AGENT_VERSION,
    })
    open_url = opener or (lambda req: urllib.request.urlopen(req, timeout=15, context=ssl.create_default_context()))
    try:
        with open_url(request) as response:
            return response.status if hasattr(response, "status") else response.getcode()
    except urllib.error.HTTPError as error:
        print("push: HTTP %d" % error.code, file=sys.stderr)
        return error.code
    except Exception as error:  # network/TLS: retried on the next run
        print("push: falha de rede (%s)" % type(error).__name__, file=sys.stderr)
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(description="DevCore VM metrics agent")
    parser.add_argument("--config", default="/etc/devcore-metrics/agent.conf")
    parser.add_argument("--stdout", action="store_true", help="print JSON instead of writing files")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    state_path = os.path.join(cfg["state_dir"], "state.json")
    state = load_state(state_path)
    now = datetime.now(UTC)
    tz = timezone(timedelta(minutes=cfg["utc_offset_minutes"]))
    server_lines = read_server_journal(cfg.get("server_unit", "").strip(), local_day_start(now, tz))
    metrics, new_state = build_metrics(cfg, now, state, server_lines)

    if args.stdout:
        json.dump(metrics, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
        print()
        return 0
    atomic_write_json(state_path, new_state, mode=0o600)
    atomic_write_json(cfg["output"], metrics, mode=0o644)
    push_metrics(cfg, metrics)
    return 0


if __name__ == "__main__":
    sys.exit(main())
