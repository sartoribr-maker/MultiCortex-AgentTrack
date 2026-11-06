import importlib.util
import os
import unittest
import urllib.error
from unittest.mock import patch

MODULE_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "metrics_discovery.py")
)
spec = importlib.util.spec_from_file_location("metrics_discovery", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeResponse:
    def __init__(self, code):
        self.code = code

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def getcode(self):
        return self.code


class MetricsDiscoveryTests(unittest.TestCase):

    def test_available(self):
        with patch.object(
            module.urllib.request, "urlopen",
            return_value=FakeResponse(200)
        ):
            result = module.check_metrics(7080)
        self.assertEqual(result["status"], "available")

    def test_http_errors(self):
        expected = {
            401: "unauthorized",
            403: "forbidden",
            404: "not_found",
            501: "disabled_or_not_implemented",
        }

        for code, status in expected.items():
            with self.subTest(code=code):
                error = urllib.error.HTTPError(
                    "http://127.0.0.1:7080/metrics",
                    code, "Test", {}, None
                )
                with patch.object(
                    module.urllib.request, "urlopen",
                    side_effect=error
                ):
                    result = module.check_metrics(7080)

                self.assertEqual(result["status"], status)
                self.assertEqual(result["http_code"], code)

    def test_invalid_port(self):
        for port in (0, -1, 65536, "invalid", None):
            with self.subTest(port=port):
                result = module.check_metrics(port)
                self.assertEqual(result["status"], "invalid_port")

    def test_connection_failure(self):
        with patch.object(
            module.urllib.request, "urlopen",
            side_effect=urllib.error.URLError("connection refused")
        ):
            result = module.check_metrics(7080)
        self.assertEqual(result["status"], "unreachable")

    def test_authentication_header(self):
        with patch.object(
            module.urllib.request, "urlopen",
            return_value=FakeResponse(200)
        ) as mocked:
            module.check_metrics(7080, api_key="TEST-KEY")

        request = mocked.call_args[0][0]
        self.assertEqual(
            request.get_header("Authorization"),
            "Bearer TEST-KEY"
        )


if __name__ == "__main__":
    unittest.main()
