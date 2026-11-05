import "server-only";
import { devcoreJson } from "./http";
import { getDevcoreAccess } from "./session";

export { DEVCORE_API_HEADERS, devcoreJson } from "./http";

/** Returns an error response, or null when the caller may proceed. */
export async function authorizeDevcoreApi(): Promise<Response | null> {
  const access = await getDevcoreAccess();
  if (!access.ok) {
    return access.reason === "anonymous"
      ? devcoreJson({ error: "Entre na sua conta." }, 401)
      : devcoreJson({ error: "Acesso negado." }, 403);
  }
  return null;
}
