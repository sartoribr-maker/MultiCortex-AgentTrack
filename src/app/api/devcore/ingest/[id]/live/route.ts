import type { NextRequest } from "next/server";
import { recordLive } from "@/lib/devcore/ingest";
import { ingestReply, readIngest } from "@/lib/devcore/ingest-request";
import { liveSchemaV1 } from "@/lib/devcore/metrics-schema";

export const runtime = "nodejs";

/** The VM capture pushes a snapshot of this moment here every 10 s (same token as the metrics). */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/devcore/ingest/[id]/live">) {
  const { id } = await ctx.params;
  const result = await readIngest(request, id, liveSchemaV1, "live");
  if (result instanceof Response) return result;
  recordLive(result.vm.id, result.data);
  return ingestReply(204);
}
