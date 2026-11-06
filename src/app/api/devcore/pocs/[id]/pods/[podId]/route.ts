import { z } from "zod";
import { pocApi, checkAgent } from "@/lib/devcore/poc-api";
import { bindPod, readPocs, PocError } from "@/lib/devcore/poc-store";
export const runtime = "nodejs";
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string; podId: string }> }) {
  return pocApi(request, async () => {
    const { id, podId } = await ctx.params;
    const { agentId } = z.object({ agentId: z.string().uuid() }).strict().parse(await request.json());
    const pod = readPocs().find(p => p.id === id)?.pods.find(p => p.id === podId);
    if (!pod) throw new PocError("POD não encontrada", 404);
    checkAgent(agentId, pod.podId);
    return { pod: bindPod(id, podId, agentId) };
  });
}
