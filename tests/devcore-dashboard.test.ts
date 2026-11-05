import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { liveSchemaV1, metricsSchemaV1, type DevcoreMetrics } from "../src/lib/devcore/metrics-schema";
import { clearDevcoreMetricsCache, getDevcoreMetrics, statusFor } from "../src/lib/devcore/metrics";
import { findDevcoreVm, listDevcoreVms, parseRegistry, resetDevcoreRegistryCache, toPublicVm, type DevcoreVm } from "../src/lib/devcore/registry";
import {
  brasiliaDate, brasiliaMinutes, formatActiveTime, formatAgo, formatDuration, formatGigabytes, formatPercent,
  formatTimeBR, isRecentlyActive, pocDailySeries, pocProgress,
} from "../src/lib/devcore/view";
import nextConfig, { NOINDEX } from "../next.config";
import robots from "../src/app/robots";
import { decodeHash, encodeHash, findDevcoreUser, parseDevcoreUsers, verifyDevcoreUser } from "../src/lib/devcore/users";
import bcrypt from "bcryptjs";
import { existsSync } from "node:fs";
import { POST as ingest } from "../src/app/api/devcore/ingest/[id]/route";
import { POST as ingestLive } from "../src/app/api/devcore/ingest/[id]/live/route";
import { clearIngestStore, recordIngest } from "../src/lib/devcore/ingest";
import { getDevcoreLive } from "../src/lib/devcore/live";
import { assessMetrics } from "../src/lib/devcore/assessment";

// Produced by infra/devcore-vm-agent from its own fixtures: the agent/site contract.
const SAMPLE = JSON.parse(readFileSync(path.join(__dirname, "fixtures/devcore-metrics.sample.json"), "utf8"));
const GENERATED = new Date(SAMPLE.generated_at);
const TOKEN = "test-token-0123456789abcdef0123456789abcdef";

const vm: DevcoreVm = {
  id: "devcore-demo-01",
  company: "Theós",
  pocName: "POC Theós",
  vmName: "devcore-demo-01",
  pocStart: "2026-10-13",
  pocEnd: "2026-11-11",
  slots: 8,
  source: "pull",
  metricsUrl: "https://devcore01.multicortex.com.br/poc/metrics.json",
  tokenEnv: "DEVCORE_METRICS_TOKEN_TEST",
};

function okResponse(body: unknown = SAMPLE) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function setup() {
  clearDevcoreMetricsCache();
  process.env.DEVCORE_METRICS_TOKEN_TEST = TOKEN;
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  return { warnings, restore: () => { console.warn = original; } };
}

// ---------------------------------------------------------------- registry

test("bundled registry is valid and exposes no URL or token variable to the browser", () => {
  resetDevcoreRegistryCache();
  delete process.env.DEVCORE_VMS_FILE;
  const vms = listDevcoreVms();
  assert.ok(vms.length >= 1);
  assert.equal(findDevcoreVm("devcore-demo-01")?.pocEnd, "2026-11-11");
  assert.equal(findDevcoreVm("nope"), undefined);
  const exposed = JSON.stringify(vms.map(toPublicVm));
  assert.doesNotMatch(exposed, /metricsUrl|tokenEnv|https?:\/\//);
});

test("registry rejects duplicates, inverted periods and bad ids", () => {
  assert.throws(() => parseRegistry({ vms: [vm, vm] }), /duplicada/);
  assert.throws(() => parseRegistry({ vms: [{ ...vm, pocEnd: "2026-10-01" }] }), /Período/);
  assert.throws(() => parseRegistry({ vms: [{ ...vm, id: "../etc" }] }));
  assert.throws(() => parseRegistry({ vms: [{ ...vm, tokenEnv: "lower-case" }] }));
  assert.throws(() => parseRegistry({ vms: [{ ...vm, metricsUrl: undefined }] }), /pull exige/);
  assert.equal(parseRegistry({ vms: [{ ...vm, source: "push", metricsUrl: undefined }] })[0].source, "push");
});

test("DEVCORE_VMS_FILE overrides the bundled registry", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devcore-vms-"));
  const file = path.join(dir, "vms.json");
  writeFileSync(file, JSON.stringify({ vms: [{ ...vm, id: "acme-01", company: "Acme" }] }));
  process.env.DEVCORE_VMS_FILE = file;
  try {
    assert.deepEqual(listDevcoreVms().map((v) => v.id), ["acme-01"]);
  } finally {
    delete process.env.DEVCORE_VMS_FILE;
    resetDevcoreRegistryCache();
  }
});

// ----------------------------------------------------------------- metrics

test("agent output satisfies the site schema", () => {
  const parsed = metricsSchemaV1.parse(SAMPLE);
  assert.equal(parsed.today.requests, 8);
  assert.equal(parsed.hourly_24h.length, 24);
});

test("agent 1.3 sends today's usage per developer IP, and older agents still parse without it", () => {
  const parsed = metricsSchemaV1.parse(SAMPLE);
  const list = parsed.today.developer_list ?? [];
  assert.equal(list.length, parsed.today.developers);
  assert.deepEqual(
    [list[0].ip, list[0].requests, list[0].active_s, formatTimeBR(list[0].first_seen), formatTimeBR(list[0].last_seen)],
    ["203.0.113.10", 4, 224, "08:57", "09:01"],
  );
  assert.equal(isRecentlyActive(list[0].last_seen, parsed.generated_at), true);
  assert.equal(isRecentlyActive("2026-10-13T08:50:00-03:00", parsed.generated_at), false);
  const older = { ...SAMPLE.today };
  delete older.developer_list;
  assert.equal(metricsSchemaV1.parse({ ...SAMPLE, today: older }).today.developer_list, undefined);
  assert.equal(metricsSchemaV1.safeParse({ ...SAMPLE, today: { ...SAMPLE.today, developer_list: [{ ip: "x" }] } }).success, false);
});

test("active time reads in minutes and hours", () => {
  assert.equal(formatActiveTime(12), "< 1 min");
  assert.equal(formatActiveTime(224), "4 min");
  assert.equal(formatActiveTime(7500), "2 h 05 min");
});

test("fetches with bearer token, no redirects, and returns online metrics without secrets", async () => {
  const { warnings, restore } = setup();
  let seen: RequestInit | undefined;
  try {
    const result = await getDevcoreMetrics(vm, {
      fetchImpl: (async (_url: URL, init?: RequestInit) => { seen = init; return okResponse(); }) as typeof fetch,
      now: () => new Date(GENERATED.getTime() + 30_000),
    });
    assert.equal(result.status, "online");
    assert.equal(result.metrics?.today.developers, 4);
    assert.equal((seen?.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
    assert.equal(seen?.redirect, "error");
    assert.ok(seen?.signal);
    const body = JSON.stringify(result);
    assert.ok(!body.includes(TOKEN));
    assert.ok(!body.includes("devcore01.multicortex.com.br"));
    assert.deepEqual(warnings, []);
  } finally { restore(); }
});

test("caches results for 60 s and coalesces concurrent requests", async () => {
  const { restore } = setup();
  let calls = 0;
  let clock = GENERATED.getTime();
  const fetchImpl = (async () => { calls++; return okResponse(); }) as typeof fetch;
  const now = () => new Date(clock);
  try {
    await Promise.all([getDevcoreMetrics(vm, { fetchImpl, now }), getDevcoreMetrics(vm, { fetchImpl, now })]);
    clock += 59_000;
    await getDevcoreMetrics(vm, { fetchImpl, now });
    assert.equal(calls, 1);
    clock += 2_000;
    await getDevcoreMetrics(vm, { fetchImpl, now });
    assert.equal(calls, 2);
  } finally { restore(); }
});

test("failures become 'unavailable' with a category, are cached briefly and never log the token", async () => {
  const cases: [string, typeof fetch, string][] = [
    ["http", (async () => new Response("denied", { status: 401 })) as typeof fetch, "http"],
    ["invalid json", (async () => new Response("<html>", { status: 200 })) as typeof fetch, "invalid"],
    ["schema", (async () => okResponse({ ...SAMPLE, schema: 2 })) as typeof fetch, "invalid"],
    ["timeout", (async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as typeof fetch, "timeout"],
    ["network", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch, "network"],
  ];
  for (const [name, fetchImpl, failure] of cases) {
    const { warnings, restore } = setup();
    try {
      const result = await getDevcoreMetrics(vm, { fetchImpl, now: () => GENERATED });
      assert.equal(result.status, "unavailable", name);
      assert.equal(result.failure, failure, name);
      assert.equal(result.metrics, null);
      assert.equal(warnings.length, 1);
      assert.ok(!warnings[0].includes(TOKEN), name);
    } finally { restore(); }
  }
  // Failure cache: 15 s.
  const { restore } = setup();
  let calls = 0;
  let clock = GENERATED.getTime();
  const failing = (async () => { calls++; throw new TypeError("down"); }) as typeof fetch;
  try {
    await getDevcoreMetrics(vm, { fetchImpl: failing, now: () => new Date(clock) });
    clock += 10_000;
    await getDevcoreMetrics(vm, { fetchImpl: failing, now: () => new Date(clock) });
    assert.equal(calls, 1);
    clock += 6_000;
    await getDevcoreMetrics(vm, { fetchImpl: failing, now: () => new Date(clock) });
    assert.equal(calls, 2);
  } finally { restore(); }
});

test("missing token or non-https URL is reported as not configured without fetching", async () => {
  const { restore } = setup();
  let calls = 0;
  const fetchImpl = (async () => { calls++; return okResponse(); }) as typeof fetch;
  try {
    delete process.env.DEVCORE_METRICS_TOKEN_TEST;
    assert.equal((await getDevcoreMetrics(vm, { fetchImpl })).failure, "not_configured");
    clearDevcoreMetricsCache();
    process.env.DEVCORE_METRICS_TOKEN_TEST = TOKEN;
    const insecure = { ...vm, metricsUrl: "http://devcore01.multicortex.com.br/poc/metrics.json" };
    assert.equal((await getDevcoreMetrics(insecure, { fetchImpl })).failure, "not_configured");
    assert.equal(calls, 0);
  } finally { restore(); }
});

test("data older than 5 minutes is stale", () => {
  const metrics = metricsSchemaV1.parse(SAMPLE);
  assert.equal(statusFor(metrics, new Date(GENERATED.getTime() + 4 * 60_000)), "online");
  assert.equal(statusFor(metrics, new Date(GENERATED.getTime() + 6 * 60_000)), "stale");
});

// ------------------------------------------------------- noindex / routing

test("every route answers with X-Robots-Tag noindex and robots.txt disallows everything", async () => {
  assert.equal(NOINDEX, "noindex, nofollow, noarchive");
  const rules = await nextConfig.headers!();
  const all = rules.find((rule) => rule.source === "/:path*");
  assert.ok(all, "a rule must cover every path");
  assert.deepEqual(all.headers, [{ key: "X-Robots-Tag", value: NOINDEX }]);
  assert.deepEqual(robots(), { rules: { userAgent: "*", disallow: "/" } });
});

test("the dashboard is the whole app: pages at the root, no host rewrite", () => {
  const root = path.join(__dirname, "..");
  assert.equal(nextConfig.rewrites, undefined);
  assert.equal(existsSync(path.join(root, "src/proxy.ts")), false, "no proxy: nothing to rewrite");
  assert.equal(existsSync(path.join(root, "src/app/page.tsx")), true);
  assert.equal(existsSync(path.join(root, "src/app/entrar/page.tsx")), true);
  assert.equal(existsSync(path.join(root, "src/app/devcore")), false);
  // The agent contract paths are unchanged.
  assert.equal(existsSync(path.join(root, "src/app/api/devcore/ingest/[id]/route.ts")), true);
  assert.equal(existsSync(path.join(root, "src/app/api/devcore/ingest/[id]/live/route.ts")), true);
});

// ------------------------------------------------------------------ login

test("DEVCORE_USERS: base64 or raw bcrypt hashes, optional name, case-insensitive e-mail", async () => {
  const hash = await bcrypt.hash("senha-de-teste-123", 4);
  assert.equal(decodeHash(encodeHash(hash)), hash);
  const users = parseDevcoreUsers(` Ana@MultiCortex.com.br:${encodeHash(hash)}:Ana Lima ,\nbeto@multicortex.com.br:${hash}`);
  assert.deepEqual(users.map((u) => [u.email, u.name]), [["ana@multicortex.com.br", "Ana Lima"], ["beto@multicortex.com.br", null]]);
  assert.deepEqual(parseDevcoreUsers(undefined), []);
  assert.deepEqual(parseDevcoreUsers(""), []);
});

test("DEVCORE_USERS rejects bad entries without echoing them", () => {
  const secret = encodeHash("$2b$04$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234");
  for (const raw of ["sem-arroba:" + secret, "a@b.co:naoehash", "a@b.co", `a@b.co:${secret},A@b.co:${secret}`]) {
    assert.throws(() => parseDevcoreUsers(raw), (error: Error) => /DEVCORE_USERS/.test(error.message) && !error.message.includes(secret.slice(0, 12)));
  }
});

test("login accepts only listed users with the right password", async () => {
  const original = process.env.DEVCORE_USERS;
  process.env.DEVCORE_USERS = `ana@multicortex.com.br:${encodeHash(await bcrypt.hash("senha-certa-123", 4))}:Ana`;
  try {
    assert.equal((await verifyDevcoreUser("ANA@multicortex.com.br", "senha-certa-123"))?.name, "Ana");
    assert.equal(await verifyDevcoreUser("ana@multicortex.com.br", "senha-errada"), null);
    assert.equal(await verifyDevcoreUser("outra@multicortex.com.br", "senha-certa-123"), null);
    // Removing a user from DEVCORE_USERS revokes access on the next request.
    process.env.DEVCORE_USERS = "";
    assert.equal(findDevcoreUser("ana@multicortex.com.br"), undefined);
  } finally {
    if (original === undefined) delete process.env.DEVCORE_USERS;
    else process.env.DEVCORE_USERS = original;
  }
});

// -------------------------------------------------------------------- view

test("POC progress counts days in Brasilia", () => {
  assert.equal(brasiliaDate(new Date("2026-10-14T02:59:00Z")), "2026-10-13");
  assert.equal(brasiliaDate(new Date("2026-10-14T03:00:00Z")), "2026-10-14");
  assert.deepEqual(pocProgress("2026-10-13", "2026-11-11", "2026-10-13"), { phase: "active", totalDays: 30, day: 1, remaining: 29, startsIn: 0 });
  assert.equal(pocProgress("2026-10-13", "2026-11-11", "2026-11-11").remaining, 0);
  assert.equal(pocProgress("2026-10-13", "2026-11-11", "2026-10-10").startsIn, 3);
  assert.equal(pocProgress("2026-10-13", "2026-11-11", "2026-11-12").phase, "ended");
});

test("POC daily series keeps unknown days as null and stops at today", () => {
  const series = pocDailySeries(SAMPLE.daily, "2026-10-11", "2026-11-11", "2026-10-13");
  assert.deepEqual(series.map((d) => d.date), ["2026-10-11", "2026-10-12", "2026-10-13"]);
  assert.equal(series[0].entry, null);
  assert.equal(series[2].entry?.requests, 8);
});

test("formatters", () => {
  assert.equal(formatDuration(0.412), "412 ms");
  assert.equal(formatDuration(5.105), "5,1 s");
  assert.equal(formatDuration(65.2), "1 min 05 s");
  assert.equal(formatDuration(null), "—");
  assert.equal(formatPercent(33.333), "33,3%");
  assert.equal(formatGigabytes(46068), "44,99 GB");
  assert.equal(formatTimeBR("2026-10-13T12:02:00Z"), "09:02");
  assert.equal(brasiliaMinutes("2026-10-13T09:00:00-03:00"), 540);
  assert.equal(formatAgo(42), "42 s");
  assert.equal(formatAgo(185), "3 min");
});

// -------------------------------------------------------------------- push

const pushVm: DevcoreVm = { ...vm, source: "push", metricsUrl: undefined };

function ingestRequest(body: string, token?: string, id = "devcore-demo-01") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const request = new NextRequest(`https://site.multicortex.com.br/api/devcore/ingest/${id}`, { method: "POST", headers, body });
  return ingest(request, { params: Promise.resolve({ id }) } as Parameters<typeof ingest>[1]);
}

test("ingest accepts only the VM token and a valid schema, and the dashboard serves it", async () => {
  resetDevcoreRegistryCache();
  delete process.env.DEVCORE_VMS_FILE;
  clearIngestStore();
  const { restore } = setup();
  process.env.DEVCORE_METRICS_TOKEN_DEVCORE_DEMO_01 = TOKEN;
  try {
    const body = JSON.stringify(SAMPLE);
    assert.equal((await ingestRequest(body)).status, 401);
    assert.equal((await ingestRequest(body, "wrong-token")).status, 401);
    assert.equal((await ingestRequest(body, TOKEN, "nao-existe")).status, 401);
    assert.equal((await ingestRequest("{oops", TOKEN)).status, 400);
    assert.equal((await ingestRequest(JSON.stringify({ ...SAMPLE, schema: 9 }), TOKEN)).status, 422);
    assert.equal((await ingestRequest("x".repeat(2_000_001), TOKEN)).status, 413);

    const demo = findDevcoreVm("devcore-demo-01")!;
    assert.equal(demo.source, "push");
    const before = await getDevcoreMetrics(demo, { now: () => GENERATED });
    assert.equal(before.status, "unavailable");
    assert.equal(before.failure, "waiting");

    const accepted = await ingestRequest(body, TOKEN);
    assert.equal(accepted.status, 204);
    assert.equal(accepted.headers.get("cache-control"), "private, no-store");
    const after = await getDevcoreMetrics(demo, { now: () => new Date(GENERATED.getTime() + 30_000) });
    assert.equal(after.status, "online");
    assert.equal(after.metrics?.today.inflight?.peak.devcore, 2);
  } finally {
    restore();
    delete process.env.DEVCORE_METRICS_TOKEN_DEVCORE_DEMO_01;
    clearIngestStore();
  }
});

test("push mode: data turns stale after 5 min and unavailable when the agent goes silent", async () => {
  clearIngestStore();
  const metrics = metricsSchemaV1.parse(SAMPLE);
  recordIngest(pushVm.id, metrics, GENERATED);
  const at = (minutes: number) => ({ now: () => new Date(GENERATED.getTime() + minutes * 60_000) });
  assert.equal((await getDevcoreMetrics(pushVm, at(1))).status, "online");
  assert.equal((await getDevcoreMetrics(pushVm, at(6))).status, "stale");
  const silent = await getDevcoreMetrics(pushVm, at(16));
  assert.equal(silent.status, "unavailable");
  assert.ok(silent.metrics, "last data is kept for display");
  clearIngestStore();
});

// -------------------------------------------------------------------- live

// Produced by infra/devcore-vm-agent/devcore_http_capture.py (build_live): the capture/site contract.
const LIVE = JSON.parse(readFileSync(path.join(__dirname, "fixtures/devcore-live.sample.json"), "utf8"));

function liveRequest(body: string, token?: string, id = "devcore-demo-01") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const request = new NextRequest(`https://site.multicortex.com.br/api/devcore/ingest/${id}/live`, { method: "POST", headers, body });
  return ingestLive(request, { params: Promise.resolve({ id }) } as Parameters<typeof ingestLive>[1]);
}

test("capture live snapshot satisfies the site schema and carries no IPs", () => {
  const live = liveSchemaV1.parse(LIVE);
  assert.deepEqual(live.developers, { online: 6, active: 4 });
  assert.doesNotMatch(JSON.stringify(LIVE), /\d+\.\d+\.\d+\.\d+/);
  assert.equal(liveSchemaV1.safeParse(SAMPLE).success, false, "a metrics.json is not a live snapshot");
});

test("live ingest uses the VM token, and the snapshot is fresh for 30 s", async () => {
  resetDevcoreRegistryCache();
  delete process.env.DEVCORE_VMS_FILE;
  clearIngestStore();
  const { restore } = setup();
  process.env.DEVCORE_METRICS_TOKEN_DEVCORE_DEMO_01 = TOKEN;
  try {
    const body = JSON.stringify(LIVE);
    assert.equal((await liveRequest(body)).status, 401);
    assert.equal((await liveRequest(body, "wrong-token")).status, 401);
    assert.equal((await liveRequest(body, TOKEN, "nao-existe")).status, 401);
    assert.equal((await liveRequest(JSON.stringify(SAMPLE), TOKEN)).status, 422);

    const demo = findDevcoreVm("devcore-demo-01")!;
    assert.deepEqual(getDevcoreLive(demo), { live: null, receivedAt: null, ageMs: null, fresh: false });

    const accepted = await liveRequest(body, TOKEN);
    assert.equal(accepted.status, 204);
    assert.equal(accepted.headers.get("cache-control"), "private, no-store");
    const received = Date.now();
    const soon = getDevcoreLive(demo, new Date(received + 5_000));
    assert.equal(soon.fresh, true);
    assert.equal(soon.live?.inflight.devcore, 9);
    const late = getDevcoreLive(demo, new Date(received + 60_000));
    assert.equal(late.fresh, false);
    assert.ok(late.live, "last snapshot is kept for display");
    // The minute metrics are untouched by the live push.
    assert.equal((await getDevcoreMetrics(demo)).failure, "waiting");
  } finally {
    restore();
    delete process.env.DEVCORE_METRICS_TOKEN_DEVCORE_DEMO_01;
    clearIngestStore();
  }
});

// ---------------------------------------------------------------- technical opinion

/** Today's real numbers on devcore-demo-01 (2026-10-14, agent 1.2). */
function busyDay(): DevcoreMetrics {
  const base = metricsSchemaV1.parse(SAMPLE);
  return {
    ...base,
    today: {
      ...base.today,
      requests: 643, requests_ok: 577, errors_4xx: 54, errors_5xx: 0, cancelled_499: 12,
      latency_s: { p50: 34.4, p95: 401 },
      ttfb_s: { p50: 3.7, p95: 31.8 },
      inflight: { peak: { devcore: 15, other: 0, total: 15 }, saturation_pct: { devcore: 7.1, total: 7.1 } },
      gpu: { util_avg: 18.6, util_max: 100, mem_mb_avg: 43521, mem_mb_max: 43521, mem_mb_total: 46068 },
      server: {
        ctx_per_slot: 27904, context_exceeded: 54, context_exceeded_max_tokens: 48357, errors_other: 0,
        context_tokens: { p50: 11374, p95: 27356 }, decode_tps: { p50: 10.76, p10: 7.35 }, prefill_tps_p50: 1160,
      },
    },
  };
}

test("agent fixture carries the server log block", () => {
  const server = metricsSchemaV1.parse(SAMPLE).today.server;
  assert.equal(server?.ctx_per_slot, 27904);
  assert.equal(server?.context_exceeded, 2);
});

test("opinion on a busy day names context, queue, speed and VRAM with their fixes", () => {
  const a = assessMetrics(busyDay());
  assert.equal(a.verdict, "alert");
  assert.deepEqual(a.findings.map((f) => [f.id, f.severity]), [
    ["context", "alert"], ["ttfb", "alert"], ["queue", "warn"], ["decode", "warn"], ["vram", "warn"],
  ]);
  const context = a.findings[0];
  assert.match(context.evidence, /54 de 643 requisições \(8,4%\)/);
  assert.match(context.evidence, /48\.357 tokens/);
  assert.match(a.findings.find((f) => f.id === "queue")!.evidence, /15 requisições simultâneas para 8 slots: 7 esperaram/);
  // Peak above half the slots: halving --parallel is not offered.
  assert.deepEqual(a.adjustments.map((r) => r.id), ["client-context", "kv-quant", "client-concurrency", "lighter-quant"]);
  assert.match(a.adjustments[0].text, /23\.000 tokens/);
  assert.deepEqual(a.upgrades.map((r) => r.id), ["gpu-bigger", "second-node"]);
  assert.ok(a.upgrades[0].addresses.includes("VRAM quase cheia"));
  assert.equal(a.summary, "2 pontos de atenção e 3 pontos para observar nos indicadores de hoje.");
});

test("opinion offers fewer slots when the peak leaves half of them idle", () => {
  const day = busyDay();
  day.today.inflight = { peak: { devcore: 3, other: 0, total: 3 }, saturation_pct: { devcore: 0, total: 0 } };
  const a = assessMetrics(day);
  assert.ok(a.adjustments.some((r) => r.id === "fewer-slots" && /55\.808 tokens/.test(r.text)));
  assert.ok(!a.findings.some((f) => f.id === "queue"));
});

test("opinion is healthy on a quiet day and partial without the server log", () => {
  const quiet = busyDay();
  quiet.today = {
    ...quiet.today,
    requests: 100, requests_ok: 100, errors_4xx: 0, cancelled_499: 0,
    latency_s: { p50: 4, p95: 9 }, ttfb_s: { p50: 0.5, p95: 2 },
    inflight: { peak: { devcore: 4, other: 0, total: 4 }, saturation_pct: { devcore: 0, total: 0 } },
    gpu: { ...quiet.today.gpu, mem_mb_max: 30000 },
    server: { ...quiet.today.server!, context_exceeded: 0, context_exceeded_max_tokens: null,
      context_tokens: { p50: 5000, p95: 12000 }, decode_tps: { p50: 35, p10: 25 } },
  };
  const ok = assessMetrics(quiet);
  assert.equal(ok.verdict, "ok");
  assert.deepEqual(ok.findings, []);
  assert.equal(ok.summary, "Nenhum problema relevante nos indicadores de hoje.");

  const old = busyDay();
  delete (old.today as { server?: unknown }).server;
  const partial = assessMetrics(old);
  const context = partial.findings.find((f) => f.id === "context");
  assert.equal(context?.title, "Requisições recusadas (4xx)");
  assert.ok(partial.adjustments.some((r) => r.id === "update-agent"));
});
