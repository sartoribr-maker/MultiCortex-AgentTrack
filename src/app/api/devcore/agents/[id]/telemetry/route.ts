import { NextRequest } from "next/server";
import { verifyUniversalAgentToken } from "@/lib/devcore/agent-registry";
import { universalTelemetrySchema } from "@/lib/devcore/agent-telemetry";
import { saveUniversalTelemetry } from "@/lib/devcore/agent-telemetry-store";

export const runtime = "nodejs";

const MAX_BYTES = 256 * 1024;

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);

  if (!match || !verifyUniversalAgentToken(id, match[1])) {
    return Response.json(
      { error: "Não autorizado" },
      { status: 401 }
    );
  }

  const contentLength = Number(request.headers.get("content-length") || 0);

  if (contentLength > MAX_BYTES) {
    return Response.json(
      { error: "Payload excede o limite" },
      { status: 413 }
    );
  }

  const raw = await request.text();

  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) {
    return Response.json(
      { error: "Payload excede o limite" },
      { status: 413 }
    );
  }

  let data: unknown;

  try {
    data = JSON.parse(raw);
  } catch {
    return Response.json(
      { error: "JSON inválido" },
      { status: 400 }
    );
  }

  const parsed = universalTelemetrySchema.safeParse(data);

  if (!parsed.success || parsed.data.agent_id !== id) {
    return Response.json(
      { error: "Telemetria inválida" },
      { status: 422 }
    );
  }

  saveUniversalTelemetry(id, parsed.data);
  return new Response(null, { status: 204 });
}
