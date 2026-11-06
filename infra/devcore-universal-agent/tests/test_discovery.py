import importlib.util
import os
import tempfile
import unittest
import uuid


AGENT_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "discovery.py")
)

spec = importlib.util.spec_from_file_location("discovery", AGENT_PATH)
discovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(discovery)


class DiscoveryTests(unittest.TestCase):

    def test_runpod_detection(self):
        result = discovery.detect_environment({
            "RUNPOD_POD_ID": "pod-teste-001"
        })
        self.assertEqual(result["platform"], "runpod")
        self.assertEqual(result["pod_id"], "pod-teste-001")

    def test_unknown_platform(self):
        result = discovery.detect_environment({})
        self.assertEqual(result["platform"], "unknown")
        self.assertIsNone(result["pod_id"])

    def test_agent_id_persistence(self):
        with tempfile.TemporaryDirectory() as state_dir:
            first = discovery.get_agent_id(state_dir)
            second = discovery.get_agent_id(state_dir)
            self.assertEqual(first, second)
            self.assertEqual(str(uuid.UUID(first)), first)

    def test_discovery_output(self):
        with tempfile.TemporaryDirectory() as state_dir:
            result = discovery.discover(
                state_dir,
                {"RUNPOD_POD_ID": "pod-teste-002"}
            )
            self.assertEqual(result["pod_id"], "pod-teste-002")
            self.assertEqual(result["agent_version"], "2.1.0-rc1")
            self.assertIn("agent_id", result)
            self.assertIn("hostname", result)


if __name__ == "__main__":
    unittest.main()
