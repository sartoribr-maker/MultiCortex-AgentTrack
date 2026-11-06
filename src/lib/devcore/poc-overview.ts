import "server-only";
import { readOperational } from "./operational-store";
import { readPocs } from "./poc-store";
import { listUniversalAgents } from "./agent-registry";
import { getUniversalTelemetry } from "./agent-telemetry-store";
import { normalizeTelemetry } from "./poc-telemetry";
export { normalizeTelemetry } from "./poc-telemetry";
import { readGpuHistory } from "./telemetry-history";
import type { PocOverview } from "./poc-model";

export function pocOverview(): PocOverview {
  const agents = listUniversalAgents();
  const pocs = readPocs();
  const linked = new Set(pocs.flatMap(p => p.pods.flatMap(pod => pod.agentId ? [pod.agentId] : [])));
  return { updatedAt: new Date().toISOString(), unassignedAgents: agents.filter(a => !linked.has(a.id)),
    pocs: pocs.map(poc => ({ ...poc, pods: poc.pods.map(pod => {
      const agent = agents.find(a => a.id === pod.agentId) ?? null;
      const raw = agent ? getUniversalTelemetry(agent.id) : null;
      const snapshot = normalizeTelemetry(raw);
      return { ...pod, ...snapshot, operationalProblem: raw?.metrics?.operational?.reason ?? null, operational: agent ? readOperational(agent.id, raw?.metrics?.operational, poc.status === "active" && agent.status === "approved" && snapshot.online) : null, gpuHistory: agent ? readGpuHistory(agent.id) : [], online: poc.status === "active" && agent?.status === "approved" && snapshot.online,
        agent: agent && poc.status === "closed" ? { ...agent, status: "revoked" as const } : agent };
    }) })) };
}
