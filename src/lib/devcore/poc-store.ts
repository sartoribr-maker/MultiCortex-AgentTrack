import "server-only";
import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { pocInput, podInput, type Poc, type PocInput, type PodInput } from "./poc-model";

export class PocError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
const row = pocInput.safeExtend({
  id: z.string().uuid(), status: z.enum(["active", "closed"]), createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(), closedAt: z.string().datetime().nullable(),
  pods: z.array(podInput.extend({ id: z.string().uuid(), createdAt: z.string().datetime() })),
});
const schema = z.object({ version: z.literal(1), pocs: z.array(row) }).strict();
type Registry = { version: 1; pocs: Poc[] };
function file() { return process.env.DEVCORE_POCS_FILE || "/var/lib/devcore-monitor/pocs.json"; }
export function pocMode() { return process.env.DEVCORE_POC_MODE === "1"; }
export function readPocs(): Poc[] {
  try { return schema.parse(JSON.parse(readFileSync(/* turbopackIgnore: true */ file(), "utf8"))).pocs; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function update<T>(fn: (data: Registry) => T): T {
  const path = file(), directory = dirname(path), lock = path + ".lock";
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PocError("Cadastro ocupado. Tente novamente; se persistir, contate a administração."); throw error; }
  let temporary: string | undefined;
  try {
    const data: Registry = { version: 1, pocs: readPocs() };
    const result = fn(data);
    schema.parse(data);
    temporary = join(directory, ".pocs-" + randomBytes(8).toString("hex"));
    const out = openSync(temporary, "wx", 0o600);
    try { writeFileSync(out, JSON.stringify(data, null, 2)); fsyncSync(out); } finally { closeSync(out); }
    renameSync(temporary, path); temporary = undefined;
    const dir = openSync(directory, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
    return result;
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch {} }
    closeSync(fd); unlinkSync(lock);
  }
}
function find(data: Registry, id: string) {
  const poc = data.pocs.find(p => p.id === id);
  if (!poc) throw new PocError("POC não encontrada", 404);
  return poc;
}
export function createPoc(input: PocInput) {
  const parsed = pocInput.parse(input);
  return update(data => {
    const now = new Date().toISOString();
    const poc: Poc = { ...parsed, id: randomUUID(), status: "active", createdAt: now, updatedAt: now, closedAt: null, pods: [] };
    data.pocs.push(poc); return poc;
  });
}
export function editPoc(id: string, input: PocInput) {
  const parsed = pocInput.parse(input);
  return update(data => {
    const poc = find(data, id);
    if (poc.status === "closed") throw new PocError("POC encerrada não pode ser alterada");
    Object.assign(poc, parsed, { updatedAt: new Date().toISOString() }); return poc;
  });
}
export function closePoc(id: string) {
  return update(data => {
    const poc = find(data, id);
    if (poc.status !== "closed") {
      poc.status = "closed"; poc.closedAt = poc.updatedAt = new Date().toISOString();
    }
    return poc;
  });
}
export function addPod(pocId: string, input: PodInput) {
  const parsed = podInput.parse(input);
  return update(data => {
    const poc = find(data, pocId);
    if (poc.status !== "active") throw new PocError("POC encerrada não recebe novas PODs");
    if (data.pocs.some(p => p.pods.some(pod => pod.podId === parsed.podId || (parsed.agentId && pod.agentId === parsed.agentId)))) {
      throw new PocError("POD ou agente já vinculado a uma POC");
    }
    const pod = { ...parsed, id: randomUUID(), createdAt: new Date().toISOString() };
    poc.pods.push(pod); poc.updatedAt = new Date().toISOString(); return pod;
  });
}
export function bindPod(pocId: string, podId: string, agentId: string) {
  return update(data => {
    const poc = find(data, pocId), pod = poc.pods.find(p => p.id === podId);
    if (!pod) throw new PocError("POD não encontrada", 404);
    if (poc.status !== "active") throw new PocError("POC encerrada");
    if (pod.agentId) throw new PocError("POD já possui agente vinculado");
    if (data.pocs.some(p => p.pods.some(pod => pod.agentId === agentId))) throw new PocError("Agente já vinculado");
    pod.agentId = agentId; poc.updatedAt = new Date().toISOString(); return pod;
  });
}
export function agentPoc(id: string) { return readPocs().find(p => p.pods.some(pod => pod.agentId === id)); }
export function blockedByPoc(id: string) { return pocMode() && agentPoc(id)?.status === "closed"; }
