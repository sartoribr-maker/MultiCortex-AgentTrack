import "server-only";
import { z } from "zod";
import { operationalSchema } from "./operational-schema";

export const universalTelemetrySchema = z.object({
  agent_id: z.string().uuid(),
  timestamp: z.string().datetime(),
  agent_version: z.string().max(64),
  metrics: z.object({
    gpu: z.unknown().optional(),
    llama: z.unknown().optional(),
    fallback: z.boolean().optional(),
    operational: operationalSchema.optional(),
  }).strict(),
}).strict();

export type UniversalTelemetry = z.infer<
  typeof universalTelemetrySchema
>;
