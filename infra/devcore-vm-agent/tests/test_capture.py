# -*- coding: utf-8 -*-
"""Tests for the passive HTTP request logger (synthetic pcap streams).

Run: python3 -m unittest discover -s infra/devcore-vm-agent/tests -v
"""
import io
import json
import os
import shutil
import socket
import struct
import sys
import tempfile
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import devcore_http_capture as cap  # noqa: E402
import devcore_metrics_agent as agent  # noqa: E402

UTC = timezone.utc
GATEWAY, VM = "35.168.36.211", "10.0.0.5"
T0 = datetime(2026, 10, 13, 12, 0, tzinfo=timezone.utc).timestamp()  # 09:00 in Brasilia
SYN, FIN, ACK, RST, PSH = 0x02, 0x01, 0x10, 0x04, 0x08

REQUEST = (
    b"POST /v1/chat/completions HTTP/1.1\r\n"
    b"Host: 201.23.87.153:7080\r\n"
    b"X-Forwarded-For: 189.36.225.60, 10.1.1.1\r\n"
    b"X-Forwarded-Host: devcore01.multicortex.com.br\r\n"
    b"Content-Type: application/json\r\n"
)
SECRET_PROMPT = b'{"messages":[{"role":"user","content":"SEGREDO-DO-CLIENTE HTTP/1.1 200 OK"}],"stream":true}'


def request(body=SECRET_PROMPT, extra=b""):
    return REQUEST + extra + b"Content-Length: %d\r\n\r\n" % len(body) + body


def chunk(data):
    return b"%x\r\n" % len(data) + data + b"\r\n"


class Pcap(object):
    """Builds a LINUX_SLL pcap stream for one or more TCP connections."""

    def __init__(self, linktype=113):
        self.linktype = linktype
        self.out = io.BytesIO()
        self.out.write(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, linktype))
        self.seq = {}

    def _frame(self, src, dst, sport, dport, seq, flags, payload):
        tcp = struct.pack("!HHIIBBHHH", sport, dport, seq, 0, 5 << 4, flags, 65535, 0, 0) + payload
        ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(tcp), 0, 0, 64, 6, 0,
                         socket.inet_aton(src), socket.inet_aton(dst)) + tcp
        if self.linktype == 113:
            return struct.pack("!HHH8sH", 0, 1, 6, b"\0" * 8, 0x0800) + ip
        return struct.pack("!HHIHBB8s", 0x0800, 0, 2, 1, 0, 6, b"\0" * 8) + ip  # SLL2

    def packet(self, ts, to_server, payload=b"", flags=ACK | PSH, port=50000, seq=None, advance=True):
        key = (port, to_server)
        current = self.seq.setdefault(key, 1000 if to_server else 9000)
        use = current if seq is None else seq
        if to_server:
            frame = self._frame(GATEWAY, VM, port, 7080, use, flags, payload)
        else:
            frame = self._frame(VM, GATEWAY, 7080, port, use, flags, payload)
        sec, usec = int(ts), int(round((ts - int(ts)) * 1e6))
        self.out.write(struct.pack("<IIII", sec, usec, len(frame), len(frame)) + frame)
        if advance and seq is None:
            self.seq[key] = current + len(payload) + (1 if flags & (SYN | FIN) else 0)
        return use

    def handshake(self, ts, port=50000):
        self.packet(ts, True, flags=SYN, port=port)
        self.packet(ts, False, flags=SYN | ACK, port=port)

    def run(self):
        sink = Memory()
        table = cap.FlowTable(7080, sink)
        cap.process_pcap(io.BytesIO(self.out.getvalue()), table)
        return sink


class Memory(object):
    def __init__(self):
        self.lines = []

    def write(self, request, ts, status, nbytes):
        self.lines.append(cap.LogSink.format(request, ts, status, nbytes))


class CaptureTest(unittest.TestCase):
    def test_streaming_request_line_and_privacy(self):
        p = Pcap()
        p.handshake(T0)
        data = request()
        p.packet(T0 + 0.01, True, data[:60])
        p.packet(T0 + 0.02, True, data[60:])
        p.packet(T0 + 0.05, False, b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
        p.packet(T0 + 0.81, False, chunk(b"data: {\"x\":1}\n\n"))
        p.packet(T0 + 2.00, False, chunk(b"data: {\"x\":2}\n\n") + chunk(b"data: [DONE]\n\n"))
        p.packet(T0 + 3.01, False, b"0\r\n\r\n")
        lines = p.run().lines
        self.assertEqual(len(lines), 1)
        line = lines[0]
        self.assertTrue(line.startswith('2026-10-13T12:00:03+00:00 189.36.225.60 "POST /v1/chat/completions" 200 44 '), line)
        self.assertIn("rt=3.000", line)
        self.assertIn("uht=0.800", line)  # first token, not the immediate headers
        self.assertIn("host=devcore01.multicortex.com.br", line)
        self.assertNotIn("SEGREDO", line)
        record = agent.parse_access_line(line)  # the agent reads it as an nginx line
        self.assertEqual((record["status"], record["rt"], record["uht"], record["host"]),
                         (200, 3.0, 0.8, "devcore01.multicortex.com.br"))

    def test_keepalive_two_requests_and_content_length(self):
        p = Pcap()
        p.handshake(T0)
        p.packet(T0 + 1, True, request(b'{"a":1}'))
        p.packet(T0 + 2, False, b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello")
        p.packet(T0 + 3, True, request(b'{"a":2}'))
        p.packet(T0 + 3.5, False, b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 3\r\n\r\n")
        p.packet(T0 + 4, False, b"bye")
        lines = p.run().lines
        self.assertEqual(len(lines), 2)
        self.assertIn('" 200 5 rt=1.000', lines[0])
        self.assertIn('" 503 3 rt=1.000', lines[1])

    def test_client_abort_is_499_and_server_reset_is_502(self):
        p = Pcap()
        p.handshake(T0, port=50001)
        p.packet(T0 + 1, True, request(), port=50001)
        p.packet(T0 + 1.2, False, b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" + chunk(b"data: 1\n\n"), port=50001)
        p.packet(T0 + 5, True, flags=FIN | ACK, port=50001)
        p.packet(T0 + 5.1, False, chunk(b"late"), port=50001)  # ignored after close
        p.handshake(T0 + 10, port=50002)
        p.packet(T0 + 10, True, request(), port=50002)
        p.packet(T0 + 11, False, flags=RST, port=50002)
        lines = p.run().lines
        self.assertEqual(len(lines), 2)
        self.assertIn('" 499 9 rt=4.000', lines[0])
        self.assertIn('" 502 0 rt=1.000', lines[1])

    def test_retransmission_and_out_of_order_segments(self):
        p = Pcap()
        p.handshake(T0)
        data = request()
        first = p.packet(T0 + 0.1, True, data[:50], advance=False)
        p.packet(T0 + 0.2, True, data[50:], seq=first + 50)      # arrives before the first part
        p.packet(T0 + 0.3, True, data[:50], seq=first)          # first part
        p.packet(T0 + 0.4, True, data[:50], seq=first)          # duplicate retransmission
        p.seq[(50000, True)] = first + len(data)
        p.packet(T0 + 1, False, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
        lines = p.run().lines
        self.assertEqual(len(lines), 1)
        self.assertIn('" 200 2 ', lines[0])

    def test_joins_mid_connection_and_ignores_garbage(self):
        p = Pcap()
        # No handshake: capture started while the connection was open, mid-body.
        p.packet(T0, True, b"tail of a previous prompt body ... }")
        p.packet(T0 + 0.1, False, b"...rest of an old response HTTP/1.1 ignored")
        p.packet(T0 + 1, True, request())
        p.packet(T0 + 2, False, b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
        lines = p.run().lines
        self.assertEqual(len(lines), 1)
        self.assertIn('" 200 0 rt=1.000', lines[0])

    def test_interim_100_continue_and_sll2(self):
        p = Pcap(linktype=276)
        p.handshake(T0)
        p.packet(T0 + 1, True, request(extra=b"Expect: 100-continue\r\n"))
        p.packet(T0 + 1.1, False, b"HTTP/1.1 100 Continue\r\n\r\n")
        p.packet(T0 + 2, False, b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx")
        lines = p.run().lines
        self.assertEqual(len(lines), 1)
        self.assertIn('" 200 1 rt=1.000', lines[0])

    def test_missing_forwarded_headers_fall_back_to_tcp_peer(self):
        p = Pcap()
        p.handshake(T0)
        p.packet(T0 + 1, True, b"GET /health?x=1 HTTP/1.1\r\nHost: vm:7080\r\n\r\n")
        p.packet(T0 + 1.5, False, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
        line = p.run().lines[0]
        self.assertIn(' 35.168.36.211 "GET /health" 200 2 ', line)
        self.assertTrue(line.rstrip().endswith("host=vm:7080"))

    def test_log_sink_daily_files_and_retention(self):
        tmp = tempfile.mkdtemp()
        try:
            old = os.path.join(tmp, "requests-20000101.log")
            open(old, "w").close()
            sink = cap.LogSink(tmp, "requests-", 60)
            req = {"start": T0, "ip": "1.2.3.4", "method": "POST", "uri": "/v1/chat/completions", "host": "h", "ttfb": 0.5}
            sink.write(req, T0 + 2, 200, 10)
            sink.handle.close()
            self.assertFalse(os.path.exists(old))
            with open(os.path.join(tmp, "requests-20261013.log")) as handle:
                self.assertIn("rt=2.000 urt=2.000 uht=0.500 host=h", handle.read())
        finally:
            shutil.rmtree(tmp)


    def test_sample_sink_writes_agent_format_with_retention(self):
        tmp = tempfile.mkdtemp()
        try:
            old = os.path.join(tmp, "samples.csv-20000101")
            open(old, "w").close()
            sink = cap.SampleSink(tmp, 60)
            snapshot = {"generated_at": "2026-10-13T12:00:00Z", "gpu": {"util": 97.0, "mem_mb": 90000, "mem_mb_total": 97887},
                        "inflight": {"devcore": 3, "other": 1}}
            sink.write(snapshot, T0)
            sink.write(dict(snapshot, gpu={"util": None, "mem_mb": None, "mem_mb_total": None}), T0 + 10)
            self.assertFalse(os.path.exists(old))
            with open(os.path.join(tmp, "samples.csv-20261013")) as handle:
                lines = handle.read().splitlines()
            self.assertEqual(lines, ["2026-10-13T12:00:00Z,97.0,90000,1,3,4", "2026-10-13T12:00:00Z,,,1,3,4"])
            parsed = agent.parse_sample_line(lines[0])
            self.assertEqual((parsed["gpu_util"], parsed["conn_devcore"], parsed["conn_site"]), (97.0, 3, 1))
            self.assertIsNone(agent.parse_sample_line(lines[1])["gpu_util"])
        finally:
            shutil.rmtree(tmp)


class AgentWithCaptureTest(unittest.TestCase):
    def test_hosts_inflight_and_loopback(self):
        tmp = tempfile.mkdtemp()
        try:
            lines = [
                # DevCore: two overlapping streams 12:00:00-12:00:10 and 12:00:05-12:00:20
                '2026-10-13T12:00:10+00:00 189.36.225.60 "POST /v1/chat/completions" 200 10 rt=10.000 urt=10.000 uht=0.500 host=devcore01.multicortex.com.br',
                '2026-10-13T12:00:20+00:00 189.36.225.61 "POST /v1/chat/completions" 200 10 rt=15.000 urt=15.000 uht=0.700 host=devcore01.multicortex.com.br',
                # Another host through the same gateway: occupies a slot, not DevCore usage.
                '2026-10-13T12:00:12+00:00 200.1.1.1 "POST /v1/chat/completions" 200 10 rt=4.000 urt=4.000 uht=0.300 host=service01.multicortex.com.br',
                # Local test on the VM: not a developer.
                '2026-10-13T12:00:30+00:00 127.0.0.1 "GET /v1/models" 200 603 rt=0.000 urt=0.001 uht=0.001',
            ]
            with open(os.path.join(tmp, "requests-20261013.log"), "w") as handle:
                handle.write("\n".join(lines) + "\n")
            cfg = agent.load_config(None)
            cfg.update(samples_glob=os.path.join(tmp, "none*"), access_log_glob=os.path.join(tmp, "requests-*.log*"), slots=2)
            agent.gpu_memory_total = lambda: None
            now = datetime(2026, 10, 13, 12, 1, tzinfo=UTC)
            metrics, _ = agent.build_metrics(cfg, now, {"days": {}})
            today = metrics["today"]
            self.assertEqual(today["requests"], 2)
            self.assertEqual(today["other_requests"], 1)
            self.assertEqual(today["developers"], 2)
            self.assertEqual(today["inflight"]["peak"], {"devcore": 2, "other": 1, "total": 3})
            self.assertGreater(today["inflight"]["saturation_pct"]["total"], 0)
            point = metrics["timeline_today"]["points"][-1]
            self.assertEqual((point["inflight_devcore_max"], point["inflight_other_max"]), (2, 1))
            self.assertIsNone(point["conn_devcore_max"])  # no samples in this bucket
        finally:
            shutil.rmtree(tmp)

    def test_push_posts_json_with_bearer_and_never_prints_token(self):
        tmp = tempfile.mkdtemp()
        try:
            token_file = os.path.join(tmp, "push.token")
            with open(token_file, "w") as handle:
                handle.write("tok-123\n")
            seen = {}

            class Response(object):
                status = 200

                def __enter__(self):
                    return self

                def __exit__(self, *exc):
                    return False

            def opener(req):
                seen["auth"] = req.get_header("Authorization")
                seen["url"] = req.full_url
                seen["body"] = req.data
                return Response()

            cfg = {"push_url": "https://site.multicortex.com.br/api/devcore/ingest/devcore-demo-01", "push_token_file": token_file}
            self.assertEqual(agent.push_metrics(cfg, {"schema": 1}, opener=opener), 200)
            self.assertEqual(seen["auth"], "Bearer tok-123")
            self.assertEqual(seen["body"], b'{"schema":1}')
            self.assertIsNone(agent.push_metrics(dict(cfg, push_url="http://evil.example/x"), {}, opener=opener))
            self.assertIsNone(agent.push_metrics(dict(cfg, push_url=""), {}, opener=opener))
        finally:
            shutil.rmtree(tmp)


class LiveTest(unittest.TestCase):
    HOSTS = {"devcore01.multicortex.com.br"}

    def live_table(self, pcap):
        live = cap.LiveState(self.HOSTS, "/v1/", 300)
        table = cap.FlowTable(7080, cap.LiveSink(Memory(), live))
        cap.process_pcap(io.BytesIO(pcap.out.getvalue()), table)
        return live, table

    def test_streaming_request_is_in_progress_then_online_for_the_window(self):
        p = Pcap()
        p.handshake(T0)
        p.packet(T0 + 0.01, True, request())
        p.packet(T0 + 0.05, False, b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
        p.packet(T0 + 0.80, False, chunk(b"data: {\"x\":1}\n\n"))
        # Second developer: request sent, still queued (no response yet).
        p.handshake(T0 + 1, port=50001)
        p.packet(T0 + 1.01, True, request().replace(b"189.36.225.60", b"189.36.225.61"), port=50001)
        live, table = self.live_table(p)
        now = T0 + 2
        snap = live.snapshot(table.flows, now)
        self.assertEqual(snap, {"developers": {"online": 2, "active": 2}, "inflight": {"devcore": 2, "other": 0}})

        # Both answered: nothing in progress, both still online inside the window.
        p.packet(T0 + 3, False, b"0\r\n\r\n")
        p.packet(T0 + 3, False, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", port=50001)
        live, table = self.live_table(p)
        self.assertEqual(live.snapshot(table.flows, T0 + 4),
                         {"developers": {"online": 2, "active": 0}, "inflight": {"devcore": 0, "other": 0}})
        self.assertEqual(live.snapshot(table.flows, T0 + 3 + 301)["developers"]["online"], 0)

    def test_other_hosts_errors_and_stuck_requests_do_not_count_as_developers(self):
        p = Pcap()
        p.handshake(T0)
        other = request().replace(b"devcore01.multicortex.com.br", b"service01.multicortex.com.br")
        p.packet(T0 + 0.01, True, other)
        p.handshake(T0, port=50001)
        p.packet(T0 + 0.01, True, request(), port=50001)
        p.packet(T0 + 0.5, False, b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n", port=50001)
        live, table = self.live_table(p)
        self.assertEqual(live.snapshot(table.flows, T0 + 1),
                         {"developers": {"online": 0, "active": 0}, "inflight": {"devcore": 0, "other": 1}})
        # An answer that never came (lost packets) stops counting after STUCK_AFTER_S.
        self.assertEqual(live.snapshot(table.flows, T0 + cap.STUCK_AFTER_S + 1)["inflight"]["other"], 0)

    def test_seed_from_log_after_restart_and_snapshot_has_no_ips(self):
        tmp = tempfile.mkdtemp()
        try:
            now = T0 + 120
            sink = cap.LogSink(tmp, "requests-", 60)
            base = {"method": "POST", "uri": "/v1/chat/completions", "host": "devcore01.multicortex.com.br", "ttfb": 0.1}
            sink.write(dict(base, ip="189.36.225.60", start=T0 + 50), T0 + 60, 200, 10)
            sink.write(dict(base, ip="189.36.225.61", start=T0 - 900), T0 - 600, 200, 10)  # outside the window
            sink.write(dict(base, ip="127.0.0.1", start=T0 + 50), T0 + 60, 200, 10)       # the VM itself
            sink.handle.close()
            live = cap.LiveState(self.HOSTS, "/v1/", 300)
            live.seed(tmp, "requests-", now)
            counts = live.snapshot({}, now)
            self.assertEqual(counts["developers"], {"online": 1, "active": 0})
            cfg = cap.load_config(None)
            snapshot = cap.build_live(cfg, counts, now, {"util": 37.0, "mem_mb": 43000, "mem_mb_total": 46068})
            self.assertEqual((snapshot["slots"], snapshot["window_s"], snapshot["generated_at"]), (8, 300, "2026-10-13T12:02:00Z"))
            self.assertNotIn("189.36", json.dumps(snapshot))
        finally:
            shutil.rmtree(tmp)

    def test_config_reads_agent_hosts_and_push_conf(self):
        tmp = tempfile.mkdtemp()
        try:
            conf = os.path.join(tmp, "agent.conf")
            with open(conf, "w") as handle:
                handle.write("[agent]\ndevcore_hosts = A.example, b.example\nslots = 4\n[capture]\nlive_interval_s = 5\n")
            with open(os.path.join(tmp, "push.conf"), "w") as handle:
                handle.write("[agent]\npush_url = https://site.example/api/devcore/ingest/x\n")
            cfg = cap.load_config(conf)
            self.assertEqual((cfg["devcore_hosts"], cfg["slots"], cfg["live_interval_s"]), ({"a.example", "b.example"}, 4, 5))
            self.assertEqual(cfg["push_url"], "https://site.example/api/devcore/ingest/x")
        finally:
            shutil.rmtree(tmp)

    def test_push_live_goes_to_the_live_route_with_bearer(self):
        tmp = tempfile.mkdtemp()
        try:
            token_file = os.path.join(tmp, "push.token")
            with open(token_file, "w") as handle:
                handle.write("tok-123\n")
            seen = {}

            class Response(object):
                status = 204

                def __enter__(self):
                    return self

                def __exit__(self, *exc):
                    return False

            def opener(req):
                seen["url"], seen["auth"] = req.full_url, req.get_header("Authorization")
                return Response()

            cfg = {"push_url": "https://site.multicortex.com.br/api/devcore/ingest/devcore-demo-01", "push_token_file": token_file}
            self.assertEqual(cap.push_live(cfg, {"schema": 1}, opener=opener), 204)
            self.assertEqual(seen, {"url": cfg["push_url"] + "/live", "auth": "Bearer tok-123"})
            self.assertIsNone(cap.push_live(dict(cfg, push_url=""), {}, opener=opener))
            with self.assertRaises(ValueError):
                cap.push_live(dict(cfg, push_url="http://evil.example/x"), {}, opener=opener)
        finally:
            shutil.rmtree(tmp)


if __name__ == "__main__":
    unittest.main()
