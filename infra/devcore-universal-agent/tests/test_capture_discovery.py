import importlib.util
import os
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "capture_discovery.py")
)
spec = importlib.util.spec_from_file_location("capture_discovery", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CaptureDiscoveryTests(unittest.TestCase):

    def test_linux_capabilities(self):
        with tempfile.NamedTemporaryFile(mode="w+", delete=True) as f:
            f.write("CapEff:\t0000000000002000\n")
            f.flush()
            result = module.linux_capabilities(f.name)

        self.assertTrue(result["readable"])
        self.assertTrue(result["net_raw"])
        self.assertFalse(result["net_admin"])

    def test_missing_capabilities(self):
        result = module.linux_capabilities("/nonexistent/status")
        self.assertFalse(result["readable"])

    def test_interfaces(self):
        output = (
            "1.eth0 [Up]\n"
            "2.any (Pseudo-device)\n"
            "3.lo [Loopback]\n"
        )
        with patch.object(
            module.subprocess, "check_output", return_value=output
        ):
            result = module.tcpdump_interfaces("/usr/sbin/tcpdump")

        self.assertEqual(result, ["eth0", "any", "lo"])

    def test_tcpdump_missing(self):
        with patch.object(module.shutil, "which", return_value=None):
            result = module.discover_capture()

        self.assertFalse(result["tcpdump_installed"])
        self.assertIsNone(result["preferred_interface"])
        self.assertFalse(result["monitoring_started"])

    def test_preferred_interface(self):
        with patch.object(
            module.shutil, "which", return_value="/usr/sbin/tcpdump"
        ), patch.object(
            module, "tcpdump_interfaces", return_value=["eth0", "any", "lo"]
        ):
            result = module.discover_capture()

        self.assertEqual(result["preferred_interface"], "any")
        self.assertFalse(result["capture_permission_verified"])
        self.assertFalse(result["monitoring_started"])


if __name__ == "__main__":
    unittest.main()
