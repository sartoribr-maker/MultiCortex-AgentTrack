import "server-only";
import { blockedByPoc, agentPoc, pocMode, PocError } from "./poc-store";

import {
  mkdirSync, readFileSync, writeFileSync, renameSync,
  openSync, closeSync, fsyncSync, unlinkSync, statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  randomBytes, createHash, timingSafeEqual,
} from "node:crypto";

export type AgentStatus = "pending" | "approved" | "revoked";

export type UniversalAgent = {
  id: string;
  podId: string | null;
  hostname: string | null;
  version: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  enrollmentHash: string;
  credentialHash: string | null;
  credentialIssuedAt: string | null;
  credentialGeneration?: number;
};

type Registry = { agents: UniversalAgent[]; audit?: { at: string; action: string; agentId: string; actor: string; reason: string; generation: number }[] };

const FILE = process.env.DEVCORE_AGENTS_FILE ||
  "/var/lib/devcore-monitor/agents.json";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equals(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

function read(): Registry {
  try {
    const value = JSON.parse(readFileSync(/* turbopackIgnore: true */ FILE, "utf8"));
    if (!value || !Array.isArray(value.agents)) {
      throw new Error("Registry inválido");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { agents: [] };
    }
    throw error;
  }
}

function write(data: Registry): void {
  const dir = dirname(FILE);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, ".agents-" + randomBytes(8).toString("hex"));
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(data, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, FILE);
}

function update<T>(fn: (data: Registry) => T): T {
  const lock = FILE + ".lock";
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  let fd: number | undefined;

  try {
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      // Fail closed: never remove an active lock automatically.
      const age = Date.now() - statSync(lock).mtimeMs;

      if (age < 60000) {
        throw new Error("Registry ocupado");
      }

      throw new Error(
        "Lock antigo detectado; recuperação administrativa necessária"
      );
    }
    const data = read();
    const result = fn(data);
    write(data);
    return result;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
}

function safe(agent: UniversalAgent) {
  const { enrollmentHash, credentialHash, ...publicData } = agent;
  void enrollmentHash;
  void credentialHash;
  return publicData;
}

export function listUniversalAgents() {
  return read().agents.map(safe);
}

export function enrollUniversalAgent(identity: {
  agent_id: string;
  pod_id?: string | null;
  hostname?: string;
  agent_version?: string;
  enrollment_key: string;
}) {
  return update((data) => {
    const existing = data.agents.find(a => a.id === identity.agent_id);
    const enrollmentHash = hash(identity.enrollment_key);

    if (existing) {
      if (!equals(existing.enrollmentHash, enrollmentHash)) {
        throw new Error("Identidade não autorizada");
      }
      if (identity.agent_version && existing.version !== identity.agent_version) {
        existing.version = identity.agent_version;
        existing.updatedAt = new Date().toISOString();
      }
      return safe(existing);
    }

    const now = new Date().toISOString();
    const agent: UniversalAgent = {
      id: identity.agent_id,
      podId: identity.pod_id || null,
      hostname: identity.hostname || null,
      version: identity.agent_version || "unknown",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      enrollmentHash,
      credentialHash: null,
      credentialIssuedAt: null,
    };
    data.agents.push(agent);
    return safe(agent);
  });
}

export function getUniversalAgentStatus(id: string, key: string) {
  const agent = read().agents.find(a => a.id === id);
  if (!agent || !equals(agent.enrollmentHash, hash(key))) {
    return null;
  }
  return { status: blockedByPoc(id) ? "revoked" as const : agent.status,
    ...(agent.credentialGeneration ? { credential_generation: agent.credentialGeneration } : {}) };
}

export function changeUniversalAgentStatus(
  id: string, status: "approved" | "revoked",
) {
  return update((data) => {
    const agent = data.agents.find(a => a.id === id);
    if (!agent) return null;

    if (status === "approved") {
      if (pocMode() && agentPoc(id)?.status !== "active") {
        throw new PocError("Vincule o agente a uma POC ativa antes de autorizar");
      }
      if (agent.status === "approved") return { agent: safe(agent) };
      if (pocMode() && agent.status === "revoked") throw new PocError("Agente revogado exige recuperação administrativa de credencial");
    }
    agent.status = status;
    agent.updatedAt = new Date().toISOString();

    if (status === "approved") {
      // Approval only changes state.
      // The agent must authenticate separately to obtain its token.
      agent.credentialHash = null;
      agent.credentialIssuedAt = null;
      return { agent: safe(agent) };
    }

    agent.credentialHash = null;
    agent.credentialIssuedAt = null;
    return { agent: safe(agent) };
  });
}

export function verifyUniversalAgentToken(id: string, token: string) {
  const agent = read().agents.find(a => a.id === id);
  return !!(
    agent &&
    !blockedByPoc(id) &&
    agent.status === "approved" &&
    agent.credentialHash &&
    equals(agent.credentialHash, hash(token))
  );
}


export function issueUniversalAgentCredential(id: string, enrollmentKey: string) {
  return update((data) => {
    const agent = data.agents.find(a => a.id === id);

    if (
      !agent ||
      blockedByPoc(id) ||
      agent.status !== "approved" ||
      !equals(agent.enrollmentHash, hash(enrollmentKey))
    ) {
      return null;
    }

    // Prevent accidental credential rotation.
    // A new approval is required to reset issuance.
    if (agent.credentialHash) {
      return null;
    }

    const token = randomBytes(32).toString("hex");
    agent.credentialHash = hash(token);
    agent.credentialIssuedAt = new Date().toISOString();
    agent.updatedAt = agent.credentialIssuedAt;

    return { token, agent: safe(agent) };
  });
}


/** Explicit admin reapproval; never called automatically on authentication failure. */
export function resetUniversalAgentCredential(id: string, actor: string, reason: string) {
  return update(data => {
    const agent = data.agents.find(a => a.id === id);
    if (!agent) throw new PocError("Agente não encontrado", 404);
    if (!pocMode() || agentPoc(id)?.status !== "active") throw new PocError("Recuperação exige POC ativa e vinculada");
    const generation = agent.credentialGeneration ?? 0;
    if (!Number.isSafeInteger(generation) || generation < 0 || generation >= 2147483647) throw new PocError("Geração de credencial inválida");
    if (!actor || reason.trim().length < 10 || reason.length > 400 || /Bearer\s|[a-f0-9]{64}/i.test(reason)) throw new PocError("Informe um motivo sem credenciais", 400);
    agent.credentialGeneration = generation + 1;
    agent.status = "approved";
    agent.credentialHash = null;
    agent.credentialIssuedAt = null;
    agent.updatedAt = new Date().toISOString();
    data.audit = [...(data.audit ?? []), { at: agent.updatedAt, action: "credential-reset-and-reapproval", agentId: id, actor, reason, generation: agent.credentialGeneration }].slice(-10000);
    return safe(agent);
  });
}
