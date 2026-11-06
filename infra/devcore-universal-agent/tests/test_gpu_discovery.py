import importlib.util
import os
import subprocess
import unittest
from unittest.mock import patch


MODULE_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "gpu_discovery.py")
)
spec = importlib.util.spec_from_file_location("gpu_discovery", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GPUDiscoveryTests(unittest.TestCase):

    def test_h200_real_sample(self):
        sample = (
            "0, NVIDIA H200 NVL, GPU-TEST-001, "
            "143771, 128597, 0, 32\n"
        )
        devices = module.parse_gpu_output(sample)
        self.assertEqual(len(devices), 1)
        self.assertEqual(devices[0]["name"], "NVIDIA H200 NVL")
        self.assertEqual(devices[0]["memory_free_mib"], 15174)
        self.assertEqual(devices[0]["utilization_percent"], 0)
        self.assertEqual(devices[0]["temperature_c"], 32)

    def test_multiple_gpus(self):
        sample = (
            "0, NVIDIA H200 NVL, GPU-001, 143771, 128597, 45, 42\n"
            "1, NVIDIA L40S, GPU-002, 46068, 12000, 75, 55\n"
        )
        devices = module.parse_gpu_output(sample)
        self.assertEqual(len(devices), 2)
        self.assertEqual(devices[1]["memory_free_mib"], 34068)

    def test_unavailable_values(self):
        sample = "0, NVIDIA GPU, GPU-003, 46068, N/A, N/A, N/A\n"
        devices = module.parse_gpu_output(sample)
        self.assertIsNone(devices[0]["memory_used_mib"])
        self.assertIsNone(devices[0]["memory_free_mib"])
        self.assertIsNone(devices[0]["temperature_c"])

    def test_invalid_output(self):
        self.assertEqual(module.parse_gpu_output("invalid\n"), [])

    def test_missing_nvidia_smi(self):
        with patch.object(
            module.subprocess,
            "check_output",
            side_effect=FileNotFoundError()
        ):
            result = module.discover_gpus()
        self.assertFalse(result["available"])
        self.assertEqual(result["count"], 0)

    def test_nvidia_smi_failure(self):
        with patch.object(
            module.subprocess,
            "check_output",
            side_effect=subprocess.CalledProcessError(1, "nvidia-smi")
        ):
            result = module.discover_gpus()
        self.assertFalse(result["available"])

    def test_nvidia_smi_timeout(self):
        with patch.object(
            module.subprocess,
            "check_output",
            side_effect=subprocess.TimeoutExpired("nvidia-smi", 5)
        ):
            result = module.discover_gpus()
        self.assertFalse(result["available"])

    def test_successful_discovery(self):
        sample = "0, NVIDIA H200 NVL, GPU-001, 143771, 128597, 0, 32\n"
        with patch.object(
            module.subprocess,
            "check_output",
            return_value=sample
        ):
            result = module.discover_gpus()
        self.assertTrue(result["available"])
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["devices"][0]["name"], "NVIDIA H200 NVL")


if __name__ == "__main__":
    unittest.main()
