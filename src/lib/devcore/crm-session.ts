import "server-only";
import { cookies } from "next/headers";
import { getToken } from "next-auth/jwt";
import { BASE_PATH } from "@/lib/base-path";
import { crmSessionAdmin, type CrmSessionResult } from "./crm-session-store";

/** The encrypted HttpOnly JWT carries only an opaque id of the server-side CRM session. */
export async function currentCrmAdmin(email: string): Promise<CrmSessionResult> {
  const secure = Boolean(BASE_PATH) || new URL(process.env.AUTH_URL || "http://localhost").protocol === "https:";
  const cookieName = BASE_PATH ? "__Secure-agenttrack.session-token" : (secure ? "__Secure-" : "") + "authjs.session-token";
  const jar = await cookies();
  const token = await getToken({ req: new Request("http://session.internal", { headers: { cookie: jar.toString() } }),
    secret: process.env.AUTH_SECRET!, cookieName, salt: cookieName });
  if (!token || typeof token.sub !== "string") return { status: "expired" };
  const result = await crmSessionAdmin(token.crmSessionId, email);
  return result.status === "ok" && result.principal.id !== token.sub ? { status: "forbidden" } : result;
}
