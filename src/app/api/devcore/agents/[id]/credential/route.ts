import { NextRequest } from "next/server";
import { issueUniversalAgentCredential } from "@/lib/devcore/agent-registry";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const enrollmentKey = request.headers.get("x-agent-enrollment-key") || "";

  if (!/^[a-f0-9]{64}$/.test(enrollmentKey)) {
    return Response.json({ error: "Não autorizado" }, { status: 401 });
  }

  const result = issueUniversalAgentCredential(id, enrollmentKey);

  if (!result) {
    return Response.json({ error: "Não autorizado" }, { status: 401 });
  }

  return Response.json(
    { token: result.token, status: "approved" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
