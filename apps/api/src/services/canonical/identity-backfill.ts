/**
 * C-0006-B2 — RuleEvaluation identity backfill planner (dry-run first).
 * ---------------------------------------------------------------
 * Approved boundary for B2-Step 1: prepare the schema only. This planner lets
 * us *measure* the migration before touching data:
 *
 *   RuleEvaluation.sourceTransactionId → CanonicalFactSource → CanonicalFact
 *
 * A row is mappable only when exactly one ACTIVE fact owns that raw row.
 * Anything else stays unmappable (NULL identity) and is reported by reason —
 * we never guess an identity for money-affecting records.
 */

import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

export function canonicalDedupeKeyFor(input: {
  organizationId: string;
  ruleVersionId: string;
  canonicalFactId: string;
}): string {
  return createHash('sha256')
    .update(
      [input.organizationId, input.ruleVersionId, input.canonicalFactId].join('|'),
      'utf8',
    )
    .digest('hex');
}

export type IdentityUnmappedReason =
  | 'NO_SOURCE_TRANSACTION'
  | 'NO_ACTIVE_FACT'
  | 'CONFLICT_FACT'
  | 'AMBIGUOUS_FACTS'
  | 'DUPLICATE_TARGET';

export interface IdentityBackfillUpdate {
  ruleEvaluationId: string;
  organizationId: string;
  canonicalFactId: string;
  canonicalDedupeKey: string;
}

export interface IdentityBackfillPlan {
  scanned: number;
  alreadyMapped: number;
  updates: IdentityBackfillUpdate[];
  unmapped: Record<IdentityUnmappedReason, number>;
  unmappedSamples: Array<{ ruleEvaluationId: string; reason: IdentityUnmappedReason }>;
  /** true 只有当 unmapped 全为 0 且没有重复目标（架构方要求 unmapped = 0% 才可切换）。 */
  canSwitch: boolean;
}

const EMPTY_UNMAPPED = (): Record<IdentityUnmappedReason, number> => ({
  NO_SOURCE_TRANSACTION: 0,
  NO_ACTIVE_FACT: 0,
  CONFLICT_FACT: 0,
  AMBIGUOUS_FACTS: 0,
  DUPLICATE_TARGET: 0,
});

export interface PlanIdentityBackfillInput {
  organizationId?: string;
  limit?: number;
}

export async function planIdentityBackfill(
  prisma: PrismaClient,
  input: PlanIdentityBackfillInput = {},
): Promise<IdentityBackfillPlan> {
  const rows = await prisma.ruleEvaluation.findMany({
    where: {
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    },
    select: {
      id: true,
      organizationId: true,
      ruleVersionId: true,
      sourceTransactionId: true,
      canonicalFactId: true,
      canonicalDedupeKey: true,
    },
    orderBy: { evaluatedAt: 'asc' },
    ...(input.limit ? { take: input.limit } : {}),
  });

  const plan: IdentityBackfillPlan = {
    scanned: rows.length,
    alreadyMapped: 0,
    updates: [],
    unmapped: EMPTY_UNMAPPED(),
    unmappedSamples: [],
    canSwitch: false,
  };

  const transactionIds = rows
    .map((row) => row.sourceTransactionId)
    .filter((value): value is string => value !== null && value !== '');

  const links = transactionIds.length
    ? await prisma.canonicalFactSource.findMany({
        where: {
          sourceTransactionId: { in: transactionIds },
          ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        },
        select: {
          sourceTransactionId: true,
          canonicalFact: { select: { id: true, status: true } },
        },
      })
    : [];

  const factsByTransaction = new Map<string, Array<{ id: string; status: string }>>();
  for (const link of links) {
    const bucket = factsByTransaction.get(link.sourceTransactionId);
    const fact = { id: link.canonicalFact.id, status: link.canonicalFact.status };
    if (bucket) bucket.push(fact);
    else factsByTransaction.set(link.sourceTransactionId, [fact]);
  }

  const reasons = new Map<string, IdentityUnmappedReason>();
  const claim = (row: { id: string }, reason: IdentityUnmappedReason) => {
    plan.unmapped[reason] += 1;
    if (plan.unmappedSamples.length < 20) {
      plan.unmappedSamples.push({ ruleEvaluationId: row.id, reason });
    }
  };

  for (const row of rows) {
    if (row.canonicalDedupeKey !== null && row.canonicalFactId !== null) {
      plan.alreadyMapped += 1;
      continue;
    }
    if (!row.sourceTransactionId) {
      reasons.set(row.id, 'NO_SOURCE_TRANSACTION');
      continue;
    }
    const facts = factsByTransaction.get(row.sourceTransactionId) ?? [];
    if (facts.length === 0) {
      reasons.set(row.id, 'NO_ACTIVE_FACT');
      continue;
    }
    if (facts.length > 1) {
      reasons.set(row.id, 'AMBIGUOUS_FACTS');
      continue;
    }
    if (facts[0].status !== 'ACTIVE') {
      reasons.set(row.id, 'CONFLICT_FACT');
      continue;
    }
    plan.updates.push({
      ruleEvaluationId: row.id,
      organizationId: row.organizationId,
      canonicalFactId: facts[0].id,
      canonicalDedupeKey: canonicalDedupeKeyFor({
        organizationId: row.organizationId,
        ruleVersionId: row.ruleVersionId,
        canonicalFactId: facts[0].id,
      }),
    });
  }

  // A target key may already exist on another row, or two rows may map to the
  // same fact identity: both are ambiguous for money-affecting records.
  const targetCount = new Map<string, number>();
  for (const update of plan.updates) {
    targetCount.set(update.canonicalDedupeKey, (targetCount.get(update.canonicalDedupeKey) ?? 0) + 1);
  }
  const kept: IdentityBackfillUpdate[] = [];
  for (const update of plan.updates) {
    if ((targetCount.get(update.canonicalDedupeKey) ?? 0) > 1) {
      reasons.set(update.ruleEvaluationId, 'DUPLICATE_TARGET');
      continue;
    }
    kept.push(update);
  }
  plan.updates = kept;

  for (const row of rows) {
    const reason = reasons.get(row.id);
    if (reason) claim(row, reason);
  }

  const unmappedTotal = Object.values(plan.unmapped).reduce((sum, value) => sum + value, 0);
  plan.canSwitch = unmappedTotal === 0 && plan.updates.every((update) => update.canonicalDedupeKey);
  return plan;
}

export interface ApplyIdentityBackfillResult {
  dryRun: boolean;
  planned: number;
  updated: number;
}

export async function applyIdentityBackfill(
  prisma: PrismaClient,
  plan: IdentityBackfillPlan,
  options: { dryRun?: boolean } = {},
): Promise<ApplyIdentityBackfillResult> {
  const dryRun = options.dryRun ?? true;
  if (dryRun || plan.updates.length === 0) {
    return { dryRun, planned: plan.updates.length, updated: 0 };
  }

  let updated = 0;
  for (const update of plan.updates) {
    const result = await prisma.ruleEvaluation.updateMany({
      where: { id: update.ruleEvaluationId, canonicalDedupeKey: null },
      data: {
        canonicalFactId: update.canonicalFactId,
        canonicalDedupeKey: update.canonicalDedupeKey,
      },
    });
    updated += result.count;
  }
  return { dryRun, planned: plan.updates.length, updated };
}
