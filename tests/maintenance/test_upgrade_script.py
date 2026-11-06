import ast
import importlib.util
from pathlib import Path
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]
s=importlib.util.spec_from_file_location('upgrade',str(ROOT/'scripts/prepare-pod-upgrade.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class UpgradeTests(unittest.TestCase):
 def test_generated_payload_has_valid_python36_and_no_baked_secrets(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'kit.zip';p.write_bytes(b'fixture-package')
   text=m.make(p,'aa6fd47c-2d3d-4972-8e02-f6645bb0ea85',True)
   python=text.split("<<'DEVCORE_UPGRADE'\n",1)[1].rsplit('\nDEVCORE_UPGRADE',1)[0]
   ast.parse(python,feature_version=(3,6))
   self.assertIn("assert protocol=='2'",python)
   self.assertIn('assert discover_servers()==model_before',python)
   self.assertNotIn('BOOTSTRAP_TOKEN=',python)
   self.assertIn('source-before-upgrade',python)
if __name__=='__main__':unittest.main()
