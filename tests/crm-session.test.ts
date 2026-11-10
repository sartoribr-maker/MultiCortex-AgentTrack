import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loginCrmAdmin, refreshCrmAccess, checkCrmAdmin } from "../src/lib/devcore/crm-auth";
import { createCrmSession, crmSessionAdmin, endCrmSession, resetCrmSessions } from "../src/lib/devcore/crm-session-store";

const jwt = (exp: number) => "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ exp, n: randomUUID() })).toString("base64url") + ".fixture_signature";
const hex = () => (randomUUID() + randomUUID()).replace(/-/g, "") + "00000000000000000000000000000000";

test("CRM sessions renew server-side and end only when the CRM says so", async t => {
  const original = global.fetch;
  const env = { ...process.env };
  const id = randomUUID(), role = randomUUID();
  const user = { id, email: "admin@example.invalid", name: "Admin fixture", role: { id: role, name: "Administrador" }, mustChangePassword: false };
  process.env.DEVCORE_AUTH_MODE = "crm"; process.env.DEVCORE_CRM_ADMIN_ROLE_IDS = role; delete process.env.DEVCORE_CRM_API_URL;
  let mode = "ok"; let current = hex(); let accessExp = Math.floor(Date.now() / 1000) + 900;
  const calls: string[] = []; const sentCookies: (string | null)[] = [];
  const withCookie = (body: unknown, token: string) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json",
    "set-cookie": `refresh_token=${token}; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax` } });
  global.fetch = (async (input, options) => {
    const path = new URL(String(input)).pathname.replace("/api/v1", ""); calls.push(path);
    if (mode === "offline") throw new TypeError("fetch failed");
    if (mode === "500") return new Response("{}", { status: 503 });
    if (path === "/auth/login") return withCookie({ accessToken: jwt(accessExp), user, passwordChangeRequired: false }, current);
    if (path === "/auth/refresh") {
      const cookie = new Headers(options?.headers).get("cookie"); sentCookies.push(cookie);
      if (mode === "refresh-denied" || cookie !== "refresh_token=" + current) return new Response("{}", { status: 401 });
      current = hex(); accessExp = Math.floor(Date.now() / 1000) + 900;
      return withCookie({ accessToken: jwt(accessExp), user }, current);
    }
    if (path === "/auth/logout") return Response.json({ ok: true });
    if (mode === "demoted") return Response.json({ ...user, role: { id: randomUUID(), name: "Vendedor" } });
    if (path === "/auth/me") return Response.json(user);
    if (path === "/users/" + id) return Response.json({ ...user, status: "ACTIVE" });
    throw new Error("unexpected " + path);
  }) as typeof fetch;
  const login = async () => { mode = "ok"; resetCrmSessions(); const l = await loginCrmAdmin(user.email, "pw"); assert.ok(l); return l!; };
  try {
    await t.test("login keeps the CRM refresh token server-side only", async () => {
      const l = await login();
      assert.equal(l.refreshToken, current);
      const sid = createCrmSession(l);
      assert.match(sid, /^[0-9a-f-]{36}$/);
      assert.equal(sid.includes(current), false);
      assert.equal((await crmSessionAdmin(sid, user.email)).status, "ok");
    });
    await t.test("validation is reused for a minute instead of hitting the CRM every poll", async () => {
      const sid = createCrmSession(await login()); calls.length = 0;
      for (let i = 0; i < 5; i++) assert.equal((await crmSessionAdmin(sid, user.email)).status, "ok");
      assert.deepEqual(calls, []);
      assert.equal((await crmSessionAdmin(sid, user.email, Date.now() + 61_000)).status, "ok");
      assert.deepEqual(calls, ["/auth/me", "/users/" + id]);
    });
    await t.test("expiring access token is renewed once, even with concurrent requests", async () => {
      const l = await login(); const first = current;
      const sid = createCrmSession(l); calls.length = 0;
      const later = (l.expiresAt - 30) * 1000;
      const results = await Promise.all([1, 2, 3].map(() => crmSessionAdmin(sid, user.email, later)));
      assert.deepEqual(results.map(r => r.status), ["ok", "ok", "ok"]);
      assert.equal(calls.filter(c => c === "/auth/refresh").length, 1);
      assert.equal(sentCookies.at(-1), "refresh_token=" + first);
      assert.notEqual(current, first);
      // hours later the session keeps renewing with the rotated token
      for (let h = 1; h <= 3; h++) {
        assert.equal((await crmSessionAdmin(sid, user.email, (accessExp - 30) * 1000)).status, "ok");
      }
      assert.equal(calls.filter(c => c === "/auth/refresh").length, 4);
    });
    await t.test("refresh refused by the CRM ends the session (sign in again)", async () => {
      const l = await login(); const sid = createCrmSession(l); mode = "refresh-denied";
      assert.equal((await crmSessionAdmin(sid, user.email, (l.expiresAt - 30) * 1000)).status, "expired");
      mode = "ok"; assert.equal((await crmSessionAdmin(sid, user.email)).status, "expired");
    });
    await t.test("short CRM outage keeps a recently confirmed admin; long outage does not", async () => {
      const sid = createCrmSession(await login());
      mode = "offline";
      assert.equal((await crmSessionAdmin(sid, user.email, Date.now() + 2 * 60_000)).status, "ok");
      mode = "500";
      assert.equal((await crmSessionAdmin(sid, user.email, Date.now() + 3 * 60_000)).status, "ok");
      assert.equal((await crmSessionAdmin(sid, user.email, Date.now() + 6 * 60_000)).status, "expired");
    });
    await t.test("demotion is enforced within a minute", async () => {
      const sid = createCrmSession(await login()); mode = "demoted";
      assert.equal((await crmSessionAdmin(sid, user.email, Date.now() + 61_000)).status, "forbidden");
      mode = "ok"; assert.equal((await crmSessionAdmin(sid, user.email)).status, "expired");
    });
    await t.test("unknown id, other e-mail, 12h limit and sign-out end access", async () => {
      assert.equal((await crmSessionAdmin(randomUUID(), user.email)).status, "expired");
      assert.equal((await crmSessionAdmin(undefined, user.email)).status, "expired");
      let sid = createCrmSession(await login());
      assert.equal((await crmSessionAdmin(sid, "other@example.invalid")).status, "expired");
      sid = createCrmSession(await login());
      assert.equal((await crmSessionAdmin(sid, user.email, Date.now() + 12 * 3600_000 + 1000)).status, "expired");
      sid = createCrmSession(await login()); calls.length = 0;
      await endCrmSession(sid);
      assert.deepEqual(calls, ["/auth/logout"]);
      assert.equal((await crmSessionAdmin(sid, user.email)).status, "expired");
    });
    await t.test("CRM client distinguishes refusal from unavailability", async () => {
      const token = jwt(Math.floor(Date.now() / 1000) + 900);
      mode = "ok"; assert.equal((await checkCrmAdmin(token, { id, email: user.email })).status, "ok");
      mode = "demoted"; assert.equal((await checkCrmAdmin(token, { id, email: user.email })).status, "denied");
      mode = "offline"; assert.equal((await checkCrmAdmin(token, { id, email: user.email })).status, "unavailable");
      mode = "500"; assert.equal(await refreshCrmAccess(hex(), { id, email: user.email }), "unavailable");
      mode = "refresh-denied"; assert.equal(await refreshCrmAccess(hex(), { id, email: user.email }), null);
      mode = "ok"; assert.equal(await refreshCrmAccess("bad\r\ncookie", { id, email: user.email }), null);
    });
  } finally { global.fetch = original; process.env = env; resetCrmSessions(); }
});
