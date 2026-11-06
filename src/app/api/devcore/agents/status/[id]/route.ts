import { NextRequest } from "next/server";
import { getUniversalAgentStatus } from "@/lib/devcore/agent-registry";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const key = request.headers.get("x-agent-enrollment-key") || "";
  const result = getUniversalAgentStatus(id, key);

  if (!result) {
    return Response.json({ error: "Não autorizado" }, { status: 401 });
  }

  return Response.json(result, { headers: { "Cache-Control": "private, no-store", "X-Devcore-Agent-Protocol": "2" } });
}
