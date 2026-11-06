import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.script = self.root / 'agent_service.py'
        shutil.copyfile(str(Path(__file__).resolve().parents[1] / 'agent_service.py'), str(self.script))
        (self.root / 'supervisor.py').write_text('''import threading
import os
stop = threading.Event()
def stop_handler(*args): stop.set()
def main():
    print("fake-agent-ready", flush=True)
    with open(os.path.join(os.environ["MULTICORTEX_AGENT_STATE_DIR"], "observed"), "w") as f:
        f.write(os.environ["MULTICORTEX_MONITOR_URL"])
    while not stop.wait(0.05): pass
''')
        self.state = self.root / 'state'
        self.env = dict(os.environ, MULTICORTEX_AGENT_STATE_DIR=str(self.state),
                        MULTICORTEX_MONITOR_URL='https://example.invalid/agenttrack',
                        MULTICORTEX_BOOTSTRAP_TOKEN='a' * 64)

    def tearDown(self):
        self.cli('stop', check=False)
        for _ in range(30):
            if 'Parado' in self.cli('status').stdout:
                break
            time.sleep(.05)
        self.temp.cleanup()

    def cli(self, command, check=True, env=None):
        return subprocess.run([sys.executable, str(self.script), command],
                              env=env or self.env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True, check=check)

    def test_secure_configuration_no_overwrite(self):
        result = self.cli('configure')
        config = self.state / 'service-config.json'
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        self.assertNotIn('a' * 64, result.stdout + result.stderr)
        self.assertNotEqual(self.cli('configure', check=False).returncode, 0)
        self.assertEqual(json.loads(config.read_text())['bootstrap_token'], 'a' * 64)

    def test_missing_bootstrap_rejected(self):
        env = dict(self.env, MULTICORTEX_BOOTSTRAP_TOKEN='')
        self.assertNotEqual(self.cli('configure', check=False, env=env).returncode, 0)
        self.assertFalse((self.state / 'service-config.json').exists())

    def test_detached_start_stop_and_duplicate_start(self):
        self.cli('configure')
        self.cli('start')
        first = (self.state / 'service.pid').read_text()
        self.assertIn('Em execução', self.cli('status').stdout)
        self.cli('start')
        self.assertEqual(first, (self.state / 'service.pid').read_text())
        token = self.state / 'operational-token'
        token.write_text('b' * 64)
        self.cli('stop')
        for _ in range(30):
            if 'Parado' in self.cli('status').stdout:
                break
            time.sleep(.05)
        self.assertIn('Parado', self.cli('status').stdout)
        self.assertEqual(token.read_text(), 'b' * 64)
        log = (self.state / 'agent.log').read_text()
        self.assertIn('fake-agent-ready', log)
        self.assertNotIn('a' * 64, log)
        self.assertEqual((self.state / 'agent.log').stat().st_mode & 0o777, 0o600)

    def test_boot_environment_uses_persisted_configuration(self):
        self.cli('configure')
        env = dict(self.env)
        env.pop('MULTICORTEX_BOOTSTRAP_TOKEN')
        env.pop('MULTICORTEX_MONITOR_URL')
        self.cli('start', env=env)
        for _ in range(30):
            if (self.state / 'observed').exists():
                break
            time.sleep(.05)
        self.assertEqual((self.state / 'observed').read_text(), 'https://example.invalid/agenttrack')

    def test_symlink_configuration_rejected(self):
        self.cli('configure')
        config = self.state / 'service-config.json'
        config.rename(self.state / 'original.json')
        config.symlink_to(self.state / 'original.json')
        self.assertNotEqual(self.cli('start', check=False).returncode, 0)

    def test_stale_pid_never_stops_unrelated_process(self):
        self.cli('configure')
        (self.state / 'service.pid').write_text(str(os.getpid()))
        self.assertIn('Parado', self.cli('status').stdout)
        self.assertIn('Parado', self.cli('stop').stdout)


if __name__ == '__main__':
    unittest.main()
