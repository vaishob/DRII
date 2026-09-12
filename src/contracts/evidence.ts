import { z } from "zod";

export const evidenceScopeSchema = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().min(1).nullable(),
  visibility: z.enum(["PUBLIC", "PRIVATE"]),
  before: z.string().datetime().nullable(),
});
export type EvidenceScope = z.infer<typeof evidenceScopeSchema>;

export const evidenceSchema = z.object({
  sourceId: z.string().min(1),
  title: z.string().min(1),
  excerpt: z.string().min(1),
  occurredAt: z.string().datetime(),
  relevance: z.number().min(0).max(1),
  metadata: z.record(z.unknown()),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export interface EvidenceRetriever {
  retrieveEvidence(query: string, scope: EvidenceScope): Promise<Evidence[]>;
}
