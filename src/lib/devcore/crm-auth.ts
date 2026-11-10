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
export type CrmLogin = CrmPrincipal & { accessToken: string; expiresAt: number; refreshToken: string | null };
export type CrmCheck = { status: "ok"; principal: CrmPrincipal } | { status: "denied" } | { status: "unavailable" };
export type CrmRefresh = { accessToken: string; expiresAt: number; refreshToken: string };
/** CRM answered and refused (401/403/404/422): access must end. Anything else is treated as unavailability. */
class CrmDenied extends Error {}
const refreshSchema = z.string().regex(/^[a-f0-9]{64,256}$/);
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
  return (await exchange(path, token, body)).json;
}
/** Refresh token travels only between this server and the CRM, as the CRM's own HttpOnly cookie. */
async function exchange(path: string, token?: string, body?: object, refreshToken?: string): Promise<{ json: unknown; refreshToken: string | null }> {
  const response = await fetch(apiUrl(path), {
    method: body ? "POST" : "GET", redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(5000),
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(refreshToken ? { Cookie: "refresh_token=" + refreshSchema.parse(refreshToken) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if ([401, 403, 404, 422].includes(response.status)) throw new CrmDenied("Acesso CRM negado");
  if (!response.ok || !response.body) throw new Error("Acesso CRM indisponível");
  const issued = response.headers.getSetCookie?.().map(c => /^refresh_token=([a-f0-9]{64,256})(;|$)/.exec(c)?.[1]).find(Boolean) ?? null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 65536) throw new Error("Resposta CRM inválida"); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return { json: JSON.parse(Buffer.concat(chunks).toString("utf8")), refreshToken: issued };
}
function tokenExpiry(accessToken: string) {
  return z.object({ exp: z.number().int().positive() }).parse(JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"))).exp;
}

/** Revalidate the current CRM role and active account; never trust JWT role claims. */
export async function validateCrmAdmin(accessToken: string, expected: { id: string; email: string }): Promise<CrmPrincipal | null> {
  const result = await checkCrmAdmin(accessToken, expected);
  return result.status === "ok" ? result.principal : null;
}

/** Same rules as validateCrmAdmin, but tells a CRM refusal apart from CRM unavailability. */
export async function checkCrmAdmin(accessToken: string, expected: { id: string; email: string }): Promise<CrmCheck> {
  try {
    const principal = await strictAdmin(accessToken, expected);
    return principal ? { status: "ok", principal } : { status: "denied" };
  } catch (error) {
    return error instanceof CrmDenied || error instanceof z.ZodError ? { status: "denied" } : { status: "unavailable" };
  }
}

async function strictAdmin(accessToken: string, expected: { id: string; email: string }): Promise<CrmPrincipal | null> {
  tokenSchema.parse(accessToken);
  const me = principal.parse(await request("/auth/me", accessToken));
  if (me.id !== expected.id || me.email.toLowerCase() !== expected.email.toLowerCase() || !isAdmin(me.role.id)) return null;
  // /auth/me omits account status. /users/:id returns a safe projection and
  // excludes deleted accounts; querying only the authenticated user's own ID.
  const current = principal.extend({ status: z.literal("ACTIVE") }).parse(await request("/users/" + me.id, accessToken));
  if (current.id !== me.id || current.email.toLowerCase() !== me.email.toLowerCase() || current.role.id !== me.role.id || !isAdmin(current.role.id)) return null;
  return { id: current.id, email: current.email.toLowerCase(), name: current.name, roleId: current.role.id };
}

/** Password goes only to the CRM HTTPS login; never persisted or logged here. */
export async function loginCrmAdmin(email: string, password: string): Promise<CrmLogin | null> {
  try {
    email = email.trim().toLowerCase();
    if (!z.string().email().safeParse(email).success || password.length < 1 || password.length > 1024) return null;
    const login = await exchange("/auth/login", undefined, { email, password });
    const response = z.object({ accessToken: tokenSchema, user: principal, passwordChangeRequired: z.literal(false) }).parse(login.json);
    if (!isAdmin(response.user.role.id) || response.user.email.toLowerCase() !== email) return null;
    const user = await validateCrmAdmin(response.accessToken, { id: response.user.id, email });
    if (!user) return null;
    const expiry = tokenExpiry(response.accessToken);
    if (expiry <= Date.now() / 1000) return null;
    return { ...user, accessToken: response.accessToken, expiresAt: expiry, refreshToken: login.refreshToken };
  } catch { return null; }
}

/** Rotates the CRM refresh token (single use) for a new access token; null when the CRM refuses. */
export async function refreshCrmAccess(refreshToken: string, expected: { id: string; email: string }): Promise<CrmRefresh | null | "unavailable"> {
  try {
    const result = await exchange("/auth/refresh", undefined, {}, refreshToken);
    const body = z.object({ accessToken: tokenSchema, user: principal }).parse(result.json);
    if (body.user.id !== expected.id || body.user.email.toLowerCase() !== expected.email.toLowerCase() || !result.refreshToken) return null;
    const expiresAt = tokenExpiry(body.accessToken);
    return expiresAt > Date.now() / 1000 ? { accessToken: body.accessToken, expiresAt, refreshToken: result.refreshToken } : null;
  } catch (error) {
    return error instanceof CrmDenied || error instanceof z.ZodError ? null : "unavailable";
  }
}

/** Best effort: revokes the CRM refresh token on sign-out. */
export async function revokeCrmRefresh(refreshToken: string) {
  try { await exchange("/auth/logout", undefined, {}, refreshToken); } catch { /* already invalid or CRM offline */ }
}
