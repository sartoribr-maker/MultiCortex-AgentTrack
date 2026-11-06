import "server-only";
import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { operationalSchema, type OperationalPayload, type OperationalView } from "./operational-schema";
import { historyDay } from "./telemetry-history";
import { retentionDays, retentionCutoff, pruneGpuHistory } from "./history-retention";
export { retentionDays } from "./history-retention";
import { metricsSchemaV1 } from "./metrics-schema";

const dailySchema = metricsSchemaV1.shape.daily;
function root(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Identificador inválido");
  return join(process.env.DEVCORE_TELEMETRY_DIR || "/var/lib/devcore-monitor/telemetry", "operational-history", id);
}
export function atomicPrivate(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + ".tmp-" + randomBytes(8).toString("hex");
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
function read(path: string): unknown {
  try { return JSON.parse(readFileSync(/* turbopackIgnore: true */ path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function saveOperational(id: string, input: OperationalPayload, now = new Date()) {
  const value = operationalSchema.parse(input);
  if (!value.metrics || value.status !== "available") return;
  const folder = root(id), generated = Date.parse(value.metrics.generated_at);
  if (!Number.isFinite(generated) || generated > now.getTime() + 10000 || now.getTime() - generated > 180000) throw new Error("Fonte operacional atrasada");
  if (value.metrics.today.date !== historyDay(new Date(generated))) throw new Error("Dia operacional inconsistente");
  const old = read(join(folder, "latest.json"));
  if (old && Date.parse(z.object({ metrics: metricsSchemaV1 }).parse(old).metrics.generated_at) > generated) return;
  const previous = dailySchema.parse(read(join(folder, "daily.json")) ?? []);
  const days = new Map(previous.map(day => [day.date, day]));
  for (const day of value.metrics.daily) if (/^\d{4}-\d{2}-\d{2}$/.test(day.date)) days.set(day.date, day);
  const cutoff = historyDay(new Date(now.getTime() - (retentionDays() - 1) * 86400000));
  const daily = [...days.values()].filter(day => day.date >= cutoff && day.date <= historyDay(now)).sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
  // Daily records never include developer identifiers or request bodies.
  atomicPrivate(join(folder, "daily.json"), dailySchema.parse(daily));
  atomicPrivate(join(folder, "latest.json"), { ...value, metrics: { ...value.metrics, daily }, receivedAt: now.toISOString() });
}
export function readOperational(id: string, current: unknown, online: boolean, now = Date.now()): OperationalView | null {
  try {
    pruneGpuHistory(id, new Date(now));
    const stored = read(join(root(id), "latest.json"));
    if (!stored) return null;
    const parsed = operationalSchema.safeExtend({ receivedAt: z.string().datetime() }).parse(stored);
    const liveInput = operationalSchema.safeParse(current);
    const age = parsed.metrics ? now - Date.parse(parsed.metrics.generated_at) : Infinity;
    if (parsed.metrics) parsed.metrics.daily = parsed.metrics.daily.filter(day => day.date >= retentionCutoff(new Date(now)));
    return { ...parsed, fresh: online && liveInput.success && liveInput.data.status === "available" && age >= -10000 && age <= 180000 };
  } catch { console.error("[devcore] Resumo operacional indisponível"); return null; }
}
