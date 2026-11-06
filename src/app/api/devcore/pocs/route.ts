import { pocApi } from "@/lib/devcore/poc-api";
import { pocOverview } from "@/lib/devcore/poc-overview";
import { createPoc } from "@/lib/devcore/poc-store";
import { pocInput } from "@/lib/devcore/poc-model";
export const runtime = "nodejs";
export async function GET(request: Request) { return pocApi(request, () => pocOverview()); }
export async function POST(request: Request) { return pocApi(request, async () => ({ poc: createPoc(pocInput.parse(await request.json())) })); }
