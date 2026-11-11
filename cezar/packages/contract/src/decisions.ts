import { z } from 'zod';

/**
 * Outstanding user decisions for a project (`GET /decisions`, `POST /decisions/:number/answer`).
 *
 * A decision is a GitHub issue the Factory parked in `factory:needs-help` (or
 * `factory:human-review`) because it needs a person to settle a major choice. The Factory
 * writes the ask as a structured `factory-decision:v1` comment marker (schemas/decision.schema.json,
 * emitted by scripts/route-state.ps1); this contract is what the cockpit reads back.
 *
 * `source` says how trustworthy the structure is: `structured` came from the marker and carries
 * suggested paths; `legacy` is an older free-text escalation, shown as a single open question with
 * no options so the user can still answer it in their own words.
 */
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

export const decisionOptionSchema = z.object({
  id: slug,
  label: z.string().min(1),
  summary: z.string().optional(),
  tradeoffs: z.string().optional(),
});
export type DecisionOption = z.infer<typeof decisionOptionSchema>;

export const decisionRequestSchema = z.object({
  id: z.string().min(1).max(40),
  question: z.string().min(1),
  context: z.string().optional(),
  options: z.array(decisionOptionSchema),
  recommendedOptionId: z.string().optional(),
});
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;

export const decisionItemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  /** The lifecycle label the issue is parked in. */
  state: z.enum(['factory:needs-help', 'factory:human-review']),
  labels: z.array(z.string()),
  updatedAt: z.string(),
  /** When the Factory asked (the escalation comment's timestamp), when known. */
  askedAt: z.string().optional(),
  source: z.enum(['structured', 'legacy']),
  decisions: z.array(decisionRequestSchema),
  /** Markdown of the Factory's own escalation comment, for details the structure does not carry. */
  details: z.string(),
});
export type DecisionItem = z.infer<typeof decisionItemSchema>;

export const decisionsResponseSchema = z.object({
  /** `false` is the ordinary answer when `gh` or the GitHub remote is unavailable — never an error. */
  available: z.boolean(),
  reason: z.string().optional(),
  items: z.array(decisionItemSchema),
});
export type DecisionsResponse = z.infer<typeof decisionsResponseSchema>;

export const decisionAnswerSchema = z.object({
  decisionId: z.string().min(1).max(40),
  /** A suggested path; omit to answer in your own words with `note`. */
  optionId: z.string().min(1).max(40).optional(),
  note: z.string().max(10_000).optional(),
}).refine((a) => a.optionId !== undefined || (a.note?.trim().length ?? 0) > 0, {
  message: 'choose a suggested path or write an answer',
});

export const answerDecisionBodySchema = z.object({
  answers: z.array(decisionAnswerSchema).min(1).max(20),
  /** Extra instructions for the planner, recorded beside the answers. */
  note: z.string().max(10_000).optional(),
});
export type AnswerDecisionBody = z.infer<typeof answerDecisionBodySchema>;

export const answerDecisionResponseSchema = z.object({
  number: z.number().int().positive(),
  /** The state the issue was returned to — planning resumes through the normal workflow. */
  state: z.literal('factory:needs-plan'),
});
export type AnswerDecisionResponse = z.infer<typeof answerDecisionResponseSchema>;
