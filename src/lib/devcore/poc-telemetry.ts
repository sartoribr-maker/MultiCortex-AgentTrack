import type { GpuDevice, ServerInfo } from "./poc-model";

type Obj = Record<string, unknown>;
function object(value: unknown): Obj { return value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {}; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function text(value: unknown): string { return typeof value === "string" ? value.slice(0, 160) : "Não informado"; }
export function normalizeTelemetry(raw: unknown, now = Date.now()) {
  const data = object(raw), metrics = object(data.metrics), gpu = object(metrics.gpu);
  const time = typeof data.receivedAt === "string" ? Date.parse(data.receivedAt) : NaN;
  const devices: GpuDevice[] = (Array.isArray(gpu.devices) ? gpu.devices : []).slice(0, 128).map(value => {
    const d = object(value);
    const utilization = number(d.utilization_percent);
    return { index: number(d.index), name: text(d.name), utilization: utilization !== null && utilization <= 100 ? utilization : null,
      memoryTotal: number(d.memory_total_mib), memoryUsed: number(d.memory_used_mib), temperature: number(d.temperature_c) };
  });
  const servers: ServerInfo[] = (Array.isArray(metrics.llama) ? metrics.llama : []).slice(0, 512).map(value => {
    const s = object(value);
    return { pid: number(s.pid), executable: text(s.executable), port: number(s.port), slots: number(s.slots) };
  });
  return { receivedAt: Number.isFinite(time) ? new Date(time).toISOString() : null,
    online: Number.isFinite(time) && now - time >= 0 && now - time < 90000, devices, servers };
}
