import type { NextRequest } from "next/server";
import { authorizeDevcoreApi, devcoreJson } from "@/lib/devcore/api";
import { getDevcoreLive } from "@/lib/devcore/live";
import { findDevcoreVm } from "@/lib/devcore/registry";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, ctx: RouteContext<"/api/devcore/vms/[id]/live">) {
  const denied = await authorizeDevcoreApi();
  if (denied) return denied;
  const { id } = await ctx.params;
  const vm = findDevcoreVm(id);
  if (!vm) return devcoreJson({ error: "VM não cadastrada." }, 404);
  return devcoreJson(getDevcoreLive(vm));
}
