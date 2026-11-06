import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { historyDay, readGpuHistory, recordGpuHistory } from "../src/lib/devcore/telemetry-history";
import { combineGpuHistory, gpuDayStats } from "../src/lib/devcore/poc-dashboard-model";
import type { PodView } from "../src/lib/devcore/poc-model";

test("GPU history records measured buckets and preserves missing values", async t => {
  const directory = mkdtempSync(join(tmpdir(), "devcore-history-"));
  process.env.DEVCORE_TELEMETRY_DIR = directory;
  const id = randomUUID(), other = randomUUID();
  const date = new Date("2026-11-06T15:01:00Z");
  const sample = (u: number, used: number) => ({ metrics: { gpu: { devices: [{ name: "test", utilization_percent: u, memory_used_mib: used, memory_total_mib: 8192 }] } } });
  try {
    await t.test("unmeasured periods return no points instead of zero", () => {
      assert.deepEqual(readGpuHistory(id, date), []);
      assert.deepEqual(gpuDayStats([]), { average: null, maximum: null, memoryMax: null });
      recordGpuHistory(id, { metrics: {} }, date);
      assert.deepEqual(readGpuHistory(id, date), []);
    });
    await t.test("five-minute buckets average utilization and retain peak memory", () => {
      recordGpuHistory(id, sample(20, 2048), date);
      recordGpuHistory(id, sample(60, 4096), new Date("2026-11-06T15:04:00Z"));
      const points = readGpuHistory(id, date);
      assert.equal(points.length, 1);
      assert.equal(points[0].utilization, 40);
      assert.equal(points[0].memoryUsed, 4096);
      assert.equal(points[0].samples, 2);
      assert.equal(points[0].maximum, 60);
      assert.equal(points[0].t, "2026-11-06T15:00:00.000Z");
      const path = join(directory, "gpu-history", id, "2026-11-06.json");
      assert.equal(statSync(path).mode & 0o777, 0o600);
    });
    await t.test("missing buckets stay missing; days use São Paulo timezone", () => {
      recordGpuHistory(id, sample(0, 1024), new Date("2026-11-06T15:16:00Z"));
      assert.equal(readGpuHistory(id, date).length, 2);
      assert.equal(historyDay(new Date("2026-11-06T02:59:00Z")), "2026-11-05");
      assert.deepEqual(readGpuHistory(id, new Date("2026-11-07T15:00:00Z")), []);
      assert.equal(gpuDayStats(readGpuHistory(id, date)).average, 80 / 3);
    });
    await t.test("POD isolation and unknown utilization are preserved", () => {
      recordGpuHistory(other, { metrics: { gpu: { devices: [{ name: "unknown" }] } } }, date);
      assert.equal(readGpuHistory(other, date)[0].utilization, null);
      assert.equal(readGpuHistory(other, date)[0].memoryUsed, null);
      const pods = [{ gpuHistory: readGpuHistory(id, date) }, { gpuHistory: readGpuHistory(other, date) }] as PodView[];
      const combined = combineGpuHistory(pods);
      assert.equal(combined.length, 2);
      assert.equal(combined[0].utilization, 40);
      assert.equal(combined[0].memoryUsed, 4096);
      assert.equal(gpuDayStats(combined).average, 80 / 3);
    });
    await t.test("corrupt history is not overwritten by the writer", () => {
      const path = join(directory, "gpu-history", id, "2026-11-06.json");
      writeFileSync(path, "corrupt");
      assert.throws(() => recordGpuHistory(id, sample(10, 100), date));
      assert.equal(readFileSync(path, "utf8"), "corrupt");
      assert.equal(readdirSync(join(directory, "gpu-history", id)).length, 1);
    });
    await t.test("rejects path traversal", () => {
      assert.throws(() => recordGpuHistory("../../invalid", sample(10, 100), date));
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
