import "server-only";
import { latestIngest } from "./ingest";
import { metricsSchemaV1, type DevcoreMetrics } from "./metrics-schema";
import { toPublicVm, type DevcoreVm, type PublicDevcoreVm } from "./registry";

export type DevcoreStatus = "online" | "stale" | "unavailable";
export type DevcoreFailure = "not_configured" | "timeout" | "network" | "http" | "invalid" | "waiting";

export type DevcoreMetricsResult = {
  vm: PublicDevcoreVm;
  status: DevcoreStatus;
  /** When the site last fetched (or tried to fetch) the agent. */
  fetchedAt: string;
  metrics: DevcoreMetrics | null;
  /** Category only — never URLs, tokens or upstream bodies. */
  failure?: DevcoreFailure;
};

export const CACHE_TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 2_000_000;
/** Agent writes every minute; older data means the timer or the VM stalled. */
const STALE_AFTER_MS = 5 * 60_000;

type Entry = { expires: number; value: Promise<DevcoreMetricsResult> };
const cache = new Map<string, Entry>();

class FetchFailure extends Error {
  constructor(readonly kind: DevcoreFailure, detail: string) {
    super(detail);
  }
}

function allowedUrl(raw: string): URL {
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" || (url.protocol === "http:" && local && process.env.NODE_ENV !== "production")) {
    return url;
  }
  throw new FetchFailure("not_configured", "metricsUrl must use https");
}

async function fetchFromAgent(vm: DevcoreVm, fetchImpl: typeof fetch): Promise<DevcoreMetrics> {
  const token = process.env[vm.tokenEnv]?.trim();
  if (!token) throw new FetchFailure("not_configured", `${vm.tokenEnv} is not set`);
  const url = allowedUrl(vm.metricsUrl ?? "");
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      // A redirect could forward the bearer token to another host.
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as Error)?.name;
    throw new FetchFailure(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", name || "fetch failed");
  }
  if (!response.ok) throw new FetchFailure("http", `HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) throw new FetchFailure("invalid", "response too large");
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new FetchFailure("invalid", "response too large");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new FetchFailure("invalid", "invalid JSON");
  }
  const parsed = metricsSchemaV1.safeParse(json);
  if (!parsed.success) throw new FetchFailure("invalid", `schema mismatch (${parsed.error.issues[0]?.path.join(".") || "root"})`);
  return parsed.data;
}

export function statusFor(metrics: DevcoreMetrics, now: Date): DevcoreStatus {
  const age = now.getTime() - new Date(metrics.generated_at).getTime();
  return age > STALE_AFTER_MS ? "stale" : "online";
}

async function load(vm: DevcoreVm, fetchImpl: typeof fetch, now: () => Date): Promise<DevcoreMetricsResult> {
  const base = { vm: toPublicVm(vm) };
  try {
    const metrics = await fetchFromAgent(vm, fetchImpl);
    const at = now();
    return { ...base, status: statusFor(metrics, at), fetchedAt: at.toISOString(), metrics };
  } catch (error) {
    const kind = error instanceof FetchFailure ? error.kind : "network";
    const detail = error instanceof FetchFailure ? error.message : "unexpected error";
    console.warn(`[devcore] VM ${vm.id} indisponível: ${kind} — ${detail}`);
    return { ...base, status: "unavailable", fetchedAt: now().toISOString(), metrics: null, failure: kind };
  }
}

/** Server-side fetch with a 60 s cache (15 s for failures) and request coalescing. */
export async function getDevcoreMetrics(
  vm: DevcoreVm,
  options: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): Promise<DevcoreMetricsResult> {
  const now = options.now ?? (() => new Date());
  if (vm.source === "push") return fromIngest(vm, now());
  const current = cache.get(vm.id);
  if (current && current.expires > now().getTime()) return current.value;

  const value = load(vm, options.fetchImpl ?? fetch, now);
  const entry: Entry = { expires: now().getTime() + CACHE_TTL_MS, value };
  cache.set(vm.id, entry);
  const result = await value;
  if (result.status === "unavailable") entry.expires = now().getTime() + FAILURE_TTL_MS;
  return result;
}

/** Push mode: the latest metrics the agent sent; no network call. */
function fromIngest(vm: DevcoreVm, now: Date): DevcoreMetricsResult {
  const base = { vm: toPublicVm(vm) };
  const latest = latestIngest(vm.id);
  if (!latest) {
    return { ...base, status: "unavailable", fetchedAt: now.toISOString(), metrics: null, failure: "waiting" };
  }
  // A silent agent (VM down, timer stopped) turns stale, then unavailable.
  const silentFor = now.getTime() - latest.receivedAt.getTime();
  const status = silentFor > 15 * 60_000 ? "unavailable" : statusFor(latest.metrics, now);
  return {
    ...base,
    status,
    fetchedAt: latest.receivedAt.toISOString(),
    metrics: latest.metrics,
    ...(status === "unavailable" ? { failure: "waiting" as const } : {}),
  };
}

export function clearDevcoreMetricsCache() {
  cache.clear();
}
