import "server-only";
import { z } from "zod";

export function crmAuthEnabled() {
  const mode = process.env.DEVCORE_AUTH_MODE || "local";
  if (mode !== "local" && mode !== "crm") throw new Error("Modo de autenticação inválido");
  return mode === "crm";
}

const principal = z.object({
  id: z.string().uuid(), email: z.string().email(), name: z.string().min(1).max(200),
  role: z.object({ id: z.string().uuid(), name: z.string() }),
  mustChangePassword: z.literal(false),
});
export type CrmPrincipal = { id: string; email: string; name: string; roleId: string };
export type CrmLogin = CrmPrincipal & { accessToken: string; expiresAt: number };
const tokenSchema = z.string().min(20).max(12000).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

function apiUrl(path: string) {
  const url = new URL(process.env.DEVCORE_CRM_API_URL || "https://crm.multicortex.com.br/api/v1");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("API CRM inválida");
  return url.toString().replace(/\/$/, "") + path;
}
function isAdmin(roleId: string) {
  return (process.env.DEVCORE_CRM_ADMIN_ROLE_IDS || "").split(",").map(v => v.trim()).filter(Boolean).includes(roleId);
}
async function request(path: string, token?: string, body?: object): Promise<unknown> {
  const response = await fetch(apiUrl(path), {
    method: body ? "POST" : "GET", redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(5000),
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: "Bearer " + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok || !response.body) throw new Error("Acesso CRM indisponível");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 65536) throw new Error("Resposta CRM inválida"); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Revalidate the current CRM role and active account; never trust JWT role claims. */
export async function validateCrmAdmin(accessToken: string, expected: { id: string; email: string }): Promise<CrmPrincipal | null> {
  try {
    tokenSchema.parse(accessToken);
    const me = principal.parse(await request("/auth/me", accessToken));
    if (me.id !== expected.id || me.email.toLowerCase() !== expected.email.toLowerCase() || !isAdmin(me.role.id)) return null;
    // /auth/me omits account status. /users/:id returns a safe projection and
    // excludes deleted accounts; querying only the authenticated user's own ID.
    const current = principal.extend({ status: z.literal("ACTIVE") }).parse(await request("/users/" + me.id, accessToken));
    if (current.id !== me.id || current.email.toLowerCase() !== me.email.toLowerCase() || current.role.id !== me.role.id || !isAdmin(current.role.id)) return null;
    return { id: current.id, email: current.email.toLowerCase(), name: current.name, roleId: current.role.id };
  } catch { return null; }
}

/** Password goes only to the CRM HTTPS login; never persisted or logged here. */
export async function loginCrmAdmin(email: string, password: string): Promise<CrmLogin | null> {
  try {
    email = email.trim().toLowerCase();
    if (!z.string().email().safeParse(email).success || password.length < 1 || password.length > 1024) return null;
    const response = z.object({ accessToken: tokenSchema, user: principal, passwordChangeRequired: z.literal(false) }).parse(await request("/auth/login", undefined, { email, password }));
    if (!isAdmin(response.user.role.id) || response.user.email.toLowerCase() !== email) return null;
    const user = await validateCrmAdmin(response.accessToken, { id: response.user.id, email });
    if (!user) return null;
    const expiry = z.object({ exp: z.number().int().positive() }).parse(JSON.parse(Buffer.from(response.accessToken.split(".")[1], "base64url").toString("utf8"))).exp;
    if (expiry <= Date.now() / 1000) return null;
    return { ...user, accessToken: response.accessToken, expiresAt: expiry };
  } catch { return null; }
}
