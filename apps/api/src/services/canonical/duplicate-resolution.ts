/**
 * C-0006-B2 Step 3 前置 — duplicate-resolution-report.
 * ---------------------------------------------------------------
 * The switch gate requires unmapped = 0, including DUPLICATE_TARGET. Before
 * anything can be resolved we must be able to answer, per unmapped row:
 *
 *   - which RuleEvaluation is affected
 *   - which canonical fact it points at
 *   - which row already holds that identity
 *   - are the two rows equivalent (same rule version + same raw transaction)?
 *   - what should happen (keep existing / manual review / no action)
 *
 * The report is evidence only: it never mutates data and never deletes rows.
 */

import type { PrismaClient } from '@prisma/client';

import {
  planIdentityBackfill,
  type IdentityUnmappedReason,
} from './identity-backfill';
import { canonicalDedupeKeyFor } from './identity-key';

export type DuplicateResolutionRecommendation = 'KEEP_EXISTING' | 'MANUAL_REVIEW' | 'NO_ACTION';

export interface DuplicateResolutionEntry {
  ruleEvaluationId: string;
  organizationId: string;
  ruleVersionId: string;
  sourceTransactionId: string | null;
  reason: IdentityUnmappedReason;
  targetCanonicalFactId: string | null;
  targetCanonicalDedupeKey: string | null;
  existingRuleEvaluationIds: string[];
  /** 同一规则版本 + 同一原始行 → 判定为"等价重复"，否则需要人工复核。 */
  equivalent: boolean;
  recommendation: DuplicateResolutionRecommendation;
  explanation: string;
}

export interface DuplicateResolutionReport {
  organizationId: string | null;
  generatedAt: string;
  totals: Record<IdentityUnmappedReason, number>;
  entries: DuplicateResolutionEntry[];
  unresolved: number;
  resolution: 'CLEAR' | 'NEEDS_REVIEW';
}

export async function buildDuplicateResolutionReport(
  prisma: PrismaClient,
  input: { organizationId?: string; generatedAt?: Date } = {},
): Promise<DuplicateResolutionReport> {
  const plan = await planIdentityBackfill(prisma, input.organizationId ? { organizationId: input.organizationId } : {});
  const entries: DuplicateResolutionEntry[] = [];

  for (const unmapped of plan.unmappedEntries) {
    const row = await prisma.ruleEvaluation.findUniqueOrThrow({
      where: { id: unmapped.ruleEvaluationId },
      select: {
        id: true,
        organizationId: true,
        ruleVersionId: true,
        sourceTransactionId: true,
      },
    });

    const link = row.sourceTransactionId
      ? await prisma.canonicalFactSource.findFirst({
          where: {
            organizationId: row.organizationId,
            sourceTransactionId: row.sourceTransactionId,
            canonicalFact: { status: 'ACTIVE' },
          },
          select: { canonicalFactId: true },
        })
      : null;

    const targetCanonicalFactId = link?.canonicalFactId ?? null;
    const targetCanonicalDedupeKey = targetCanonicalFactId
      ? canonicalDedupeKeyFor({
          organizationId: row.organizationId,
          ruleVersionId: row.ruleVersionId,
          canonicalFactId: targetCanonicalFactId,
        })
      : null;

    const existing = targetCanonicalDedupeKey
      ? await prisma.ruleEvaluation.findMany({
          where: {
            organizationId: row.organizationId,
            canonicalDedupeKey: targetCanonicalDedupeKey,
          },
          select: { id: true, sourceTransactionId: true },
          orderBy: { evaluatedAt: 'asc' },
        })
      : [];

    const equivalent =
      existing.length === 1 && existing[0].sourceTransactionId === row.sourceTransactionId;
    const recommendation: DuplicateResolutionRecommendation =
      existing.length === 0
        ? 'NO_ACTION'
        : equivalent
          ? 'KEEP_EXISTING'
          : 'MANUAL_REVIEW';

    entries.push({
      ruleEvaluationId: row.id,
      organizationId: row.organizationId,
      ruleVersionId: row.ruleVersionId,
      sourceTransactionId: row.sourceTransactionId,
      reason: unmapped.reason,
      targetCanonicalFactId,
      targetCanonicalDedupeKey,
      existingRuleEvaluationIds: existing.map((item) => item.id),
      equivalent,
      recommendation,
      explanation:
        existing.length === 0
          ? '没有可写入的新身份目标（缺少事实或事实冲突），保持 NULL，等数据补齐'
          : equivalent
            ? '同一规则版本 + 同一原始行已存在带新身份的行：本条属等价重复，建议保留既有身份行并在复核后人工处置'
            : '同一身份已被其他原始行占用：必须人工复核，禁止自动覆盖或删除',
    });
  }

  const unresolved = entries.filter((entry) => entry.recommendation === 'MANUAL_REVIEW').length;
  return {
    organizationId: input.organizationId ?? null,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    totals: plan.unmapped,
    entries,
    unresolved,
    resolution: plan.unmappedEntries.length === 0 ? 'CLEAR' : 'NEEDS_REVIEW',
  };
}
