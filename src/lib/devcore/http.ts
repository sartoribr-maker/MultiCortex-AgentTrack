export const DEVCORE_API_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

export function devcoreJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: DEVCORE_API_HEADERS });
}
