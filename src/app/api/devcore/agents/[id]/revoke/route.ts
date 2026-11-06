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
  const result = changeUniversalAgentStatus(id, "revoked");

  if (!result) {
    return Response.json({ error: "Agente não encontrado" }, { status: 404 });
  }

  return Response.json({ agent: result.agent });
}
