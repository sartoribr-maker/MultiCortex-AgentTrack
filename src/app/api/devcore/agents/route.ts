import { authorizeDevcoreAdmin } from "@/lib/devcore/admin";
import { listUniversalAgents } from "@/lib/devcore/agent-registry";

export const runtime = "nodejs";

export async function GET() {
  const denied = await authorizeDevcoreAdmin();
  if (denied) return denied;
  return Response.json({ agents: listUniversalAgents() });
}
