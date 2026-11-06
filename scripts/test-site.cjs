// Run each node:test TS entry directly so nested test counts remain visible.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.ts')).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--require', './tests/server-only-stub.cjs', '--import', 'tsx', path.join('tests', file)], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
