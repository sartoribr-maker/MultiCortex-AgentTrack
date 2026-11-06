import { z } from "zod";
import { brasiliaDate } from "./view";
import { metricsSchemaV1, liveSchemaV1 } from "./metrics-schema";

export const operationalMetricsSchema = metricsSchemaV1.refine(value =>
  (value.today.developer_list ?? []).every(developer => /^dev-[a-f0-9]{20}$/.test(developer.ip)),
"Identificadores de desenvolvedores devem ser pseudonimizados");
export const operationalSchema = z.object({
  version: z.literal(1), status: z.enum(["available", "unavailable"]),
  source: z.enum(["existing", "capture"]).nullable(), reason: z.enum(["approval_required", "identity_required", "source_not_configured", "tcpdump_unavailable", "server_selection_required", "hosts_required", "source_identity_mismatch", "source_stale", "collection_failed", "capture_warming_up", "capture_unavailable", "http_not_observed"]).nullable(),
  metrics: operationalMetricsSchema.nullable(), live: liveSchemaV1.nullable(),
  developer_identity: z.literal("pseudonymous"),
}).strict().refine(value => value.status === "available" ? value.metrics !== null && value.source !== null : value.metrics === null && value.live === null,
"Estado operacional inconsistente").refine(value => !value.metrics ||
  value.metrics.today.date === brasiliaDate(new Date(value.metrics.generated_at)), "Dia operacional inconsistente");
export type OperationalPayload = z.infer<typeof operationalSchema>;
export type OperationalView = OperationalPayload & { receivedAt: string; fresh: boolean };
