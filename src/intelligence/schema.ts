import { z } from 'zod';

export const MAX_CLAIMS = 8;
export const MAX_TOOL_QUERIES = 10;
export const MODEL_ATTEMPTS = 2;
export const MODEL_TIMEOUT_MS = 45_000;
const text = z.string().min(1).max(2000);
const reference = z.object({ segmentId: text, quote: text }).strict();
export const ExtractionSchema = z
  .object({
    summary: text,
    question: z.string().max(2000).nullable(),
    options: z
      .array(z.object({ id: text, title: text, description: text }).strict())
      .max(8),
    claims: z
      .array(
        z
          .object({
            id: text,
            text,
            references: z.array(reference).min(1).max(4),
          })
          .strict(),
      )
      .max(MAX_CLAIMS),
    priorities: z
      .array(
        z
          .object({
            description: text,
            segmentId: text,
            quote: text,
            inferred: z.boolean(),
            kind: z.enum(['CONSTRAINT', 'PREFERENCE']),
          })
          .strict(),
      )
      .max(12),
    disagreements: z.array(text).max(8),
    clarification: text.nullable(),
  })
  .strict();
export type Extraction = z.infer<typeof ExtractionSchema>;
const citation = z.object({ evidenceId: text, quote: text }).strict();
export const ReviewSchema = z
  .object({
    checks: z
      .array(
        z
          .object({
            claimId: text,
            status: z.enum([
              'SUPPORTED',
              'CONTRADICTED',
              'INSUFFICIENT_EVIDENCE',
            ]),
            explanation: text,
            citations: z.array(citation).max(8),
          })
          .strict(),
      )
      .max(MAX_CLAIMS),
    objection: z
      .object({
        text,
        citations: z.array(citation).max(8),
        wouldChangeAssessment: text,
      })
      .strict(),
    additionalQueries: z.array(text).max(2),
    comparison: z
      .array(z.object({ optionId: text, assessment: text }).strict())
      .max(8),
    recommendation: z
      .object({ optionId: text.nullable(), conditions: z.array(text).max(8) })
      .strict(),
    question: z.object({ text, role: text }).strict().nullable(),
    actions: z
      .array(
        z
          .object({
            id: text,
            description: text,
            dependsOn: z.array(text).max(8),
            proposedOwner: text.nullable(),
            dueAt: z.string().nullable(),
          })
          .strict(),
      )
      .max(8),
    assumptions: z
      .array(
        z
          .object({
            id: text,
            text,
            sourceId: text.nullable(),
            metricName: text.nullable(),
            operator: z.enum(['LT', 'LTE', 'EQ', 'GTE', 'GT']).nullable(),
            threshold: z.number().nullable(),
            unit: text.nullable(),
            proposedOwner: text.nullable(),
            reviewAt: z.string().nullable(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type Review = z.infer<typeof ReviewSchema>;
export const AnalysisSchema = z
  .object({
    extraction: ExtractionSchema,
    review: ReviewSchema.nullable(),
    gaps: z.array(z.string()).max(24),
    model: z.string(),
  })
  .strict();
export type Analysis = z.infer<typeof AnalysisSchema>;
