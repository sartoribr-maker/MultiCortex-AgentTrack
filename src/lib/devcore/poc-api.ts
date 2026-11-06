import "server-only";
import { ZodError } from "zod";
import { authorizeDevcoreAdmin } from "./admin";
import { devcoreJson } from "./http";
import { PocError, pocMode } from "./poc-store";
import { listUniversalAgents } from "./agent-registry";
export async function pocApi(request: Request, action: () => unknown | Promise<unknown>) {
  if (!pocMode()) return devcoreJson({ error: "Não encontrado" }, 404);
  const denied = await authorizeDevcoreAdmin();
  if (denied) return denied;
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    const expected = new URL(process.env.AUTH_URL || request.url).origin;
    if (origin && origin !== expected) return devcoreJson({ error: "Origem não autorizada" }, 403);
  }
  try { return devcoreJson(await action()); }
  catch (error) {
    if (error instanceof PocError) return devcoreJson({ error: error.message }, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError) return devcoreJson({ error: "Dados inválidos. Confira os campos e o período." }, 400);
    return devcoreJson({ error: "Não foi possível acessar o cadastro. Tente novamente." }, 500);
  }
}
export function checkAgent(agentId: string, podId: string) {
  const agent = listUniversalAgents().find(a => a.id === agentId);
  if (!agent) throw new PocError("Agente não encontrado", 404);
  if (agent.podId !== podId) throw new PocError("O identificador da POD não corresponde ao agente");
  return agent;
}
