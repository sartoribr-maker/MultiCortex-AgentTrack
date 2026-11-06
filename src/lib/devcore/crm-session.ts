import "server-only";
import { cookies } from "next/headers";
import { getToken } from "next-auth/jwt";
import { BASE_PATH } from "@/lib/base-path";
import { validateCrmAdmin } from "./crm-auth";

/** CRM bearer stays inside the encrypted HttpOnly JWT, never the public session. */
export async function currentCrmAdmin(email: string) {
  const secure = Boolean(BASE_PATH) || new URL(process.env.AUTH_URL || "http://localhost").protocol === "https:";
  const cookieName = BASE_PATH ? "__Secure-agenttrack.session-token" : (secure ? "__Secure-" : "") + "authjs.session-token";
  const jar = await cookies();
  const token = await getToken({ req: new Request("http://session.internal", { headers: { cookie: jar.toString() } }),
    secret: process.env.AUTH_SECRET!, cookieName, salt: cookieName });
  if (!token || typeof token.crmAccessToken !== "string" || typeof token.sub !== "string" || typeof token.crmExpiresAt !== "number" || token.crmExpiresAt <= Date.now() / 1000) return null;
  return validateCrmAdmin(token.crmAccessToken, { id: token.sub, email });
}
