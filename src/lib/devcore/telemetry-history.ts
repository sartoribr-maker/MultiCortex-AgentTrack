import "server-only";
import { pruneGpuHistory } from "./history-retention";
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { normalizeTelemetry } from "./poc-telemetry";
import type { GpuHistoryPoint } from "./poc-model";

const nullable = z.number().finite().nonnegative().nullable();
const schema = z.array(z.object({ t: z.string().datetime(), utilization: nullable, maximum: nullable.optional(),
  memoryUsed: nullable, memoryTotal: nullable, samples: z.number().int().positive() })).max(288);
export function historyDay(now: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function file(agentId: string, now: Date) {
  if (!/^[a-f0-9-]{36}$/.test(agentId)) throw new Error("Identificador inválido");
  return join(process.env.DEVCORE_TELEMETRY_DIR || "/var/lib/devcore-monitor/telemetry", "gpu-history", agentId, historyDay(now) + ".json");
}
function readStrict(agentId: string, now: Date): GpuHistoryPoint[] {
  try { return schema.parse(JSON.parse(readFileSync(/* turbopackIgnore: true */ file(agentId, now), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export function readGpuHistory(agentId: string, now = new Date()): GpuHistoryPoint[] {
  try { return readStrict(agentId, now); }
  catch { console.error("[devcore] Histórico de GPU indisponível"); return []; }
}
export function recordGpuHistory(agentId: string, raw: unknown, now = new Date()) {
  pruneGpuHistory(agentId, now);
  const snapshot = normalizeTelemetry(raw);
  if (!snapshot.devices.length) return;
  const utilizations = snapshot.devices.flatMap(d => d.utilization === null ? [] : [d.utilization]);
  const memories = snapshot.devices.flatMap(d => d.memoryUsed === null ? [] : [d.memoryUsed]);
  const totals = snapshot.devices.flatMap(d => d.memoryTotal === null ? [] : [d.memoryTotal]);
  const point: GpuHistoryPoint = {
    t: new Date(Math.floor(now.getTime() / 300000) * 300000).toISOString(),
    utilization: utilizations.length ? utilizations.reduce((a, b) => a + b, 0) / utilizations.length : null,
    maximum: utilizations.length ? Math.max(...utilizations) : null,
    memoryUsed: memories.length ? memories.reduce((a, b) => a + b, 0) : null,
    memoryTotal: totals.length ? totals.reduce((a, b) => a + b, 0) : null, samples: 1,
  };
  const path = file(agentId, now), points = readStrict(agentId, now);
  const existing = points.find(p => p.t === point.t);
  if (existing) {
    // Count only measured samples; unknown measurements never become zero.
    // A bucket with partial/missing utilization is kept unknown rather than imputed.
    existing.utilization = existing.utilization === null || point.utilization === null ? null
      : (existing.utilization * existing.samples + point.utilization) / (existing.samples + 1);
    existing.maximum = existing.maximum === null || existing.maximum === undefined ? point.maximum : point.maximum === null || point.maximum === undefined ? existing.maximum : Math.max(existing.maximum, point.maximum);
    existing.memoryUsed = existing.memoryUsed === null ? point.memoryUsed : point.memoryUsed === null ? existing.memoryUsed : Math.max(existing.memoryUsed, point.memoryUsed);
    existing.memoryTotal = point.memoryTotal;
    existing.samples++;
  } else { points.push(point); points.sort((a, b) => a.t.localeCompare(b.t)); }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path + ".tmp-" + randomBytes(8).toString("hex");
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(schema.parse(points))); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
