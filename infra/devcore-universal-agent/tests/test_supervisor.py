import contextlib
import io
import os
import sys
import subprocess
import tempfile
import unittest
from unittest import mock
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import supervisor as s

TOKEN = 'a' * 64
IDENTITY = {'agent_id': 'stable-id', 'agent_version': 'test', 'enrollment_key': 'b' * 64}
SNAPSHOT = {'status': 'fallback_active', 'monitoring_started': True, 'data': {}}


def http(code):
    return urllib.error.HTTPError('https://invalid', code, TOKEN, {}, None)


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.patch = mock.patch.multiple(s, STATE_DIR=self.temp.name,
                                         BASE_URL='https://invalid', RUNNING=True)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        s.STOP_EVENT.clear()
        self.addCleanup(s.STOP_EVENT.clear)

    def run_cycles(self, statuses, token=TOKEN, telemetry=None, collector=None):
        statuses = iter(statuses)
        calls = []
        def api(path, payload=None, **kwargs):
            calls.append(path)
            if path.endswith('/enroll'):
                return {'id': 'stable-id', 'status': 'approved'}
            if '/status/' in path:
                try:
                    value = next(statuses)
                except StopIteration:
                    s.stop_handler(None, None)
                    raise s.Stopped()
                if isinstance(value, Exception):
                    raise value
                return value
            if path.endswith('/telemetry'):
                if telemetry:
                    return telemetry()
                return {}
            return {'token': TOKEN, 'status': 'approved'}
        with mock.patch.object(s, 'api_request', side_effect=api), \
                mock.patch.object(s, 'wait_interruptibly') as waits, \
                mock.patch.object(s, 'collect_fallback', side_effect=collector,
                                  return_value=SNAPSHOT) as collect:
            s.run_supervisor(dict(IDENTITY), 'b' * 64, token)
        return calls, waits, collect

    def test_network_status_recovery_preserves_token(self):
        s.save_operational_token(s.STATE_DIR, TOKEN)
        calls, waits, collect = self.run_cycles([
            {'status': 'approved'}, urllib.error.URLError(TOKEN),
            {'status': 'approved'}])
        self.assertEqual(collect.call_count, 2)
        self.assertEqual(sum(p.endswith('/telemetry') for p in calls), 2)
        self.assertEqual(s.read_operational_token(s.STATE_DIR), TOKEN)
        self.assertFalse(any(p.endswith('/credential') for p in calls))
        self.assertGreaterEqual(waits.call_count, 3)

    def test_telemetry_outage_recovers_after_new_status(self):
        outcomes = iter([urllib.error.URLError(TOKEN), {}])
        def send():
            result = next(outcomes)
            if isinstance(result, Exception):
                raise result
            return result
        calls, _, collect = self.run_cycles([{'status': 'approved'}] * 2, telemetry=send)
        self.assertEqual(collect.call_count, 2)
        self.assertEqual(sum('/status/' in p for p in calls), 3)

    def test_unknown_malformed_status_never_collects(self):
        _, _, collect = self.run_cycles([None, {}, [], {'status': 'other'},
                                         {'status': 'pending'}])
        collect.assert_not_called()

    def test_revoked_deletes_token_and_stops(self):
        s.save_operational_token(s.STATE_DIR, TOKEN)
        calls, _, collect = self.run_cycles([{'status': 'approved'}, {'status': 'revoked'}])
        self.assertEqual(collect.call_count, 1)
        self.assertIsNone(s.read_operational_token(s.STATE_DIR))
        self.assertEqual(sum(p.endswith('/telemetry') for p in calls), 1)

    def test_pending_deletes_token(self):
        s.save_operational_token(s.STATE_DIR, TOKEN)
        self.run_cycles([{'status': 'pending'}])
        self.assertIsNone(s.read_operational_token(s.STATE_DIR))

    def test_auth_errors_block_collection_without_reenrollment(self):
        for code in (401, 403):
            with self.subTest(code=code):
                s.RUNNING = True
                s.STOP_EVENT.clear()
                marker = os.path.join(s.STATE_DIR, "telemetry-auth-blocked")
                if os.path.exists(marker):
                    os.unlink(marker)
                def fail():
                    raise http(code)
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    calls, _, collect = self.run_cycles([{'status': 'approved'}] * 3, telemetry=fail)
                self.assertEqual(collect.call_count, 1)
                self.assertEqual(sum(p.endswith('/enroll') for p in calls), 1)
                self.assertNotIn(TOKEN, output.getvalue())

    def test_status_http_errors_fail_closed(self):
        for code in (400, 401, 403, 404, 409, 408, 429, 500, 502, 503, 504):
            with self.subTest(code=code):
                s.RUNNING = True
                s.STOP_EVENT.clear()
                _, waits, collect = self.run_cycles([http(code), {'status': 'approved'}])
                self.assertEqual(collect.call_count, 1)
                self.assertGreaterEqual(waits.call_args_list[0].args[0], 30)

    def test_successive_failures_backoff_bounded(self):
        _, waits, collect = self.run_cycles([urllib.error.URLError('offline')] * 8 + [{'status': 'approved'}])
        delays = [c.args[0] for c in waits.call_args_list]
        self.assertEqual(delays[:5], [30, 60, 120, 240, 300])
        self.assertLessEqual(max(delays), 300)
        self.assertEqual(collect.call_count, 1)

    def test_collection_failure_recovers(self):
        _, _, collect = self.run_cycles([{'status': 'approved'}] * 2,
                                        collector=[RuntimeError(TOKEN), SNAPSHOT])
        self.assertEqual(collect.call_count, 2)

    def test_credential_durable_intent_prevents_reissue(self):
        marker = os.path.join(s.STATE_DIR, 'credential-attempted')
        s.mark_credential_attempt(marker)
        calls, _, collect = self.run_cycles([{'status': 'approved'}] * 2, token=None)
        self.assertFalse(any(p.endswith('/credential') for p in calls))
        collect.assert_not_called()

    def test_new_credential_persisted_once(self):
        calls, _, collect = self.run_cycles([{'status': 'approved'}] * 2, token=None)
        self.assertEqual(sum(p.endswith('/credential') for p in calls), 1)
        self.assertEqual(s.read_operational_token(s.STATE_DIR), TOKEN)
        self.assertEqual(collect.call_count, 2)

    def test_main_restart_recovers_identity_and_token(self):
        with mock.patch.object(s, 'BOOTSTRAP_TOKEN', 'bootstrap'), \
                mock.patch.object(s, 'run_supervisor') as run:
            s.save_operational_token(s.STATE_DIR, TOKEN)
            s.main()
            first = run.call_args
            s.main()
            self.assertEqual(first, run.call_args)
            self.assertEqual(run.call_args.args[2], TOKEN)

    def test_signal_during_collection_prevents_send(self):
        def collect():
            s.stop_handler(None, None)
            return SNAPSHOT
        calls, _, _ = self.run_cycles([{'status': 'approved'}], collector=collect)
        self.assertFalse(any(p.endswith('/telemetry') for p in calls))

    def test_signals_interrupt_wait_and_preserve_files(self):
        for signum in (2, 15):
            s.RUNNING = True
            s.STOP_EVENT.clear()
            s.save_operational_token(s.STATE_DIR, TOKEN)
            s.stop_handler(signum, None)
            with self.assertRaises(s.Stopped):
                s.wait_interruptibly(300)
            with mock.patch.object(s.urllib.request, 'urlopen') as urlopen:
                with self.assertRaises(s.Stopped):
                    s.api_request('/status')
                urlopen.assert_not_called()
            self.assertEqual(s.read_operational_token(s.STATE_DIR), TOKEN)

    def test_persistence_security(self):
        s.save_operational_token(s.STATE_DIR, TOKEN)
        path = os.path.join(s.STATE_DIR, 'operational-token')
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        os.chmod(path, 0o644)
        with self.assertRaises(RuntimeError):
            s.read_operational_token(s.STATE_DIR)
        with self.assertRaises(RuntimeError):
            s.save_operational_token(s.STATE_DIR, 'invalid')

    def test_auth_block_survives_restart(self):
        s.mark_credential_attempt(os.path.join(s.STATE_DIR, 'telemetry-auth-blocked'))
        calls, _, collect = self.run_cycles([{'status': 'approved'}])
        collect.assert_not_called()
        self.assertFalse(any(p.endswith('/credential') for p in calls))

    def test_independent_process_persistence(self):
        script = (
            "import sys; sys.path.insert(0, sys.argv[1]); "
            "import discovery, supervisor; "
            "print(discovery.get_agent_id(sys.argv[2])); "
            "supervisor.save_operational_token(sys.argv[2], 'a'*64) "
            "if sys.argv[3] == 'write' else "
            "print(supervisor.read_operational_token(sys.argv[2]) == 'a'*64)"
        )
        root = os.path.dirname(s.__file__)
        first = subprocess.check_output([sys.executable, '-c', script, root,
                                         s.STATE_DIR, 'write']).decode().splitlines()
        second = subprocess.check_output([sys.executable, '-c', script, root,
                                          s.STATE_DIR, 'read']).decode().splitlines()
        self.assertEqual(first[0], second[0])
        self.assertEqual(second[1], 'True')

    def test_enrollment_outage_reuses_identity(self):
        responses = [urllib.error.URLError('offline'),
                     {'id': 'stable-id', 'status': 'pending'},
                     {'status': 'pending'}]
        def api(*args, **kwargs):
            if not responses:
                s.stop_handler(None, None)
                raise s.Stopped()
            value = responses.pop(0)
            if isinstance(value, Exception):
                raise value
            return value
        with mock.patch.object(s, 'api_request', side_effect=api) as request, \
                mock.patch.object(s, 'wait_interruptibly'), \
                mock.patch.object(s, 'collect_fallback') as collect:
            s.run_supervisor(dict(IDENTITY), 'b'*64, None)
        self.assertEqual(request.call_args_list[0], request.call_args_list[1])
        collect.assert_not_called()

    def test_lost_credential_response_never_reissued(self):
        def api(path, *args, **kwargs):
            if path.endswith('/enroll'):
                return {'id': 'stable-id', 'status': 'approved'}
            if '/status/' in path:
                return {'status': 'approved'}
            raise urllib.error.URLError(TOKEN)
        cycles = [0]
        def wait(_):
            cycles[0] += 1
            if cycles[0] == 3:
                s.stop_handler(None, None)
        with mock.patch.object(s, 'api_request', side_effect=api) as request, \
                mock.patch.object(s, 'wait_interruptibly', side_effect=wait), \
                mock.patch.object(s, 'collect_fallback') as collect:
            s.run_supervisor(dict(IDENTITY), 'b'*64, None)
        self.assertEqual(sum(c.args[0].endswith('/credential') for c in request.call_args_list), 1)
        collect.assert_not_called()
        self.assertTrue(os.path.exists(os.path.join(s.STATE_DIR, 'credential-attempted')))

    def test_explicit_admin_generation_recovers_once(self):
        s.save_operational_token(s.STATE_DIR, TOKEN)
        for name in ('credential-attempted', 'telemetry-auth-blocked'):
            s.mark_credential_attempt(os.path.join(s.STATE_DIR, name))
        calls, _, collect = self.run_cycles([{'status': 'approved', 'credential_generation': 1}] * 2)
        self.assertEqual(sum(path.endswith('/credential') for path in calls), 1)
        self.assertEqual(s.read_generation(s.STATE_DIR), 1)
        self.assertEqual(collect.call_count, 2)
        self.assertFalse(os.path.exists(os.path.join(s.STATE_DIR, 'telemetry-auth-blocked')))

    def test_generation_rollback_or_malformed_never_collects(self):
        s.save_generation(s.STATE_DIR, 1)
        s.save_operational_token(s.STATE_DIR, TOKEN)
        _, _, collect = self.run_cycles([{'status': 'approved', 'credential_generation': value} for value in (0, -1, True, '2')])
        collect.assert_not_called()
        self.assertEqual(s.read_operational_token(s.STATE_DIR), TOKEN)
        self.assertEqual(s.read_generation(s.STATE_DIR), 1)

    def test_revoked_waits_without_collection_until_admin_reapproval(self):
        s.save_operational_token(s.STATE_DIR, TOKEN)
        calls, _, collect = self.run_cycles([{'status': 'revoked'}, {'status': 'revoked'}, {'status': 'approved', 'credential_generation': 1}])
        self.assertEqual(collect.call_count, 1)
        self.assertEqual(sum(path.endswith('/telemetry') for path in calls), 1)
        self.assertEqual(sum(path.endswith('/credential') for path in calls), 1)

    def test_http_retry_matrix_and_post_safety(self):
        for code in (400, 401, 403, 404, 409, 408, 429, 500, 502, 503, 504):
            for path, payload in (('/status', None), ('/enroll', {}), ('/credential', {}), ('/telemetry', {})):
                with self.subTest(code=code, path=path), \
                        mock.patch.object(s.urllib.request, 'urlopen', side_effect=http(code)) as request, \
                        mock.patch.object(s, 'wait_interruptibly') as wait:
                    with self.assertRaises(urllib.error.HTTPError):
                        s.api_request(path, payload=payload)
                    retry = code in s.TRANSIENT_HTTP and path in ('/status', '/enroll')
                    self.assertEqual(request.call_count, 4 if retry else 1)
                    self.assertEqual([c.args[0] for c in wait.call_args_list], [1, 2, 4] if retry else [])
                    self.assertEqual(request.call_args.kwargs['timeout'], 10)

    def test_network_retry_and_invalid_json(self):
        for error in (urllib.error.URLError('dns'), ConnectionRefusedError(), TimeoutError()):
            with mock.patch.object(s.urllib.request, 'urlopen', side_effect=error) as request, \
                    mock.patch.object(s, 'wait_interruptibly'):
                with self.assertRaises(type(error)):
                    s.api_request('/status')
                self.assertEqual(request.call_count, 4)
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'not-json'
        with mock.patch.object(s.urllib.request, 'urlopen', return_value=response):
            with self.assertRaises(ValueError):
                s.api_request('/status')


if __name__ == '__main__':
    unittest.main()
