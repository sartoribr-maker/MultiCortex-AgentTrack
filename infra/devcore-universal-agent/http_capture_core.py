#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DevCore passive HTTP request logger.

Observes (read-only) the HTTP/1.1 traffic that reaches llama.cpp on the VM
(tcpdump copy of the packets, never in the traffic path) and writes one line
per request in the same format the metrics agent reads from nginx:

  <ts> <client_ip> "<METHOD> <uri>" <status> <bytes> rt=<s> urt=<s> uht=<s> host=<host>

client_ip comes from X-Forwarded-For (set by the Apache gateway) and host from
X-Forwarded-Host. Only request/response HEADERS are parsed; prompt and answer
bodies are skipped byte by byte and never stored or logged.

Since 1.3 it also publishes a live snapshot every few seconds (live.json and a
push to <push_url>/live): developers online, requests in progress and GPU use
right now. The snapshot carries counts only, never IP addresses.

Since 1.4, write_samples = true also appends each snapshot to daily
samples.csv-YYYYMMDD files (GPU + requests in progress), for hosts without the
original POC sampler (e.g. a RunPod container).

Compatible with Python 3.6, standard library only.
"""
from __future__ import print_function

import argparse
import collections
import configparser
import glob
import io
import json
import os
import re
import signal
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

CAPTURE_VERSION = "1.4.0"
UTC = timezone.utc
MAX_HEADER_BYTES = 64 * 1024
MAX_OOO_SEGMENTS = 256
IDLE_TIMEOUT_S = 3600
# A request open for longer than this lost its end (missed packets): not "in progress".
STUCK_AFTER_S = 1800
DEFAULTS = {
    "port": "7080",
    # Loopback is excluded: the VM's own nginx/tests talk to llama.cpp locally.
    "bpf_extra": "not net 127.0.0.0/8",
    "log_dir": "/var/log/devcore-poc",
    "log_prefix": "requests-",
    "retention_days": "60",
    "interface": "any",
    # Live snapshot: written/pushed every live_interval_s; a developer is online
    # with a request in progress or a successful API call in the last online_window_s.
    "live_interval_s": "10",
    "online_window_s": "300",
    "live_output": "/var/lib/devcore-metrics/live.json",
    # true = append every snapshot to <log_dir>/samples.csv-YYYYMMDD (agent's
    # samples_glob). Only for hosts without the original POC sampler.
    "write_samples": "false",
}
# Shared with the metrics agent ([agent] section of agent.conf and push.conf).
AGENT_KEYS = {
    "devcore_hosts": "devcore01.multicortex.com.br",
    "slots": "8",
    "api_prefix": "/v1/",
    "push_url": "",
    "push_token_file": "/etc/devcore-metrics/push.token",
}

METHODS = (b"GET", b"POST", b"PUT", b"DELETE", b"HEAD", b"OPTIONS", b"PATCH")
SAFE_URI = re.compile(r"[^A-Za-z0-9/._~%-]")


# --------------------------------------------------------------------------
# HTTP/1.1 message framing (headers parsed, bodies only counted)
# --------------------------------------------------------------------------

class BodyReader(object):
    """Consumes a message body; returns leftover bytes after the body ends."""

    def __init__(self, length=None, chunked=False, until_close=False):
        self.remaining = length
        self.chunked = chunked
        self.until_close = until_close
        self.size_line = b""
        self.state = "size"          # chunked: size -> data -> crlf -> ... -> trailer
        self.chunk_left = 0
        self.trailer = b""
        self.body_bytes = 0
        self.done = (not chunked and not until_close and (length or 0) == 0)

    def feed(self, data):
        if self.done:
            return data
        if self.until_close:
            self.body_bytes += len(data)
            return b""
        if not self.chunked:
            take = min(self.remaining, len(data))
            self.remaining -= take
            self.body_bytes += take
            if self.remaining == 0:
                self.done = True
            return data[take:]
        i = 0
        n = len(data)
        while i < n and not self.done:
            if self.state == "size":
                j = data.find(b"\n", i)
                if j < 0:
                    self.size_line += data[i:]
                    if len(self.size_line) > 1024:
                        raise ValueError("chunk size line too long")
                    return b""
                line = (self.size_line + data[i:j]).strip()
                self.size_line = b""
                i = j + 1
                size = int(line.split(b";", 1)[0] or b"0", 16)
                if size == 0:
                    self.state = "trailer"
                else:
                    self.chunk_left = size
                    self.state = "data"
            elif self.state == "data":
                take = min(self.chunk_left, n - i)
                self.chunk_left -= take
                self.body_bytes += take
                i += take
                if self.chunk_left == 0:
                    self.state = "crlf"
                    self.chunk_left = 2
            elif self.state == "crlf":
                take = min(self.chunk_left, n - i)
                self.chunk_left -= take
                i += take
                if self.chunk_left == 0:
                    self.state = "size"
            else:  # trailer: lines until an empty one
                self.trailer += data[i:]
                i = n
                end = self.trailer.find(b"\r\n")
                while end >= 0:
                    line, self.trailer = self.trailer[:end], self.trailer[end + 2:]
                    if line == b"":
                        self.done = True
                        return self.trailer
                    end = self.trailer.find(b"\r\n")
                if len(self.trailer) > MAX_HEADER_BYTES:
                    raise ValueError("trailer too long")
        return data[i:] if self.done else b""


def parse_headers(block):
    lines = block.split(b"\r\n")
    start = lines[0].decode("latin-1")
    headers = {}
    for line in lines[1:]:
        if b":" not in line:
            continue
        name, value = line.split(b":", 1)
        key = name.strip().lower().decode("latin-1")
        val = value.strip().decode("latin-1")
        headers[key] = (headers[key] + ", " + val) if key in headers else val
    return start, headers


def body_for(headers, method=None, status=None, is_response=False):
    if is_response and (method == "HEAD" or status in (204, 304) or 100 <= (status or 0) < 200):
        return BodyReader(length=0)
    if "chunked" in headers.get("transfer-encoding", "").lower():
        return BodyReader(chunked=True)
    if "content-length" in headers:
        try:
            return BodyReader(length=max(0, int(headers["content-length"].split(",")[0])))
        except ValueError:
            raise ValueError("bad content-length")
    return BodyReader(until_close=True) if is_response else BodyReader(length=0)


class Stream(object):
    """One direction of a TCP connection, parsed as a sequence of HTTP messages.

    At every message boundary anything that does not start like an HTTP message
    is skipped, so joining a connection mid-body (capture restart) or losing a
    segment only costs the message in flight, never the following ones."""

    def __init__(self, is_response, on_headers, on_complete, on_first_body=None, on_start=None):
        self.is_response = is_response
        self.on_start = on_start
        self.on_headers = on_headers
        self.on_complete = on_complete
        self.on_first_body = on_first_body
        self.markers = (b"HTTP/1.",) if is_response else tuple(m + b" " for m in METHODS)
        self.buf = b""
        self.body = None

    def resync(self):
        self.buf = b""
        self.body = None

    def _message_start(self, data):
        positions = [p for p in (data.find(m) for m in self.markers) if p >= 0]
        return min(positions) if positions else -1

    def feed(self, data, ts):
        while data:
            if self.body is not None:
                before = self.body.body_bytes
                data = self.body.feed(data)
                if before == 0 and self.body.body_bytes > 0 and self.on_first_body:
                    self.on_first_body(ts)
                if self.body.done:
                    body, self.body = self.body, None
                    self.on_complete(ts, body.body_bytes)
                continue
            if not self.buf:
                start = self._message_start(data)
                if start < 0:
                    return
                data = data[start:]
                if self.on_start:
                    self.on_start(ts)
            self.buf += data
            data = b""
            end = self.buf.find(b"\r\n\r\n")
            if end < 0:
                if len(self.buf) > MAX_HEADER_BYTES:
                    self.resync()
                return
            block, data = self.buf[:end], self.buf[end + 4:]
            self.buf = b""
            try:
                start_line, headers = parse_headers(block)
                self.body = self.on_headers(start_line, headers, ts)
            except ValueError:
                # Not a real message start (e.g. "HTTP/1.1" inside old body text):
                # look for the next candidate right after this one.
                data = (block + b"\r\n\r\n" + data)[1:]
                continue
            if self.body is None:  # e.g. 100 Continue: no body, next headers follow
                continue
            if self.body.done:
                body, self.body = self.body, None
                self.on_complete(ts, 0)


# --------------------------------------------------------------------------
# Connections: pair requests with responses
# --------------------------------------------------------------------------

class Connection(object):
    def __init__(self, client_ip, sink):
        self.client_ip = client_ip
        self.sink = sink
        self.pending = collections.deque()   # requests waiting for (or receiving) a response
        self.current = None                  # request whose response is being read
        self.last_seen = 0.0
        self.closed = False
        self.request_stream = Stream(False, self._request_headers, self._request_complete,
                                     on_start=self._request_begins)
        self.response_stream = Stream(True, self._response_headers, self._response_complete, self._first_body)
        self._request_start = None

    # request side
    def _request_headers(self, start, headers, ts):
        parts = start.split(" ")
        if len(parts) < 3 or not parts[2].startswith("HTTP/1."):
            raise ValueError("bad request line")
        forwarded = headers.get("x-forwarded-for", "").split(",")[0].strip()
        host = headers.get("x-forwarded-host", "").split(",")[0].strip() or headers.get("host", "-")
        request = {
            "start": self._request_start if self._request_start is not None else ts,
            "method": parts[0],
            "uri": SAFE_URI.sub("", parts[1].split("?", 1)[0])[:200] or "/",
            "ip": forwarded if forwarded and " " not in forwarded else self.client_ip,
            "host": re.sub(r"[^A-Za-z0-9.:-]", "", host)[:120] or "-",
            "ttfb": None,
            "status": None,
        }
        self._request_start = None
        self.pending.append(request)
        return body_for(headers)

    def _request_complete(self, ts, nbytes):
        pass

    # response side
    def _response_headers(self, start, headers, ts):
        parts = start.split(" ")
        if len(parts) < 2 or not parts[1].isdigit():
            raise ValueError("bad status line")
        status = int(parts[1])
        if self.current is None:
            if not self.pending:
                raise ValueError("response without request")
            self.current = self.pending.popleft()
        if 100 <= status < 200 and status != 101:
            return None  # interim response; the final one follows
        self.current["status"] = status
        return body_for(headers, self.current["method"], status, is_response=True)

    def _first_body(self, ts):
        # Time to the first body byte: with streaming, the first token. llama.cpp
        # sends the headers right away, so the header time would always be ~0.
        if self.current is not None and self.current["ttfb"] is None:
            self.current["ttfb"] = max(0.0, ts - self.current["start"])

    def _response_complete(self, ts, nbytes):
        request, self.current = self.current, None
        if request is not None:
            if request["ttfb"] is None:
                request["ttfb"] = max(0.0, ts - request["start"])
            self.sink.write(request, ts, request["status"], nbytes)

    def _request_begins(self, ts):
        # First byte of the request line: rt and uht are measured from here.
        self._request_start = ts

    def open_requests(self):
        """Requests sent and not yet answered completely (being served or queued)."""
        if self.closed:
            return []
        return ([self.current] if self.current is not None else []) + list(self.pending)

    def close(self, ts, by_client):
        """Connection ended (FIN/RST) or went idle."""
        if self.closed:
            return
        self.closed = True
        body = self.response_stream.body
        if self.current is not None and body is not None and body.until_close and not by_client:
            self._response_complete(ts, body.body_bytes)
        aborted = []
        if self.current is not None:
            aborted.append((self.current, body.body_bytes if body is not None else 0))
            self.current = None
        aborted.extend((r, 0) for r in self.pending)
        self.pending.clear()
        for request, nbytes in aborted:
            # Client gave up (gateway closed) = 499, as nginx logs it; server side = 502.
            self.sink.write(request, ts, 499 if by_client else 502, nbytes)


# --------------------------------------------------------------------------
# TCP reassembly
# --------------------------------------------------------------------------

class Direction(object):
    def __init__(self):
        self.next_seq = None
        self.ooo = {}


class FlowTable(object):
    def __init__(self, port, sink):
        self.port = port
        self.sink = sink
        self.flows = {}
        self.last_sweep = 0.0
        # The live publisher thread reads the flows while packets arrive.
        self.lock = threading.Lock()

    def packet(self, ts, src, sport, dst, dport, seq, flags, payload):
        with self.lock:
            self._packet(ts, src, sport, dst, dport, seq, flags, payload)

    def _packet(self, ts, src, sport, dst, dport, seq, flags, payload):
        if dport == self.port:
            key, to_server = (src, sport, dst, dport), True
        elif sport == self.port:
            key, to_server = (dst, dport, src, sport), False
        else:
            return
        syn, fin, rst = flags & 0x02, flags & 0x01, flags & 0x04
        flow = self.flows.get(key)
        if flow is None or (syn and to_server and flow[0].closed):
            if flow is not None:
                flow[0].close(ts, by_client=True)
            flow = (Connection(key[0], self.sink), Direction(), Direction())
            self.flows[key] = flow
        conn, up, down = flow
        conn.last_seen = ts
        if conn.closed:
            return  # late packets after FIN/RST
        direction = up if to_server else down
        stream = conn.request_stream if to_server else conn.response_stream
        if syn:
            direction.next_seq = (seq + 1) & 0xFFFFFFFF
        elif payload:
            self._deliver(conn, direction, stream, to_server, seq, payload, ts)
        if fin or rst:
            conn.close(ts, by_client=to_server)
        if ts - self.last_sweep > 60:
            self.sweep(ts)

    def _deliver(self, conn, direction, stream, to_server, seq, payload, ts):
        if direction.next_seq is None:
            direction.next_seq = seq          # joined mid-connection
        offset = (seq - direction.next_seq) & 0xFFFFFFFF
        if offset >= 0x80000000:              # starts before next_seq: retransmission/overlap
            overlap = (direction.next_seq - seq) & 0xFFFFFFFF
            if overlap >= len(payload):
                return
            payload = payload[overlap:]
            offset = 0
        if offset > 0:                        # gap: keep for later
            direction.ooo[seq] = payload
            if len(direction.ooo) > MAX_OOO_SEGMENTS:
                direction.ooo.clear()         # lost data: drop the stream state
                direction.next_seq = None
                stream.resync()
            return
        self._feed(conn, stream, to_server, payload, ts)
        direction.next_seq = (direction.next_seq + len(payload)) & 0xFFFFFFFF
        while direction.next_seq in direction.ooo:
            data = direction.ooo.pop(direction.next_seq)
            self._feed(conn, stream, to_server, data, ts)
            direction.next_seq = (direction.next_seq + len(data)) & 0xFFFFFFFF

    @staticmethod
    def _feed(conn, stream, to_server, data, ts):
        try:
            stream.feed(data, ts)
        except ValueError:
            stream.resync()

    def sweep(self, ts):
        self.last_sweep = ts
        for key, flow in list(self.flows.items()):
            idle = ts - flow[0].last_seen
            if (flow[0].closed and idle > 120) or idle > IDLE_TIMEOUT_S:
                flow[0].pending.clear()
                flow[0].current = None
                del self.flows[key]


# --------------------------------------------------------------------------
# pcap stream decoding
# --------------------------------------------------------------------------

LINKTYPES = {1: "ether", 113: "sll", 276: "sll2", 0: "null", 101: "raw", 12: "raw"}


def decode_ip(frame, ltype):
    if ltype == "ether":
        if len(frame) < 14:
            return None
        proto, off = struct.unpack("!H", frame[12:14])[0], 14
        while proto in (0x8100, 0x88A8) and len(frame) >= off + 4:
            proto, off = struct.unpack("!H", frame[off + 2:off + 4])[0], off + 4
    elif ltype == "sll":
        if len(frame) < 16:
            return None
        proto, off = struct.unpack("!H", frame[14:16])[0], 16
    elif ltype == "sll2":
        if len(frame) < 20:
            return None
        proto, off = struct.unpack("!H", frame[0:2])[0], 20
    elif ltype == "null":
        proto, off = None, 4
    else:
        proto, off = None, 0
    ip = frame[off:]
    if not ip:
        return None
    version = ip[0] >> 4
    if proto not in (None, 0x0800, 0x86DD):
        return None
    if version == 4 and len(ip) >= 20:
        ihl = (ip[0] & 0x0F) * 4
        total = struct.unpack("!H", ip[2:4])[0]
        if ip[9] != 6:
            return None
        return socket.inet_ntop(socket.AF_INET, ip[12:16]), socket.inet_ntop(socket.AF_INET, ip[16:20]), ip[ihl:total]
    if version == 6 and len(ip) >= 40:
        if ip[6] != 6:
            return None  # extension headers are not used on this path
        plen = struct.unpack("!H", ip[4:6])[0]
        return socket.inet_ntop(socket.AF_INET6, ip[8:24]), socket.inet_ntop(socket.AF_INET6, ip[24:40]), ip[40:40 + plen]
    return None


def decode_tcp(segment):
    if len(segment) < 20:
        return None
    sport, dport, seq = struct.unpack("!HHI", segment[:8])
    off = (segment[12] >> 4) * 4
    flags = segment[13]
    return sport, dport, seq, flags, segment[off:]


def read_exact(stream, n):
    data = b""
    while len(data) < n:
        chunk = stream.read(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def iter_pcap(stream):
    header = read_exact(stream, 24)
    if header is None:
        return
    magic = header[:4]
    if magic in (b"\xd4\xc3\xb2\xa1", b"\x4d\x3c\xb2\xa1"):
        endian = "<"
    elif magic in (b"\xa1\xb2\xc3\xd4", b"\xa1\xb2\x3c\x4d"):
        endian = ">"
    else:
        raise ValueError("not a pcap stream")
    nano = magic in (b"\x4d\x3c\xb2\xa1", b"\xa1\xb2\x3c\x4d")
    linktype = struct.unpack(endian + "I", header[20:24])[0] & 0x0FFFFFFF
    ltype = LINKTYPES.get(linktype)
    if ltype is None:
        raise ValueError("unsupported link type %d" % linktype)
    while True:
        record = read_exact(stream, 16)
        if record is None:
            return
        sec, frac, incl, _orig = struct.unpack(endian + "IIII", record)
        frame = read_exact(stream, incl)
        if frame is None:
            return
        yield sec + frac / (1e9 if nano else 1e6), ltype, frame


def process_pcap(stream, table):
    for ts, ltype, frame in iter_pcap(stream):
        ip = decode_ip(frame, ltype)
        if ip is None:
            continue
        src, dst, segment = ip
        tcp = decode_tcp(segment)
        if tcp is None:
            continue
        sport, dport, seq, flags, payload = tcp
        table.packet(ts, src, sport, dst, dport, seq, flags, payload)


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------

class LogSink(object):
    """Daily files (UTC) requests-YYYYMMDD.log, with retention."""

    def __init__(self, log_dir, prefix, retention_days):
        self.log_dir = log_dir
        self.prefix = prefix
        self.retention_days = retention_days
        self.day = None
        self.handle = None

    @staticmethod
    def format(request, ts, status, nbytes):
        end = datetime.fromtimestamp(ts, UTC).replace(microsecond=0)
        rt = max(0.0, ts - request["start"])
        ttfb = request["ttfb"]
        return '%s %s "%s %s" %d %d rt=%.3f urt=%.3f uht=%s host=%s\n' % (
            end.isoformat(), request["ip"] or "-", request["method"], request["uri"],
            status or 0, nbytes, rt, rt, "%.3f" % ttfb if ttfb is not None else "-", request["host"],
        )

    def write(self, request, ts, status, nbytes):
        day = datetime.fromtimestamp(ts, UTC).strftime("%Y%m%d")
        if day != self.day:
            self._rotate(day)
        self.handle.write(self.format(request, ts, status, nbytes))
        self.handle.flush()

    def _rotate(self, day):
        if self.handle:
            self.handle.close()
        self.day = day
        path = os.path.join(self.log_dir, "%s%s.log" % (self.prefix, day))
        self.handle = io.open(path, "a", encoding="utf-8")
        os.chmod(path, 0o640)
        limit = (datetime.now(UTC) - timedelta(days=self.retention_days)).strftime("%Y%m%d")
        for old in glob.glob(os.path.join(self.log_dir, self.prefix + "*.log")):
            stamp = os.path.basename(old)[len(self.prefix):-4]
            if stamp.isdigit() and stamp < limit:
                os.unlink(old)


class SampleSink(object):
    """Daily files (UTC) samples.csv-YYYYMMDD in the agent's sample format:
    ts,gpu_util,gpu_mem_mb,conn_site,conn_devcore,slots_busy. Here conn_site and
    conn_devcore are the POSTs in progress (other hosts / DevCore)."""

    PREFIX = "samples.csv-"

    def __init__(self, log_dir, retention_days):
        self.log_dir = log_dir
        self.retention_days = retention_days

    @staticmethod
    def format(snapshot):
        gpu, inflight = snapshot["gpu"], snapshot["inflight"]
        cell = lambda v: "" if v is None else str(v)
        return "%s,%s,%s,%d,%d,%d\n" % (
            snapshot["generated_at"], cell(gpu["util"]), cell(gpu["mem_mb"]),
            inflight["other"], inflight["devcore"], inflight["other"] + inflight["devcore"],
        )

    def write(self, snapshot, now):
        day = datetime.fromtimestamp(now, UTC).strftime("%Y%m%d")
        path = os.path.join(self.log_dir, self.PREFIX + day)
        if not os.path.exists(path):
            limit = (datetime.fromtimestamp(now, UTC) - timedelta(days=self.retention_days)).strftime("%Y%m%d")
            for old in glob.glob(os.path.join(self.log_dir, self.PREFIX + "*")):
                stamp = os.path.basename(old)[len(self.PREFIX):]
                if stamp.isdigit() and stamp < limit:
                    os.unlink(old)
        with io.open(path, "a", encoding="utf-8") as handle:
            handle.write(self.format(snapshot))


# --------------------------------------------------------------------------
# Live snapshot (what is happening right now)
# --------------------------------------------------------------------------

LOG_LINE_RE = re.compile(r'^(\S+) (\S+) "(\S+) (\S*)" (\d{3}) .* host=(\S+)\s*$')


def is_loopback(ip):
    return ip.startswith("127.") or ip in ("::1", "localhost", "-")


class LiveState(object):
    """Who is using DevCore right now. Holds developer IPs in memory only;
    snapshot() returns counts."""

    def __init__(self, devcore_hosts, api_prefix="/v1/", window_s=300):
        self.devcore_hosts = devcore_hosts
        self.api_prefix = api_prefix
        self.window_s = window_s
        self.last_ok = {}  # developer IP -> end of its last successful API call

    def is_devcore(self, request):
        return request["host"].split(":")[0].lower() in self.devcore_hosts

    def is_developer_call(self, request):
        # Same rule as the agent's "developers": DevCore host, API path, not the VM itself.
        return (self.is_devcore(request) and request["uri"].startswith(self.api_prefix)
                and not is_loopback(request["ip"] or "-"))

    def record(self, request, ts, status):
        if 200 <= (status or 0) < 300 and self.is_developer_call(request):
            self.last_ok[request["ip"]] = max(ts, self.last_ok.get(request["ip"], 0))

    def seed(self, log_dir, prefix, now):
        """After a restart, recover the recent activity from the request logs."""
        since = now - self.window_s
        for day in sorted(set(datetime.fromtimestamp(t, UTC).strftime("%Y%m%d") for t in (since, now))):
            for line in iter_text(os.path.join(log_dir, "%s%s.log" % (prefix, day))):
                m = LOG_LINE_RE.match(line)
                if not m:
                    continue
                try:
                    ts = datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S+00:00").replace(tzinfo=UTC).timestamp()
                except ValueError:
                    continue
                if since <= ts <= now:
                    request = {"ip": m.group(2), "method": m.group(3), "uri": m.group(4), "host": m.group(6)}
                    self.record(request, ts, int(m.group(5)))

    def snapshot(self, flows, now):
        since = now - self.window_s
        for ip in [ip for ip, ts in self.last_ok.items() if ts < since]:
            del self.last_ok[ip]
        inflight = {"devcore": 0, "other": 0}
        busy = set()
        for conn, _up, _down in flows.values():
            for request in conn.open_requests():
                # Only POSTs occupy a llama.cpp slot (same rule as the agent).
                if request["method"] != "POST" or now - request["start"] > STUCK_AFTER_S:
                    continue
                inflight["devcore" if self.is_devcore(request) else "other"] += 1
                if self.is_developer_call(request):
                    busy.add(request["ip"])
        return {
            "developers": {"online": len(busy | set(self.last_ok)), "active": len(busy)},
            "inflight": inflight,
        }


class LiveSink(object):
    """Log sink wrapper that also feeds the live state."""

    def __init__(self, sink, live):
        self.sink = sink
        self.live = live

    def write(self, request, ts, status, nbytes):
        self.live.record(request, ts, status)
        self.sink.write(request, ts, status, nbytes)


def iter_text(path):
    try:
        with io.open(path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                yield line
    except (IOError, OSError):
        return


def gpu_now():
    """GPU use at this moment (all GPUs); None values when nvidia-smi fails."""
    result = {"util": None, "mem_mb": None, "mem_mb_total": None}
    try:
        proc = subprocess.Popen(
            ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True,
        )
        out, _ = proc.communicate(timeout=5)
        rows = [[float(v) for v in line.split(",")] for line in out.splitlines() if line.strip()]
    except Exception:  # missing, hung or "[N/A]": the card shows "—"
        return result
    if rows and all(len(r) == 3 for r in rows):
        result["util"] = round(sum(r[0] for r in rows) / len(rows), 1)
        result["mem_mb"] = int(sum(r[1] for r in rows))
        result["mem_mb_total"] = int(sum(r[2] for r in rows))
    return result


def build_live(cfg, counts, now, gpu):
    return {
        "schema": 1,
        "kind": "live",
        "capture_version": CAPTURE_VERSION,
        "generated_at": datetime.fromtimestamp(int(now), UTC).isoformat().replace("+00:00", "Z"),
        "slots": cfg["slots"],
        "window_s": cfg["online_window_s"],
        "developers": counts["developers"],
        "inflight": counts["inflight"],
        "gpu": gpu,
    }


def write_json(path, data):
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(data, handle, separators=(",", ":"), sort_keys=True)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def push_live(cfg, snapshot, opener=None):
    """POST the snapshot to <push_url>/live. Returns the HTTP status, or None
    when push is disabled or failed (the next snapshot replaces this one)."""
    url = cfg.get("push_url", "").strip().rstrip("/")
    if not url:
        return None
    if not (url.startswith("https://") or url.startswith("http://127.0.0.1") or url.startswith("http://localhost")):
        raise ValueError("push_url deve usar https")
    with io.open(cfg["push_token_file"], "r", encoding="utf-8") as handle:
        token = handle.read().strip()
    request = urllib.request.Request(url + "/live", data=json.dumps(snapshot, separators=(",", ":")).encode("utf-8"),
                                     method="POST", headers={
                                         "Content-Type": "application/json",
                                         "Authorization": "Bearer " + token,
                                         "User-Agent": "devcore-capture/" + CAPTURE_VERSION,
                                     })
    open_url = opener or (lambda req: urllib.request.urlopen(req, timeout=8, context=ssl.create_default_context()))
    try:
        with open_url(request) as response:
            return response.status if hasattr(response, "status") else response.getcode()
    except urllib.error.HTTPError as error:
        return error.code


class LivePublisher(threading.Thread):
    """Every live_interval_s: snapshot under the table lock, then write and push
    outside it, so a slow network never delays packet processing."""

    def __init__(self, cfg, table, live):
        super(LivePublisher, self).__init__(name="live", daemon=True)
        self.cfg = cfg
        self.table = table
        self.live = live
        self.stopping = threading.Event()
        self.last_problem = None
        self.samples = SampleSink(cfg["log_dir"], cfg["retention_days"]) if cfg["write_samples"] else None

    def publish(self, now):
        with self.table.lock:
            counts = self.live.snapshot(self.table.flows, now)
        snapshot = build_live(self.cfg, counts, now, gpu_now())
        if self.cfg["live_output"]:
            write_json(self.cfg["live_output"], snapshot)
        if self.samples:
            self.samples.write(snapshot, now)
        status = push_live(self.cfg, snapshot)
        return snapshot, status

    def run(self):
        while not self.stopping.wait(self.cfg["live_interval_s"]):
            try:
                _, status = self.publish(time.time())
                problem = None if status in (None, 204) else "push: HTTP %d" % status
            except Exception as error:  # never stops the capture
                problem = "live: %s" % type(error).__name__
            # Log only changes: a site outage must not flood the journal.
            if problem != self.last_problem:
                print(problem or "live: envio normalizado", file=sys.stderr)
                self.last_problem = problem


def load_config(path):
    parser = configparser.ConfigParser()
    parser.read_dict({"capture": DEFAULTS, "agent": AGENT_KEYS})
    if path and os.path.exists(path):
        # push.conf (written by install.sh --push-url) sits next to agent.conf.
        parser.read([path, os.path.join(os.path.dirname(path), "push.conf")])
    section = parser["capture"]
    cfg = dict(section)
    for key in ("port", "retention_days", "live_interval_s", "online_window_s"):
        cfg[key] = int(section[key])
    cfg["write_samples"] = section.getboolean("write_samples")
    agent = parser["agent"]
    cfg["devcore_hosts"] = set(h.strip().lower() for h in agent.get("devcore_hosts", "").split(",") if h.strip())
    cfg["slots"] = int(agent.get("slots", AGENT_KEYS["slots"]))
    for key in ("api_prefix", "push_url", "push_token_file"):
        cfg[key] = agent.get(key, AGENT_KEYS[key])
    return cfg


def bpf_filter(cfg):
    expression = "tcp port %d" % cfg["port"]
    if cfg["bpf_extra"].strip():
        expression += " and (%s)" % cfg["bpf_extra"].strip()
    return expression


def main(argv=None):
    parser = argparse.ArgumentParser(description="DevCore passive HTTP request logger")
    parser.add_argument("--config", default="/etc/devcore-metrics/agent.conf")
    parser.add_argument("--read", help="parse a pcap file instead of live capture (tests)")
    args = parser.parse_args(argv)
    cfg = load_config(args.config)
    os.makedirs(cfg["log_dir"], exist_ok=True)
    log_sink = LogSink(cfg["log_dir"], cfg["log_prefix"], cfg["retention_days"])
    live = LiveState(cfg["devcore_hosts"], cfg["api_prefix"], cfg["online_window_s"])
    table = FlowTable(cfg["port"], LiveSink(log_sink, live))

    if args.read:
        with open(args.read, "rb") as handle:
            process_pcap(handle, table)
        return 0

    live.seed(cfg["log_dir"], cfg["log_prefix"], time.time())
    LivePublisher(cfg, table, live).start()

    # -p: no promiscuous mode; -U/-w -: packet-buffered pcap on stdout (never on disk).
    command = ["tcpdump", "-i", cfg["interface"], "-p", "-n", "-U", "-s", "0", "-w", "-", bpf_filter(cfg)]
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=sys.stderr)
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: (stopping.append(1), proc.terminate()))
    try:
        process_pcap(proc.stdout, table)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
    # tcpdump ended on its own: non-zero so systemd restarts us.
    return 0 if stopping else 1


if __name__ == "__main__":
    sys.exit(main())
