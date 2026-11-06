import { PocError } from "@/lib/devcore/poc-store";
import { authorizeDevcoreAdmin } from "@/lib/devcore/admin";
import { changeUniversalAgentStatus } from "@/lib/devcore/agent-registry";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const denied = await authorizeDevcoreAdmin(_request);
  if (denied) return denied;

  const { id } = await ctx.params;
  let result;
  try { result = changeUniversalAgentStatus(id, "approved"); }
  catch (error) {
    return Response.json({ error: error instanceof PocError ? error.message : "Não foi possível aprovar" }, { status: error instanceof PocError ? error.status : 500 });
  }

  if (!result) {
    return Response.json({ error: "Agente não encontrado" }, { status: 404 });
  }

  return Response.json({ agent: result.agent });
}
