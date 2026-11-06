import { NextRequest } from "next/server";
import { enrollmentSchema } from "@/lib/devcore/agent-protocol";
import { enrollUniversalAgent } from "@/lib/devcore/agent-registry";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const expected = process.env.DEVCORE_BOOTSTRAP_TOKEN;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!expected || !token || token !== expected) {
    return Response.json({ error: "Não autorizado" }, { status: 401 });
  }

  const parsed = enrollmentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Identidade inválida" }, { status: 422 });
  }

  try {
    const agent = enrollUniversalAgent(parsed.data.identity);
    return Response.json({ id: agent.id, status: agent.status });
  } catch {
    return Response.json({ error: "Registro recusado" }, { status: 409 });
  }
}
