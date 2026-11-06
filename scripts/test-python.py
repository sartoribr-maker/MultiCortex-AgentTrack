#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path
root=Path(__file__).resolve().parents[1]
loader=unittest.TestLoader()
suites=[]
# Separate discover calls preserve the projects' existing import conventions.
for relative in ('infra/devcore-vm-agent/tests','infra/devcore-universal-agent/tests','tests/maintenance'):
 suites.append(unittest.TestLoader().discover(str(root/relative)))
result=unittest.TextTestRunner(verbosity=1).run(unittest.TestSuite(suites))
sys.exit(0 if result.wasSuccessful() else 1)
