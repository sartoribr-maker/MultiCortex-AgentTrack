import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { operationalCoverage, type PodView } from "../src/lib/devcore/poc-model";
import { operationalSchema, type OperationalPayload } from "../src/lib/devcore/operational-schema";
import { saveOperational, readOperational } from "../src/lib/devcore/operational-store";
import { pruneGpuHistory } from "../src/lib/devcore/history-retention";

const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures/devcore-metrics.sample.json'), 'utf8'));
const live = JSON.parse(readFileSync(join(__dirname, 'fixtures/devcore-live.sample.json'), 'utf8'));
function payload(now: Date): OperationalPayload {
  const metrics = structuredClone(raw);
  metrics.generated_at = now.toISOString();
  metrics.today.date = new Date(now.getTime() - 3*3600000).toISOString().slice(0,10);
  metrics.today.developer_list = (metrics.today.developer_list ?? []).map((d: object, i: number) => ({ ...d, ip: 'dev-' + String(i).padStart(20,'0') }));
  const last = { ...metrics.daily.at(-1), date: metrics.today.date };
  metrics.daily = [last];
  return operationalSchema.parse({ version: 1, status: 'available', source: 'existing', reason: null, developer_identity: 'pseudonymous', metrics,
    live: { ...live, generated_at: now.toISOString() } });
}

test('Operational metrics schema, persistence, freshness and retention', async t => {
  const root = mkdtempSync(join(tmpdir(), 'devcore-operational-'));
  process.env.DEVCORE_TELEMETRY_DIR = root;
  process.env.DEVCORE_METRICS_RETENTION_DAYS = '90';
  const now = new Date('2026-11-06T18:00:00Z'), id = randomUUID(), other = randomUUID();
  const input = payload(now);
  try {
    await t.test('accepts complete metrics and rejects raw developer IPs or inconsistent status', () => {
      assert.ok(operationalSchema.safeParse(input).success);
      const invalid = structuredClone(input);
      invalid.metrics!.today.developer_list = [{ ...raw.today.developer_list[0], ip: '192.0.2.1' }];
      assert.equal(operationalSchema.safeParse(invalid).success, false);
      assert.equal(operationalSchema.safeParse({ ...input, status: 'unavailable' }).success, false);
    });
    await t.test('persists complete data privately and treats repeated POST as replacement', () => {
      saveOperational(id, input, now); saveOperational(id, input, now);
      const report = readOperational(id, input, true, now.getTime())!;
      assert.equal(report.fresh, true);
      assert.equal(report.metrics!.today.requests, input.metrics!.today.requests);
      assert.equal(report.metrics!.daily.length, 1);
      assert.equal(statSync(join(root, 'operational-history', id, 'latest.json')).mode & 0o777, 0o600);
      assert.equal(readOperational(other, input, true, now.getTime()), null);
    });
    await t.test('offline, unavailable and stale sources never appear live', () => {
      assert.equal(readOperational(id, input, false, now.getTime())!.fresh, false);
      assert.equal(readOperational(id, null, true, now.getTime())!.fresh, false);
      assert.equal(readOperational(id, input, true, now.getTime()+181000)!.fresh, false);
      assert.throws(() => saveOperational(id, input, new Date(now.getTime()+181000)));
      const bad = structuredClone(input); bad.metrics!.today.date = '2020-01-01';
      assert.throws(() => saveOperational(id, bad, now));
    });
    await t.test('daily history preserves distinct days and never retains developer identities', () => {
      const tomorrow = new Date(now.getTime()+86400000);
      saveOperational(id, payload(tomorrow), tomorrow);
      const daily = JSON.parse(readFileSync(join(root, 'operational-history', id, 'daily.json'), 'utf8'));
      assert.equal(daily.length, 2);
      assert.equal(JSON.stringify(daily).includes('dev-'), false);
      saveOperational(id, input, now);
      assert.equal(readOperational(id, payload(tomorrow), true, tomorrow.getTime())!.metrics!.today.date, '2026-11-07');
    });
    await t.test('central totals report coverage instead of inventing missing POD requests', () => {
      const report = readOperational(id, input, true, now.getTime())!;
      report.fresh = true;
      report.metrics!.today.date = '2026-11-06';
      const pod = { online: true, agent: { status: 'approved' }, operational: report } as PodView;
      const missing = { online: true, agent: { status: 'approved' }, operational: null } as PodView;
      const partial = operationalCoverage([pod, missing], now);
      assert.equal(partial.covered, 1); assert.equal(partial.total, 2); assert.equal(partial.complete, false);
      assert.equal(operationalCoverage([missing], now).requests, null);
    });
    await t.test('retention prunes only owned dated GPU files, not links or other state', () => {
      const folder = join(root, 'gpu-history', id); mkdirSync(folder, { recursive: true });
      const old = join(folder,'2020-01-01.json'), recent = join(folder,'2026-11-06.json');
      writeFileSync(old, '[]'); writeFileSync(recent,'[]'); writeFileSync(join(folder,'keep.txt'),'keep');
      const external = join(root,'external.json'); writeFileSync(external,'keep');
      symlinkSync(external,join(folder,'2020-01-02.json'));
      pruneGpuHistory(id, now);
      assert.equal(existsSync(old),false); assert.equal(existsSync(recent),true);
      assert.equal(readFileSync(external,'utf8'),'keep'); assert.equal(existsSync(join(folder,'keep.txt')),true);
    });
  } finally { rmSync(root,{ recursive:true, force:true }); }
});
