import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loginCrmAdmin, validateCrmAdmin, crmAuthEnabled } from "../src/lib/devcore/crm-auth";

test("CRM authentication and live Admin authorization", async t => {
  const original = global.fetch;
  const env = { ...process.env };
  const id = randomUUID(), role = randomUUID();
  const user = { id, email: "admin@example.invalid", name: "Admin fixture", role: { id: role, name: "Administrador" }, mustChangePassword: false };
  const token = "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).toString("base64url") + ".fixture_signature";
  let mode = "ok"; const requests: { url: string; options?: RequestInit }[] = [];
  process.env.DEVCORE_AUTH_MODE = "crm";process.env.DEVCORE_CRM_ADMIN_ROLE_IDS = role;delete process.env.DEVCORE_CRM_API_URL;
  global.fetch = (async (input, options) => {
    const url = String(input); requests.push({ url, options });
    if (mode === "offline") throw new Error("fixture-secret-must-not-escape");
    if (mode === "redirect") return new Response(null, { status: 302 });
    if (mode === "bad-json") return new Response("{broken");
    if (mode === "oversized") return new Response("x".repeat(65537));
    if (mode === "unauthorized") return new Response("{}", { status: 401 });
    if (url.endsWith("/auth/login")) return Response.json({ accessToken: mode === "expired" ? "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url") + ".fixture_signature" : token, user: mode === "non-admin" ? { ...user, role: { id: randomUUID(), name: "SDR Admin" } } : user, passwordChangeRequired: mode === "change-password" });
    if (url.endsWith("/auth/me")) return Response.json(mode === "demoted" ? { ...user, role: { id: randomUUID(), name: "Vendedor" } } : mode === "identity" ? { ...user, id: randomUUID() } : user);
    if (url.endsWith("/users/" + id)) return Response.json({ ...user, status: mode === "inactive" ? "INACTIVE" : "ACTIVE", mustChangePassword: mode === "required-later" });
    throw new Error("Unexpected request");
  }) as typeof fetch;
  try {
    await t.test("authenticates CRM credentials and validates current role and active self", async () => {
      const result = await loginCrmAdmin(" ADMIN@example.invalid ", "fixture-password");
      assert.equal(result?.id, id);assert.equal(result?.roleId, role);
      assert.deepEqual(requests.map(r => new URL(r.url).pathname), ["/api/v1/auth/login", "/api/v1/auth/me", "/api/v1/users/" + id]);
      assert.deepEqual(JSON.parse(String(requests[0].options?.body)), { email: user.email, password: "fixture-password" });
      for (const r of requests) {assert.equal(r.options?.cache, "no-store");assert.equal(r.options?.redirect,"error");}
      assert.equal(JSON.stringify(result).includes("fixture-password"),false);
    });
    await t.test("rejects non-Admin credentials and mandatory password changes", async () => {
      for (mode of ["non-admin", "change-password", "expired"]) assert.equal(await loginCrmAdmin(user.email,"fixture-password"),null);
    });
    await t.test("rechecks demotion, inactive account, identity mismatch and required password change", async () => {
      for (mode of ["demoted", "inactive", "identity", "required-later"]) assert.equal(await validateCrmAdmin(token,{id,email:user.email}),null);
    });
    await t.test("fails closed on unavailable, expired/rejected and malformed CRM responses", async () => {
      for (mode of ["offline", "unauthorized", "redirect", "bad-json", "oversized"]) assert.equal(await loginCrmAdmin(user.email,"fixture-password"),null);
    });
    await t.test("missing roles, unsafe URL and malformed tokens never grant access", async () => {
      mode="ok";delete process.env.DEVCORE_CRM_ADMIN_ROLE_IDS;
      assert.equal(await validateCrmAdmin(token,{id,email:user.email}),null);
      process.env.DEVCORE_CRM_ADMIN_ROLE_IDS=role;process.env.DEVCORE_CRM_API_URL="http://crm.invalid/api/v1";
      const before=requests.length;assert.equal(await loginCrmAdmin(user.email,"fixture-password"),null);assert.equal(requests.length,before);
      assert.equal(await validateCrmAdmin("bad\r\nBearer injected",{id,email:user.email}),null);
    });
    await t.test("CRM mode is explicit and unknown modes are rejected", () => {
      assert.equal(crmAuthEnabled(),true);process.env.DEVCORE_AUTH_MODE="invalid";assert.throws(crmAuthEnabled);
      process.env.DEVCORE_AUTH_MODE="local";assert.equal(crmAuthEnabled(),false);
    });
  } finally {global.fetch=original;process.env=env;}
});
