import { z } from "zod";
import { pocApi } from "@/lib/devcore/poc-api";
import { getDevcoreAccess } from "@/lib/devcore/session";
import { resetUniversalAgentCredential } from "@/lib/devcore/agent-registry";
export const runtime = "nodejs";
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return pocApi(request, async () => {
    const { reason } = z.object({ reason: z.string().trim().min(10).max(400).refine(value => !/Bearer\s|[a-f0-9]{64}/i.test(value), "Não informe credenciais no motivo") }).strict().parse(await request.json());
    const access = await getDevcoreAccess();
    if (!access.ok) throw new Error("Acesso inválido");
    return { agent: resetUniversalAgentCredential((await ctx.params).id, access.user.email, reason) };
  });
}
