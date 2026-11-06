import { BASE_PATH } from "./base-path";

/** Absolute URLs avoid Next applying basePath twice to enhanced Server Actions. */
export function authRedirect(path: string): string {
  if (!BASE_PATH) return path;
  const origin = process.env.AUTH_URL;
  if (!origin) throw new Error("AUTH_URL must be configured for a prefixed deployment");
  return new URL(BASE_PATH + path, origin).href;
}
