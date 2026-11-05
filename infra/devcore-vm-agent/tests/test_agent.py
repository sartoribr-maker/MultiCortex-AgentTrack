# -*- coding: utf-8 -*-
"""Unit tests for the DevCore VM metrics agent (Python 3.6+, stdlib only).

Run: python3 -m unittest discover -s infra/devcore-vm-agent/tests -v
"""
import gzip
import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import devcore_metrics_agent as agent  # noqa: E402

FIXTURES = os.path.join(HERE, "fixtures")
UTC = timezone.utc
NOW = datetime(2026, 10, 13, 12, 2, 0, tzinfo=UTC)  # 09:02 in Brasilia


def make_cfg(tmp, **overrides):
    cfg = agent.load_config(None)
    cfg.update({
        "samples_glob": os.path.join(tmp, "samples.csv*"),
        "access_log_glob": os.path.join(tmp, "access.log*"),
        "output": os.path.join(tmp, "out", "metrics.json"),
        "state_dir": os.path.join(tmp, "state"),
        "host": "devcore-test",
    })
    cfg.update(overrides)
    return cfg


class ParsingTest(unittest.TestCase):
    def test_access_line_with_query_and_multiple_upstreams(self):
        record = agent.parse_access_line(
            '2026-10-13T12:01:20+00:00 203.0.113.12 "POST /v1/chat/completions?stream=true" '
            '200 640 rt=6.000 urt=0.100, 5.800 uht=0.050, 0.700\n')
        self.assertEqual(record["uri"], "/v1/chat/completions")
        self.assertEqual(record["status"], 200)
        self.assertEqual(record["rt"], 6.0)
        self.assertEqual(record["uht"], 0.7)  # last upstream try answered
        self.assertEqual(record["ts"], datetime(2026, 10, 13, 12, 1, 20, tzinfo=UTC))

    def test_access_line_dash_values_and_ipv6(self):
        record = agent.parse_access_line(
            '2026-10-13T12:00:50+00:00 2001:db8::1 "POST /v1/chat/completions" 401 30 rt=0.001 urt=- uht=-')
        self.assertEqual(record["ip"], "2001:db8::1")
        self.assertIsNone(record["uht"])

    def test_invalid_access_lines(self):
        for line in ("", "this is not an nginx line",
                     '2026-13-45T99:00:00+00:00 1.2.3.4 "POST /v1/x" 200 1 rt=1 urt=1 uht=1',
                     '2026-10-13T12:00:00+00:00 1.2.3.4 "POST /v1/x" 2000 1 rt=1 urt=1 uht=1'):
            self.assertIsNone(agent.parse_access_line(line), line)

    def test_sample_line_variants(self):
        sample = agent.parse_sample_line("2026-10-13T12:00:45Z,na,na,0,9,na")
        self.assertIsNone(sample["gpu_util"])
        self.assertEqual(sample["conn_devcore"], 9)
        self.assertIsNone(sample["slots_busy"])
        epoch = agent.parse_sample_line("1760356920,20,30200,3,1,na")
        self.assertEqual(epoch["ts"].year, 2025)
        naive = agent.parse_sample_line("2026-10-13 12:00:00,1,2,0,0,4")
        self.assertEqual(naive["ts"].tzinfo, UTC)
        self.assertEqual(naive["slots_busy"], 4.0)
        for line in ("ts,gpu_util,gpu_mem_mb,conn_site,conn_devcore,slots_busy",
                     "garbage", "2026-10-13T12:01:15Z,50,30500", "not-a-date,1,2,0,0,na",
                     "2026-10-13T12:01:30Z,12,30200,na,na,na"):
            self.assertIsNone(agent.parse_sample_line(line), line)

    def test_real_vm_sample_lines(self):
        # Copied from devcore-demo-01 (13/10/2026): "+00:00" offsets, ~16 s cadence.
        header = "ts,gpu_util,gpu_mem_mb,conn_site,conn_devcore,slots_busy"
        self.assertIsNone(agent.parse_sample_line(header))
        first = agent.parse_sample_line("2026-10-12T20:55:56+00:00,0,43339,0,0,na")
        self.assertEqual(first["ts"], datetime(2026, 10, 12, 20, 55, 56, tzinfo=UTC))
        self.assertEqual((first["gpu_util"], first["gpu_mem_mb"]), (0.0, 43339.0))
        self.assertEqual((first["conn_site"], first["conn_devcore"]), (0, 0))
        self.assertIsNone(first["slots_busy"])
        last = agent.parse_sample_line("2026-10-13T23:38:23+00:00,0,43521,0,0,na\n")
        self.assertEqual(last["ts"].astimezone(timezone(timedelta(hours=-3))).strftime("%d/%m %H:%M"), "13/10 20:38")

    def test_percentile_interpolates(self):
        self.assertIsNone(agent.percentile([], 50))
        self.assertEqual(agent.percentile([3.0], 95), 3.0)
        self.assertEqual(agent.percentile([2.0, 4.21, 6.0, 12.5], 50), 5.105)
        self.assertEqual(agent.percentile(list(range(1, 101)), 95), 95.05)


class BuildMetricsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        for name in ("samples.csv", "access.log"):
            shutil.copy(os.path.join(FIXTURES, name), os.path.join(self.tmp, name))
        self.cfg = make_cfg(self.tmp)
        agent.gpu_memory_total = lambda: 46068

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def build(self, state=None, now=NOW):
        return agent.build_metrics(self.cfg, now, state or {"days": {}})

    def test_today_indicators(self):
        metrics, _ = self.build()
        today = metrics["today"]
        self.assertEqual(metrics["schema"], 1)
        self.assertEqual(today["date"], "2026-10-13")
        self.assertEqual(today["requests"], 8)
        self.assertEqual(today["requests_ok"], 5)
        self.assertEqual(today["errors_4xx"], 1)
        self.assertEqual(today["errors_5xx"], 1)
        self.assertEqual(today["cancelled_499"], 1)
        self.assertEqual(today["error_rate"], round(2 / 7.0, 4))
        self.assertEqual(today["developers"], 4)
        self.assertEqual(today["latency_s"], {"p50": 5.105, "p95": 11.525})
        self.assertEqual(today["ttfb_s"]["p50"], 0.555)
        self.assertEqual(today["conn_peak"], {"devcore": 9, "site": 2, "total": 9})
        self.assertEqual(today["saturation_pct"], {"devcore": 33.33, "total": 50.0})
        self.assertEqual(today["gpu"], {"util_avg": 53.0, "util_max": 97.0, "mem_mb_avg": 30551,
                                        "mem_mb_max": 31010, "mem_mb_total": 46068})

    def test_source_counters(self):
        metrics, _ = self.build()
        self.assertEqual(metrics["sources"]["access_log"]["lines_invalid"], 2)
        self.assertEqual(metrics["sources"]["samples"]["lines_invalid"], 4)
        self.assertEqual(metrics["sources"]["samples"]["lines_ok"], 7)
        self.assertEqual(metrics["sources"]["access_log"]["last_ts"], "2026-10-13T12:01:40Z")

    def test_developer_list_breaks_today_down_by_ip(self):
        metrics, _ = self.build()
        devs = metrics["today"]["developer_list"]
        self.assertEqual(len(devs), metrics["today"]["developers"])
        self.assertEqual([d["ip"] for d in devs], ["203.0.113.10", "198.51.100.7", "203.0.113.12", "203.0.113.11"])
        busiest = devs[0]
        self.assertEqual((busiest["requests"], busiest["requests_ok"], busiest["cancelled_499"]), (4, 3, 1))
        # 11:57:55.79 (11:58:00 - 4.21 s) to 12:01:40, all within one session.
        self.assertEqual(busiest["first_seen"], "2026-10-13T08:57:55-03:00")
        self.assertEqual(busiest["last_seen"], "2026-10-13T09:01:40-03:00")
        self.assertEqual(busiest["active_s"], 224)
        self.assertEqual(busiest["latency_p50"], 8.355)
        self.assertEqual(devs[1]["errors_5xx"], 1)
        self.assertEqual(devs[3]["requests"], 0, "GET /v1/models only: a developer without chat calls")

    def test_scanners_and_metrics_endpoint_are_not_developers(self):
        metrics, state = self.build()
        listed = json.dumps(metrics["today"]["developer_list"])
        for ip in ("192.0.2.99", "52.207.145.100", "2001:db8"):
            self.assertNotIn(ip, listed)
        self.assertNotIn("203.0.113", json.dumps(state), "the persisted history keeps counts only")

    def test_developer_details_can_be_disabled(self):
        self.cfg["developer_details"] = False
        metrics, state = self.build()
        dump = json.dumps([metrics, state])
        self.assertNotIn("developer_list", dump)
        for ip in ("203.0.113", "198.51.100", "192.0.2.99", "2001:db8", "52.207.145.100"):
            self.assertNotIn(ip, dump)

    def test_active_time_splits_sessions_after_the_gap(self):
        def call(minute, rt):
            return {"ts": NOW + timedelta(minutes=minute), "rt": rt}
        self.assertEqual(agent.active_seconds([call(0, 10), call(4, 10)]), 250)
        self.assertEqual(agent.active_seconds([call(0, 10), call(30, 10)]), 20)
        self.assertEqual(agent.active_seconds([call(0, None)]), 0)

    def test_hourly_buckets_cover_24_hours_in_brasilia(self):
        metrics, _ = self.build()
        hours = metrics["hourly_24h"]
        self.assertEqual(len(hours), 24)
        self.assertEqual(hours[-1]["start"], "2026-10-13T09:00:00-03:00")
        self.assertEqual(hours[0]["start"], "2026-10-12T10:00:00-03:00")
        self.assertEqual(hours[-1]["requests"], 7)   # 12:00-12:59 UTC
        self.assertEqual(hours[-2]["requests"], 1)   # 11:58 UTC
        self.assertEqual(hours[-2]["p50"], 4.21)
        yesterday_18h = [h for h in hours if h["start"] == "2026-10-12T15:00:00-03:00"][0]
        self.assertEqual(yesterday_18h["requests"], 1)

    def test_timeline_buckets_and_gaps(self):
        metrics, _ = self.build()
        timeline = metrics["timeline_today"]
        self.assertEqual(timeline["interval_s"], 300)
        points = timeline["points"]
        self.assertEqual([p["t"] for p in points], ["2026-10-13T08:55:00-03:00", "2026-10-13T09:00:00-03:00"])
        self.assertEqual(points[1]["conn_devcore_max"], 9)
        self.assertEqual(points[1]["gpu_util_max"], 97.0)

    def test_daily_history_finalizes_closed_days_and_keeps_state(self):
        metrics, state = self.build()
        self.assertEqual([d["date"] for d in metrics["daily"]], ["2026-10-12", "2026-10-13"])
        self.assertEqual(metrics["daily"][0]["requests"], 1)
        self.assertNotIn("has_data", metrics["daily"][0])
        self.assertTrue(state["days"]["2026-10-12"]["has_data"])
        self.assertFalse(state["days"]["2026-10-01"]["has_data"])
        # Second run: logs rotated away, history must come from the state.
        os.unlink(os.path.join(self.tmp, "access.log"))
        again, _ = self.build(state=state)
        self.assertEqual(again["daily"][0], metrics["daily"][0])
        self.assertEqual(again["today"]["requests"], 0)

    def test_day_not_finalized_inside_grace_period(self):
        just_after_midnight = datetime(2026, 10, 14, 3, 5, tzinfo=UTC)  # 00:05 BRT
        _, state = self.build(now=just_after_midnight)
        self.assertNotIn("2026-10-13", state["days"])
        later = datetime(2026, 10, 14, 3, 30, tzinfo=UTC)
        _, state = self.build(state=state, now=later)
        self.assertEqual(state["days"]["2026-10-13"]["requests"], 8)

    def test_rotated_and_gzipped_logs_are_read(self):
        os.rename(os.path.join(self.tmp, "access.log"), os.path.join(self.tmp, "access.log.1"))
        with open(os.path.join(FIXTURES, "access.log"), "rb") as src:
            with gzip.open(os.path.join(self.tmp, "access.log.2.gz"), "wb") as dst:
                dst.write(src.read())
        metrics, _ = self.build()
        self.assertEqual(metrics["today"]["requests"], 16)

    def test_old_rotated_files_are_skipped_by_mtime(self):
        old = os.path.join(self.tmp, "access.log.9")
        shutil.copy(os.path.join(FIXTURES, "access.log"), old)
        stamp = (NOW - timedelta(days=60)).timestamp()
        os.utime(old, (stamp, stamp))
        metrics, _ = self.build(state={"days": {}})
        self.assertEqual(metrics["today"]["requests"], 8)

    def test_missing_files_produce_empty_metrics(self):
        cfg = make_cfg(tempfile.mkdtemp())
        metrics, _ = agent.build_metrics(cfg, NOW, {"days": {}})
        self.assertEqual(metrics["today"]["requests"], 0)
        self.assertIsNone(metrics["today"]["latency_s"]["p50"])
        self.assertEqual(metrics["timeline_today"]["points"], [])
        self.assertEqual([d["date"] for d in metrics["daily"]], ["2026-10-13"])

    def test_server_log_summary(self):
        with open(os.path.join(FIXTURES, "server.log")) as handle:
            lines = handle.read().splitlines()
        metrics, state = agent.build_metrics(self.cfg, NOW, {"days": {}}, lines)
        server = metrics["today"]["server"]
        self.assertEqual(server["ctx_per_slot"], 27904)
        self.assertEqual(server["context_exceeded"], 2)
        self.assertEqual(server["context_exceeded_max_tokens"], 48357)
        self.assertEqual(server["errors_other"], 1)
        self.assertEqual(server["context_tokens"], {"p50": 18476.0, "p95": 23823.8})
        self.assertEqual(server["decode_tps"]["p50"], 10.95)
        self.assertEqual(server["prefill_tps_p50"], 1970.3)
        self.assertEqual(state["ctx_per_slot"], 27904)

    def test_server_context_size_remembered_from_state(self):
        metrics, _ = agent.build_metrics(self.cfg, NOW, {"days": {}, "ctx_per_slot": 30208}, [])
        self.assertEqual(metrics["today"]["server"]["ctx_per_slot"], 30208)
        self.assertEqual(metrics["today"]["server"]["context_exceeded"], 0)
        self.assertIsNone(metrics["today"]["server"]["decode_tps"]["p50"])

    def test_server_block_absent_without_journal(self):
        metrics, _ = self.build()
        self.assertNotIn("server", metrics["today"])

    def test_atomic_write_and_main(self):
        out_dir = os.path.join(self.tmp, "out")
        os.makedirs(out_dir)
        os.makedirs(self.cfg["state_dir"])
        conf = os.path.join(self.tmp, "agent.conf")
        with open(conf, "w") as handle:
            handle.write("[agent]\n")
            for key in ("samples_glob", "access_log_glob", "output", "state_dir", "host"):
                handle.write("%s = %s\n" % (key, self.cfg[key]))
            handle.write("server_unit =\n")
        self.assertEqual(agent.main(["--config", conf]), 0)
        with open(self.cfg["output"]) as handle:
            data = json.load(handle)
        self.assertEqual(data["host"], "devcore-test")
        self.assertEqual(oct(os.stat(self.cfg["output"]).st_mode & 0o777), oct(0o644))
        state_file = os.path.join(self.cfg["state_dir"], "state.json")
        self.assertEqual(oct(os.stat(state_file).st_mode & 0o777), oct(0o600))
        self.assertEqual([f for f in os.listdir(out_dir) if f.startswith(".tmp-")], [])


if __name__ == "__main__":
    unittest.main()
