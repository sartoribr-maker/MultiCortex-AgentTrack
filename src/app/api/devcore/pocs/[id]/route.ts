import { pocApi } from "@/lib/devcore/poc-api";
import { editPoc } from "@/lib/devcore/poc-store";
import { pocInput } from "@/lib/devcore/poc-model";
export const runtime = "nodejs";
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return pocApi(request, async () => ({ poc: editPoc((await ctx.params).id, pocInput.parse(await request.json())) }));
}
