import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import zipfile
import json
import hashlib

ROOT = Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('maintenance',str(ROOT/'scripts/agenttrack-state.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class StateTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.root=Path(self.tmp.name); self.source=self.root/'source';self.source.mkdir()
  (self.source/'state').mkdir();(self.source/'state/agents.json').write_text('{"agents":[]}')
  (self.source/'.env.agenttrack').write_text('AUTH_SECRET=test-secret-not-real\n')
  self.archive=self.root/'backup.zip'
 def test_roundtrip_integrity_and_private_modes(self):
  (self.source/'.env.release').write_text('AUTH_SECRET=release-fixture-only\n')
  (self.source/'docker-compose.release.yml').write_text('services: {}\n')
  m.backup(self.source,self.archive,True); m.verify(self.archive)
  target=self.root/'restored';m.restore(self.archive,target)
  self.assertEqual((target/'.env.agenttrack').read_bytes(),(self.source/'.env.agenttrack').read_bytes())
  self.assertEqual((target/'.env.release').read_bytes(),(self.source/'.env.release').read_bytes())
  self.assertEqual((target/'docker-compose.release.yml').read_bytes(),(self.source/'docker-compose.release.yml').read_bytes())
  self.assertEqual(self.archive.stat().st_mode&0o777,0o600)
  self.assertEqual((target/'.env.agenttrack').stat().st_mode&0o777,0o600)
  with self.assertRaises(ValueError):m.restore(self.archive,target)
 def test_requires_quiescence_and_never_overwrites_archive(self):
  with self.assertRaises(ValueError):m.backup(self.source,self.archive)
  m.backup(self.source,self.archive,True)
  with self.assertRaises(ValueError):m.backup(self.source,self.archive,True)
 def test_lock_or_symlink_refused(self):
  (self.source/'state/agents.json.lock').write_text('lock')
  with self.assertRaises(ValueError):m.backup(self.source,self.archive,True)
  (self.source/'state/agents.json.lock').unlink()
  (self.source/'state/link.json').symlink_to(self.source/'.env.agenttrack')
  with self.assertRaises(ValueError):m.backup(self.source,self.archive,True)
 def test_tampering_and_traversal_refused(self):
  for name,digest in [('state/agents.json','bad'),('../escape.json',hashlib.sha256(b'{}').hexdigest())]:
   with zipfile.ZipFile(self.archive,'w') as z:
    z.writestr(name,'{}');z.writestr('BACKUP-MANIFEST.json',json.dumps({'version':1,'sha256':{name:digest}}))
   with self.assertRaises(ValueError):m.verify(self.archive)

if __name__=='__main__':unittest.main()
