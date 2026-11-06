import "server-only";

import { getDevcoreAccess } from "./session";
import { devcoreJson } from "./http";
import { crmAuthEnabled } from "./crm-auth";

/**
 * Administrative access for Universal Agent management.
 *
 * CRM mode uses the current active Admin role from the CRM API.
 * Local mode: DEVCORE_ADMIN_EMAILS is a comma-separated allowlist.
 * Administrators must also belong to DEVCORE_USERS.
 * Empty or missing configuration denies all administrative access.
 */
export async function authorizeDevcoreAdmin(request?: Request): Promise<Response | null> {
  if (request && !["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(process.env.AUTH_URL || request.url).origin) {
      return devcoreJson({ error: "Origem não autorizada." }, 403);
    }
  }
  const access = await getDevcoreAccess();

  if (!access.ok) {
    return devcoreJson(
      { error: "Acesso administrativo negado." },
      403,
    );
  }

  // CRM mode has already checked current Admin role and active status.
  if (crmAuthEnabled()) return null;

  const allowed = new Set(
    (process.env.DEVCORE_ADMIN_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );

  if (!allowed.has(access.user.email.trim().toLowerCase())) {
    return devcoreJson(
      { error: "Acesso administrativo negado." },
      403,
    );
  }

  return null;
}
