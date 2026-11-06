import { z } from "zod";
import { brasiliaDate } from "./view";
import type { OperationalView } from "./operational-schema";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Data inválida");
export const pocInput = z.object({
  name: z.string().trim().min(1).max(120),
  client: z.string().trim().min(1).max(120),
  responsible: z.string().trim().min(1).max(160),
  startDate: day,
  endDate: day,
  notes: z.string().trim().max(2000).default(""),
}).strict().refine(value => value.endDate >= value.startDate, "Período inválido");
export const podInput = z.object({
  name: z.string().trim().min(1).max(120),
  podId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/),
  agentId: z.string().uuid().nullable().default(null),
}).strict();
export type PocInput = z.infer<typeof pocInput>;
export type PodInput = z.infer<typeof podInput>;
export type PocPod = PodInput & { id: string; createdAt: string };
export type Poc = PocInput & {
  id: string; status: "active" | "closed"; createdAt: string; updatedAt: string;
  closedAt: string | null; pods: PocPod[];
};
export type PublicAgent = {
  id: string; podId: string | null; hostname: string | null; version: string;
  status: "pending" | "approved" | "revoked";
};
export type GpuDevice = {
  index: number | null; name: string; utilization: number | null;
  memoryTotal: number | null; memoryUsed: number | null; temperature: number | null;
};
export type ServerInfo = { pid: number | null; executable: string; port: number | null; slots: number | null };
export type GpuHistoryPoint = { t: string; utilization: number | null; maximum?: number | null; memoryUsed: number | null; memoryTotal: number | null; samples: number };
export type PodView = PocPod & {
  agent: PublicAgent | null; online: boolean; receivedAt: string | null;
  devices: GpuDevice[]; servers: ServerInfo[]; gpuHistory?: GpuHistoryPoint[]; operational?: OperationalView | null; operationalProblem?: string | null;
};
export type PocView = Omit<Poc, "pods"> & { pods: PodView[] };
export type PocOverview = { pocs: PocView[]; unassignedAgents: PublicAgent[]; updatedAt: string };

export function summarizePods(pods: PodView[]) {
  const approved = pods.filter(p => p.agent?.status === "approved");
  const online = approved.filter(p => p.online);
  const devices = online.flatMap(p => p.devices);
  const utilization = devices.map(d => d.utilization).filter((v): v is number => v !== null);
  return {
    total: pods.length, online: online.length,
    pending: pods.filter(p => !p.agent || p.agent.status === "pending").length,
    gpuCount: devices.length,
    gpuUtilization: utilization.length ? utilization.reduce((a, b) => a + b, 0) / utilization.length : null,
    memoryUsed: devices.reduce((sum, d) => sum + (d.memoryUsed ?? 0), 0),
    memoryTotal: devices.reduce((sum, d) => sum + (d.memoryTotal ?? 0), 0),
    slots: online.flatMap(p => p.servers).reduce((sum, s) => sum + (s.slots ?? 0), 0),
    attention: approved.some(p => !p.online || !p.operational?.fresh) || devices.some(d => (d.temperature ?? 0) >= 85
      || (d.memoryTotal !== null && d.memoryTotal > 0 && (d.memoryUsed ?? 0) / d.memoryTotal >= .95)),
  };
}

export function operationalCoverage(pods: PodView[], now = new Date()) {
  const today = brasiliaDate(now);
  const eligible = pods.filter(p => p.agent?.status === "approved");
  const measured = eligible.filter(p => p.online && p.operational?.fresh && p.operational.metrics?.today.date === today);
  return { covered: measured.length, total: eligible.length,
    requests: measured.length ? measured.reduce((sum, p) => sum + p.operational!.metrics!.today.requests, 0) : null,
    complete: eligible.length > 0 && measured.length === eligible.length };
}
