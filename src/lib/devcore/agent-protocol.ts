import "server-only";
import { z } from "zod";

export const agentIdSchema = z.string().uuid();

export const enrollmentSchema = z.object({
  identity: z.object({
    agent_id: agentIdSchema,
    platform: z.enum(["runpod", "unknown"]),
    pod_id: z.string().max(128).nullable().optional(),
    hostname: z.string().min(1).max(255),
    agent_version: z.string().min(1).max(64),
    enrollment_key: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict();

export const agentActionSchema = z.object({
  action: z.enum(["approve", "revoke"]),
}).strict();

export function publicAgentStatus(status: string) {
  if (status === "pending") return { status: "pending" };
  if (status === "approved") return { status: "approved" };
  if (status === "revoked") return { status: "revoked" };
  return { status: "unknown" };
}
