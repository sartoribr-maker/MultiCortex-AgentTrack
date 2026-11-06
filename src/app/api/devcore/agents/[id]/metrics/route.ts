import { authorizeDevcoreAdmin } from "@/lib/devcore/admin";
import { listUniversalAgents } from "@/lib/devcore/agent-registry";
import { getUniversalTelemetry } from "@/lib/devcore/agent-telemetry-store";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const denied = await authorizeDevcoreAdmin();
  if (denied) return denied;

  const { id } = await ctx.params;

  const agent = listUniversalAgents().find(
    item => item.id === id
  );

  if (!agent) {
    return Response.json(
      { error: "Agente não encontrado" },
      { status: 404 }
    );
  }

  const telemetry = getUniversalTelemetry(id);

  return Response.json(
    {
      agent,
      telemetry,
      online: telemetry
        ? Date.now() - new Date(telemetry.receivedAt).getTime() < 90000
        : false,
    },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}
