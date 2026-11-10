import copy
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from unittest import mock

AGENT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT))
import operational_collector as collector
import capture_guard


class OperationalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.metrics = self.root / 'metrics.json'
        self.live = self.root / 'live.json'
        self.env = mock.patch.dict(os.environ, {
            'MULTICORTEX_OPERATIONAL_METRICS_FILE': str(self.metrics),
            'MULTICORTEX_OPERATIONAL_LIVE_FILE': str(self.live),
            'MULTICORTEX_CAPTURE_ENABLED': '0',
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(collector.suspend_operational)
        self.metric = json.loads((AGENT.parents[1] / 'tests/fixtures/devcore-metrics.sample.json').read_text())
        self.metric['host'] = socket.gethostname()
        self.metric['slots'] = 6
        self.metric['generated_at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        self.metric['today']['requests'] = 4
        first = copy.deepcopy(self.metric['today']['developer_list'][0])
        first.update(ip='192.0.2.10', requests=4)
        self.metric['today']['developer_list'] = [first]


    def write(self):
        self.metrics.write_text(json.dumps(self.metric))
        live = json.loads((AGENT.parents[1] / 'tests/fixtures/devcore-live.sample.json').read_text())
        live['generated_at'] = self.metric['generated_at']
        self.live.write_text(json.dumps(live))

    def collect(self, **kwargs):
        return collector.collect_operational(approved=True, state_dir=str(self.root), salt='b'*64, **kwargs)

    def test_pending_never_reads_source_or_starts_capture(self):
        with mock.patch.object(collector, 'read_json') as read, mock.patch.object(collector, 'owned_source') as owned:
            result = collector.collect_operational(approved=False)
            self.assertEqual(result['reason'], 'approval_required')
            read.assert_not_called()
            owned.assert_not_called()

    def test_existing_source_is_readonly_and_identifiers_are_pseudonymous(self):
        self.write()
        original = self.metrics.read_bytes()
        result = self.collect()
        self.assertEqual(result['status'], 'available')
        self.assertEqual(result['metrics']['today']['requests'], 4)
        self.assertNotIn('192.0.2.10', json.dumps(result))
        self.assertTrue(result['metrics']['today']['developer_list'][0]['ip'].startswith('dev-'))
        self.assertEqual(self.metrics.read_bytes(), original)
        self.assertEqual(self.collect()['metrics'], result['metrics'])
        self.assertIsNotNone(result['live'])

    def test_missing_source_is_unknown_not_zero(self):
        result = self.collect()
        self.assertEqual(result['status'], 'unavailable')
        self.assertIsNone(result['metrics'])
        self.assertIsNone(result['live'])

    def test_invalid_stale_or_foreign_source_refused(self):
        self.write()
        for patch in [{'schema': 99}, {'host': 'other-host'}, {'generated_at': '2020-01-01T00:00:00Z'}]:
            self.metrics.write_text(json.dumps(dict(self.metric, **patch)))
            self.assertEqual(self.collect()['status'], 'unavailable')
        self.metrics.write_text('not-json')
        self.assertEqual(self.collect()['reason'], 'collection_failed')

    def test_source_size_and_symlink_rejected(self):
        self.metrics.write_text('x' * (collector.MAX_BYTES + 1))
        self.assertEqual(self.collect()['status'], 'unavailable')
        self.metrics.unlink()
        (self.root / 'real').write_text(json.dumps(self.metric))
        self.metrics.symlink_to(self.root / 'real')
        self.assertEqual(self.collect()['status'], 'unavailable')

    def test_slot_mismatch_and_ambiguous_server_refused(self):
        self.write()
        self.assertEqual(self.collect(servers=[{'slots': 8, 'port': 7080}])['reason'], 'source_identity_mismatch')
        self.assertEqual(self.collect(servers=[{'slots': 6}, {'slots': 6}])['reason'], 'server_selection_required')

    def test_lease_expiry_and_future_forgery_fail_closed(self):
        lease = self.root / 'lease.json'
        for expiry, valid in [(110, True), (99, False), (1000, False)]:
            lease.write_text(json.dumps({'expires_at': expiry, 'owner_pid': os.getpid(), 'owner_start': capture_guard.process_start(os.getpid())}))
            self.assertEqual(capture_guard.lease_valid(str(lease), now=100), valid)
        self.assertFalse(capture_guard.lease_valid(str(lease), now=100, expected=(123, 'other')))
        lease.write_text('broken')
        self.assertFalse(capture_guard.lease_valid(str(lease)))

    def test_suspend_stops_only_owned_process_group(self):
        fake = mock.Mock(pid=123456)
        fake.poll.return_value = None
        with mock.patch.object(collector, '_CAPTURE', fake), mock.patch('os.killpg') as kill:
            collector.suspend_operational()
            kill.assert_called_once()
            self.assertEqual(kill.call_args.args[0], 123456)
            fake.wait.assert_called_once()

    def test_zombie_supervisor_is_not_an_active_lease_owner(self):
        line = "123 (worker) " + " ".join(["Z"] + ["0"] * 18 + ["1234"])
        with mock.patch("builtins.open", mock.mock_open(read_data=line)):
            self.assertIsNone(capture_guard.process_start(123))

    def test_unknown_payload_fields_and_nonfinite_json_never_transmitted(self):
        self.metric['debug_headers'] = 'private-debug-marker'
        self.metric['today']['request_bodies'] = 'private-body-marker'
        self.write()
        result = self.collect()
        self.assertEqual(result['status'], 'available')
        self.assertNotIn('private-debug-marker', json.dumps(result))
        self.assertNotIn('private-body-marker', json.dumps(result))
        self.metrics.write_text('{"schema": 1, "number": NaN}')
        self.assertEqual(self.collect()['status'], 'unavailable')
        self.metrics.write_text(json.dumps({'schema': 1, 'host': socket.gethostname(), 'generated_at': self.metric['generated_at']}))
        self.assertEqual(self.collect()['status'], 'unavailable')

    def test_vendored_collectors_are_exact_copies_of_unmodified_legacy(self):
        legacy = AGENT.parent / 'devcore-vm-agent'
        self.assertEqual((AGENT/'http_capture_core.py').read_bytes(), (legacy/'devcore_http_capture.py').read_bytes())
        self.assertEqual((AGENT/'request_metrics_core.py').read_bytes(), (legacy/'devcore_metrics_agent.py').read_bytes())


if __name__ == '__main__': unittest.main()


class RunPodDefaultsTests(unittest.TestCase):
    def test_capture_on_by_default_only_inside_runpod(self):
        self.assertTrue(collector.capture_enabled({'RUNPOD_POD_ID': '4vtw3ny63c0ucm'}))
        self.assertFalse(collector.capture_enabled({}))
        self.assertFalse(collector.capture_enabled({'RUNPOD_POD_ID': 'bad id'}))
        self.assertFalse(collector.capture_enabled({'RUNPOD_POD_ID': 'pod', 'MULTICORTEX_CAPTURE_ENABLED': '0'}))
        self.assertTrue(collector.capture_enabled({'MULTICORTEX_CAPTURE_ENABLED': '1'}))

    def test_hosts_derived_from_runpod_proxy(self):
        self.assertEqual(collector.devcore_hosts({'RUNPOD_POD_ID': '4vtw3ny63c0ucm'}, 7080),
                         '4vtw3ny63c0ucm-7080.proxy.runpod.net,devcore01.multicortex.com.br')
        self.assertEqual(collector.devcore_hosts({'RUNPOD_POD_ID': 'p', 'MULTICORTEX_DEVCORE_HOSTS': 'a.example'}, 7080), 'a.example')
        self.assertEqual(collector.devcore_hosts({}, 7080), '')
        self.assertEqual(collector.devcore_hosts({'RUNPOD_POD_ID': 'p'}, None), '')

    def test_auto_capture_without_tcpdump_reports_reason(self):
        with tempfile.TemporaryDirectory() as state, \
                mock.patch.dict(os.environ, {'RUNPOD_POD_ID': 'pod1'}, clear=True), \
                mock.patch.object(collector.shutil, 'which', return_value=None):
            self.assertEqual(collector.owned_source([{'port': 7080, 'slots': 6}], state)[2], 'tcpdump_unavailable')
