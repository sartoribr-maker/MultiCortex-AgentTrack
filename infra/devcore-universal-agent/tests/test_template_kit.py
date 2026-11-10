import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import zipfile

AGENT = Path(__file__).resolve().parents[1]
ROOT = AGENT.parents[1]
spec = importlib.util.spec_from_file_location('package_agent', str(ROOT / 'scripts/package-universal-agent.py'))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)
spec = importlib.util.spec_from_file_location('template_boot_test', str(AGENT / 'template_boot.py'))
boot_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot_module)


class TemplateKitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.archive = self.root / 'kit.zip'
        packager.build(self.archive)
        with zipfile.ZipFile(str(self.archive)) as archive:
            archive.extractall(str(self.root))
        self.source = self.root / packager.KIT_NAME
        self.target = self.root / 'installed'
        self.states = []
        self.env = dict(os.environ, RUNPOD_POD_ID='pod-one',
                        MULTICORTEX_MONITOR_URL='https://example.invalid/agenttrack',
                        MULTICORTEX_BOOTSTRAP_TOKEN='a' * 64)

    def tearDown(self):
        for state in self.states:
            env = dict(self.env, MULTICORTEX_AGENT_STATE_DIR=str(state))
            script = self.target / 'agent_service.py'
            if script.exists():
                self.command([sys.executable, str(script), 'stop'], env=env, check=False)
                for _ in range(30):
                    result = self.command([sys.executable, str(script), 'status'], env=env)
                    if 'Parado' in result.stdout:
                        break
                    time.sleep(.05)
        self.temp.cleanup()

    def command(self, args, env=None, check=True):
        return subprocess.run(args, env=env or self.env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True, check=check)

    def install(self):
        return self.command([sys.executable, str(self.source / 'install.py'),
                             '--install-dir', str(self.target)])

    def fake_runtime(self):
        self.install()
        (self.target / 'supervisor.py').write_text('''import os,threading
from discovery import discover
stopped=threading.Event()
def stop_handler(*args): stopped.set()
def main():
    discover(os.environ['MULTICORTEX_AGENT_STATE_DIR'])
    print('fake-runtime-ready',flush=True)
    while not stopped.wait(.05): pass
''')

    def env_for(self, name, pod_id='pod-one'):
        state = self.root / name
        if state not in self.states:
            self.states.append(state)
        return dict(self.env, MULTICORTEX_AGENT_STATE_DIR=str(state), RUNPOD_POD_ID=pod_id)

    def boot(self, env, check=True):
        return self.command([sys.executable, str(self.target / 'template_boot.py')], env=env, check=check)

    def wait_identity(self, state):
        for _ in range(40):
            path = state / 'agent-id'
            if path.exists():
                return path.read_text()
            time.sleep(.05)
        self.fail('Identity not created by fake runtime')

    def test_installer_has_no_runtime_side_effects(self):
        self.install()
        expected = set(packager.FILES)
        self.assertEqual({p.name for p in self.target.iterdir()}, expected)
        self.assertFalse((self.root / 'state').exists())
        for path in self.target.iterdir():
            self.assertNotIn(b'a' * 64, path.read_bytes())
        self.assertEqual((self.target / 'entrypoint-agent.sh').stat().st_mode & 0o777, 0o755)

    def test_installer_refuses_tampering(self):
        (self.source / 'supervisor.py').write_text('print("tampered")')
        result = self.command([sys.executable, str(self.source / 'install.py'),
                               '--install-dir', str(self.target)], check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.target.exists())

    def test_installer_does_not_overwrite(self):
        self.target.mkdir()
        marker = self.target / 'keep'
        marker.write_text('unchanged')
        result = self.command([sys.executable, str(self.source / 'install.py'),
                               '--install-dir', str(self.target)], check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(marker.read_text(), 'unchanged')

    def test_default_state_is_scoped_by_pod(self):
        one, _ = boot_module.select_state({'RUNPOD_POD_ID': 'one'})
        two, _ = boot_module.select_state({'RUNPOD_POD_ID': 'two'})
        base = '/workspace' if os.path.isdir('/workspace') else '/root'
        self.assertEqual(one, base + '/devcore-agent-state/one')
        with mock.patch.object(boot_module.os.path, 'isdir', return_value=False):
            self.assertEqual(boot_module.select_state({'RUNPOD_POD_ID': 'x'})[0], '/root/devcore-agent-state/x')
        with mock.patch.object(boot_module.os.path, 'isdir', return_value=True):
            self.assertEqual(boot_module.select_state({'RUNPOD_POD_ID': 'x'})[0], '/workspace/devcore-agent-state/x')
        self.assertNotEqual(one, two)
        for value in ('../bad', 'bad/id'):
            with self.assertRaises(RuntimeError):
                boot_module.select_state({'RUNPOD_POD_ID': value})
        with self.assertRaises(RuntimeError):
            boot_module.select_state({})

    def test_two_pods_get_distinct_identities(self):
        self.fake_runtime()
        first = self.env_for('one', 'pod-one')
        second = self.env_for('two', 'pod-two')
        self.boot(first)
        self.boot(second)
        a = self.wait_identity(self.root / 'one')
        b = self.wait_identity(self.root / 'two')
        self.assertNotEqual(a, b)
        self.assertFalse((self.root / 'one/operational-token').exists())
        self.assertEqual((self.root / 'one/service-config.json').stat().st_mode & 0o777, 0o600)

    def test_restart_same_pod_without_bootstrap_reuses_state(self):
        self.fake_runtime()
        env = self.env_for('state')
        self.boot(env)
        original = self.wait_identity(self.root / 'state')
        service = [sys.executable, str(self.target / 'agent_service.py')]
        self.command(service + ['stop'], env=env)
        for _ in range(30):
            if 'Parado' in self.command(service + ['status'], env=env).stdout:
                break
            time.sleep(.05)
        env.pop('MULTICORTEX_BOOTSTRAP_TOKEN')
        env.pop('MULTICORTEX_MONITOR_URL')
        self.boot(env)
        self.assertEqual(self.wait_identity(self.root / 'state'), original)
        self.assertIn('Em execução', self.command(service + ['status'], env=env).stdout)

    def test_cloned_state_rejected(self):
        self.fake_runtime()
        env = self.env_for('state')
        self.boot(env)
        original = self.wait_identity(self.root / 'state')
        env['RUNPOD_POD_ID'] = 'different-pod'
        result = self.boot(env, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.wait_identity(self.root / 'state'), original)
        self.assertNotIn('a' * 64, result.stdout + result.stderr)

    def test_manual_existing_identity_not_implicitly_adopted(self):
        self.fake_runtime()
        env = self.env_for('state')
        state = self.root / 'state'
        state.mkdir()
        (state / 'agent-id').write_text('manual-id')
        self.assertNotEqual(self.boot(env, check=False).returncode, 0)
        self.assertEqual((state / 'agent-id').read_text(), 'manual-id')

    def test_missing_bootstrap_never_starts_agent(self):
        self.fake_runtime()
        env = self.env_for('state')
        env.pop('MULTICORTEX_BOOTSTRAP_TOKEN')
        result = self.boot(env, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'state/agent-id').exists())
        self.assertFalse((self.root / 'state/service-config.json').exists())

    def test_wrapper_preserves_model_arguments_and_exit(self):
        self.fake_runtime()
        env = self.env_for('state')
        code = 'import os,sys,json;print(json.dumps([sys.argv[1:], "MULTICORTEX_BOOTSTRAP_TOKEN" in os.environ]));sys.exit(7)'
        result = self.command([str(self.target / 'entrypoint-agent.sh'), sys.executable,
                               '-c', code, 'model with spaces', '--port', '7080'], env=env, check=False)
        self.assertEqual(result.returncode, 7)
        record = json.loads(result.stdout.splitlines()[-1])
        self.assertEqual(record, [['model with spaces', '--port', '7080'], False])
        self.wait_identity(self.root / 'state')

    def test_wrapper_keeps_model_available_on_agent_failure(self):
        self.fake_runtime()
        env = self.env_for('state')
        env.pop('MULTICORTEX_BOOTSTRAP_TOKEN')
        result = self.command([str(self.target / 'entrypoint-agent.sh'), sys.executable,
                               '-c', 'print("model-started")'], env=env)
        self.assertIn('model-started', result.stdout)
        self.assertIn('Monitoramento indisponível', result.stderr)
        self.assertFalse((self.root / 'state/agent-id').exists())

    def test_secret_file_and_mismatched_configuration(self):
        self.fake_runtime()
        env = self.env_for('state')
        env.pop('MULTICORTEX_BOOTSTRAP_TOKEN')
        secret = self.root / 'secret'
        secret.write_text('a' * 64)
        secret.chmod(0o600)
        env['MULTICORTEX_BOOTSTRAP_TOKEN_FILE'] = str(secret)
        self.boot(env)
        secret.write_text('b' * 64)
        result = self.boot(env, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('b' * 64, result.stdout + result.stderr)
        config = json.loads((self.root / 'state/service-config.json').read_text())
        self.assertEqual(config['bootstrap_token'], 'a' * 64)


if __name__ == '__main__':
    unittest.main()
