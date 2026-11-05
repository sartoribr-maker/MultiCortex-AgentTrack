import type { NextRequest } from "next/server";
import { recordIngest } from "@/lib/devcore/ingest";
import { ingestReply, readIngest } from "@/lib/devcore/ingest-request";
import { metricsSchemaV1 } from "@/lib/devcore/metrics-schema";

export const runtime = "nodejs";

/** The VM agent pushes its metrics.json here every minute (outbound from the VM). */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/devcore/ingest/[id]">) {
  const { id } = await ctx.params;
  const result = await readIngest(request, id, metricsSchemaV1, "ingest");
  if (result instanceof Response) return result;
  recordIngest(result.vm.id, result.data);
  return ingestReply(204);
}
