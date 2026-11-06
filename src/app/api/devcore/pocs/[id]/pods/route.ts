import { pocApi, checkAgent } from "@/lib/devcore/poc-api";
import { addPod } from "@/lib/devcore/poc-store";
import { podInput } from "@/lib/devcore/poc-model";
export const runtime = "nodejs";
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return pocApi(request, async () => {
    const input = podInput.parse(await request.json());
    if (input.agentId) checkAgent(input.agentId, input.podId);
    return { pod: addPod((await ctx.params).id, input) };
  });
}
