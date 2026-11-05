import { authorizeDevcoreApi, devcoreJson } from "@/lib/devcore/api";
import { listDevcoreVms, toPublicVm } from "@/lib/devcore/registry";

export const runtime = "nodejs";

export async function GET() {
  const denied = await authorizeDevcoreApi();
  if (denied) return denied;
  return devcoreJson({ vms: listDevcoreVms().map(toPublicVm) });
}
