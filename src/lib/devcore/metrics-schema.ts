import { z } from "zod";

// Mirrors infra/devcore-vm-agent/devcore_metrics_agent.py (schema 1).
const num = z.number().finite().nullable();
const count = z.number().int().nonnegative();

const percentiles = z.object({ p50: num, p95: num });

// Agent 1.1+: concurrent requests computed from the request log.
const inflightSchema = z.object({
  peak: z.object({ devcore: count, other: count, total: count }),
  saturation_pct: z.object({ devcore: z.number(), total: z.number() }),
});

// Agent 1.2+: today's llama.cpp journal (reasons for errors, context, speed).
const serverSchema = z.object({
  ctx_per_slot: count.nullable(),
  context_exceeded: count,
  context_exceeded_max_tokens: count.nullable(),
  errors_other: count,
  context_tokens: percentiles,
  decode_tps: z.object({ p50: num, p10: num }),
  prefill_tps_p50: num,
});

// Agent 1.3+: today's usage per developer IP (staff-only dashboard).
const developerSchema = z.object({
  ip: z.string().max(64),
  requests: count,
  requests_ok: count,
  errors_4xx: count,
  errors_5xx: count,
  cancelled_499: count,
  first_seen: z.string().datetime({ offset: true }),
  last_seen: z.string().datetime({ offset: true }),
  active_s: count,
  latency_p50: num,
  ttfb_p50: num,
});

export type DevcoreDeveloper = z.infer<typeof developerSchema>;

export const metricsSchemaV1 = z.object({
  schema: z.literal(1),
  agent_version: z.string(),
  generated_at: z.string().datetime({ offset: true }),
  host: z.string(),
  utc_offset_minutes: z.number().int(),
  slots: z.number().int().positive(),
  sources: z.object({
    samples: z.object({ last_ts: z.string().nullable(), lines_ok: count, lines_invalid: count }),
    access_log: z.object({ last_ts: z.string().nullable(), lines_ok: count, lines_invalid: count }),
  }),
  today: z.object({
    date: z.string(),
    requests: count,
    requests_ok: count,
    errors_4xx: count,
    errors_5xx: count,
    cancelled_499: count,
    error_rate: z.number().min(0).max(1),
    developers: count,
    latency_s: percentiles,
    ttfb_s: percentiles,
    samples: count,
    conn_peak: z.object({ devcore: count, site: count, total: count }),
    saturation_pct: z.object({ devcore: z.number(), total: z.number() }),
    inflight: inflightSchema.optional(),
    other_requests: count.optional(),
    server: serverSchema.optional(),
    developer_list: z.array(developerSchema).max(200).optional(),
    gpu: z.object({ util_avg: num, util_max: num, mem_mb_avg: num, mem_mb_max: num, mem_mb_total: num }),
  }),
  hourly_24h: z.array(z.object({
    start: z.string(),
    requests: count,
    errors: count,
    p50: num, p95: num, ttfb_p50: num, ttfb_p95: num,
  })).max(48),
  timeline_today: z.object({
    interval_s: z.number().int().positive(),
    points: z.array(z.object({
      t: z.string(),
      conn_devcore_max: count.nullable(),
      conn_site_max: count.nullable(),
      inflight_devcore_max: count.optional(),
      inflight_other_max: count.optional(),
      gpu_util_avg: num,
      gpu_util_max: num,
      gpu_mem_mb_max: num,
    })).max(2000),
  }),
  daily: z.array(z.object({
    date: z.string(),
    requests: count,
    errors: count,
    developers: count,
    p50: num, p95: num,
    conn_peak_total: count,
    saturation_pct_total: z.number(),
    inflight_peak_total: count.optional(),
    inflight_saturation_pct_total: z.number().optional(),
    gpu_util_avg: num,
  })).max(400),
});

export type DevcoreMetrics = z.infer<typeof metricsSchemaV1>;

// devcore_http_capture.py 1.3+: snapshot of this moment, pushed every 10 s to
// /api/devcore/ingest/<vm>/live. Counts only, never IPs.
export const liveSchemaV1 = z.object({
  schema: z.literal(1),
  kind: z.literal("live"),
  capture_version: z.string(),
  generated_at: z.string().datetime({ offset: true }),
  slots: z.number().int().positive(),
  window_s: z.number().int().positive(),
  developers: z.object({ online: count, active: count }),
  inflight: z.object({ devcore: count, other: count }),
  gpu: z.object({ util: num, mem_mb: num, mem_mb_total: num }),
});

export type DevcoreLive = z.infer<typeof liveSchemaV1>;
