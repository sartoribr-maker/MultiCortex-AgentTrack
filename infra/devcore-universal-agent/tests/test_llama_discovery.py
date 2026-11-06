import importlib.util
import os
import tempfile
import unittest


MODULE_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "llama_discovery.py")
)
spec = importlib.util.spec_from_file_location(
    "llama_discovery", MODULE_PATH
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LlamaDiscoveryTests(unittest.TestCase):

    def test_standard_parameters(self):
        result = module.parse_server(
            100, ["llama-server", "--port", "7080", "--parallel", "6"]
        )
        self.assertEqual(result["port"], 7080)
        self.assertEqual(result["slots"], 6)

    def test_equals_parameters(self):
        result = module.parse_server(
            200, ["llama-server", "--port=8000", "--parallel=12"]
        )
        self.assertEqual(result["port"], 8000)
        self.assertEqual(result["slots"], 12)

    def test_short_parameters(self):
        result = module.parse_server(
            300, ["llama-server", "-p", "8080", "-np", "4"]
        )
        self.assertEqual(result["port"], 8080)
        self.assertEqual(result["slots"], 4)

    def test_missing_parameters(self):
        result = module.parse_server(
            400, ["llama-server", "--model", "model.gguf"]
        )
        self.assertIsNone(result["port"])
        self.assertIsNone(result["slots"])

    def test_invalid_parameters(self):
        result = module.parse_server(
            500, ["llama-server", "--port", "99999", "--parallel", "0"]
        )
        self.assertIsNone(result["port"])
        self.assertIsNone(result["slots"])

    def test_unrelated_process(self):
        result = module.parse_server(
            600, ["python3", "llama-server", "--port", "9000"]
        )
        self.assertIsNone(result)

    def test_generic_server_without_parallel(self):
        result = module.parse_server(
            700, ["server", "--port", "8080"]
        )
        self.assertIsNone(result)

    def test_multicortex_gpu_nvidia(self):
        result = module.parse_server(
            4076,
            [
                "/usr/bin/multicortex-server-gpu-nvidia",
                "--host", "0.0.0.0",
                "--port", "7080",
                "--parallel", "6",
                "--ctx-size", "1572864",
            ]
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["pid"], 4076)
        self.assertEqual(result["port"], 7080)
        self.assertEqual(result["slots"], 6)

    def test_multiple_proc_entries(self):
        with tempfile.TemporaryDirectory() as proc:
            processes = {
                100: ["llama-server", "--port", "7080", "--parallel", "6"],
                200: ["llama-server", "--port=8000", "-np", "12"],
                300: ["python3", "llama-server", "--port", "9000"],
            }

            for pid, args in processes.items():
                directory = os.path.join(proc, str(pid))
                os.makedirs(directory)
                with open(os.path.join(directory, "cmdline"), "wb") as handle:
                    handle.write(
                        b"\0".join(a.encode("utf-8") for a in args) + b"\0"
                    )

            servers = module.discover_servers(proc)
            self.assertEqual(len(servers), 2)
            self.assertEqual([s["pid"] for s in servers], [100, 200])
            self.assertEqual([s["port"] for s in servers], [7080, 8000])
            self.assertEqual([s["slots"] for s in servers], [6, 12])


if __name__ == "__main__":
    unittest.main()
