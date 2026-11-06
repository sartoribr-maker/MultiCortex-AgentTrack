import { pocApi } from "@/lib/devcore/poc-api";
import { closePoc } from "@/lib/devcore/poc-store";
import { changeUniversalAgentStatus } from "@/lib/devcore/agent-registry";
export const runtime = "nodejs";
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return pocApi(request, async () => {
    // Persist closure before revoking: authorization also checks the closed POC,
    // so even a registry write failure cannot keep linked agents authorized.
    const poc = closePoc((await ctx.params).id);
    for (const pod of poc.pods) if (pod.agentId) changeUniversalAgentStatus(pod.agentId, "revoked");
    return { poc };
  });
}
