import importlib.util
from pathlib import Path
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]
s=importlib.util.spec_from_file_location('release_env',str(ROOT/'scripts/prepare-release-env.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class EnvTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.prod=self.root/'prod';self.stage=self.root/'stage';self.out=self.root/'out'
  self.original='AUTH_SECRET=keep-original\nAUTH_URL=https://devcore.multicortex.com.br\nDEVCORE_USERS=user@example.invalid:hash\nLEGACY_TOKEN="literal$with spaces"\n'
  self.prod.write_text(self.original);self.stage.write_text('DEVCORE_ADMIN_EMAILS=user@example.invalid\nDEVCORE_BOOTSTRAP_TOKEN='+'a'*64+'\n')
 def test_preserves_existing_secrets_and_legacy_variables(self):
  m.prepare(self.prod,self.stage,self.out)
  self.assertEqual(self.prod.read_text(),self.original);result=self.out.read_text()
  self.assertIn('AUTH_SECRET=keep-original',result);self.assertIn('LEGACY_TOKEN="literal$with spaces"',result)
  self.assertEqual(self.out.stat().st_mode&0o777,0o600)
 def test_refuses_unknown_admin_or_overwrite(self):
  self.stage.write_text('DEVCORE_ADMIN_EMAILS=other@example.invalid\nDEVCORE_BOOTSTRAP_TOKEN='+'a'*64+'\n')
  with self.assertRaises(ValueError):m.prepare(self.prod,self.stage,self.out)
  self.out.write_text('keep')
  self.stage.write_text('DEVCORE_ADMIN_EMAILS=user@example.invalid\nDEVCORE_BOOTSTRAP_TOKEN='+'a'*64+'\n')
  with self.assertRaises(FileExistsError):m.prepare(self.prod,self.stage,self.out)
if __name__=='__main__':unittest.main()
