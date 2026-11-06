import "server-only";
import { readdirSync, unlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";

const cleaned = new Map<string, string>();
export function retentionDays() {
  const value = Number(process.env.DEVCORE_METRICS_RETENTION_DAYS || 90);
  if (!Number.isInteger(value) || value < 1 || value > 400) throw new Error("Retenção inválida");
  return value;
}
export function retentionCutoff(now = new Date()) {
  return new Date(now.getTime() - (retentionDays() - 1) * 86400000 - 3 * 3600000).toISOString().slice(0, 10);
}
/** Delete only our dated GPU buckets, never credentials, registries or other files. */
export function pruneGpuHistory(id: string, now = new Date()) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Identificador inválido");
  const directory = join(process.env.DEVCORE_TELEMETRY_DIR || "/var/lib/devcore-monitor/telemetry", "gpu-history", id);
  const cutoff = retentionCutoff(now);
  if (cleaned.get(directory) === cutoff) return;
  let names: string[];
  try { names = readdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const name of names) {
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < cutoff) {
      const path = join(directory, name);
      if (lstatSync(path).isFile()) unlinkSync(path);
    }
  }
  cleaned.set(directory, cutoff);
}
