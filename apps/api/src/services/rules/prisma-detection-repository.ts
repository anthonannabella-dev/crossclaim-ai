/**
 * DetectionRepository 的 Prisma 实现（C-0004 Checkpoint 1）
 * ---------------------------------------------------------------
 * 两点关键（架构方 CHANGE #39 / #40）：
 *   1. #40：账单 / 轨迹 / 规则三类查询全部显式限定 domain + channel（当前 slice = LOGISTICS / OTHER），
 *      不依赖“数据库里目前刚好只有 OTHER”。
 *   2. #39：Evaluation 与 Opportunity 在同一事务内落库；dedupeKey 已存在（重跑或并发）时返回
 *      数据库中**真实保存**的 result / computed / opportunityId，而不是把 OPPORTUNITY 报成 PASS。
 *      数据库唯一键 `RuleEvaluation.dedupeKey` 仍是最终幂等防线（P2002 → 回读已存在行）。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { canonicalDedupeKeyFor } from '../canonical/identity-key';
import {
  CanonicalIdentityRequiredError,
  resolveDetectionIdentityMode,
  type DetectionIdentityMode,
} from './identity-mode';
import { parseFreightRateDefinition, type RuleCandidate } from './freight-rate';
import type {
  DetectionPersistenceInput,
  DetectionPersistenceResult,
  DetectionRepository,
  DetectionScope,
  InvoiceRow,
  TrackingRow,
} from './detection-service';

const pickString = (raw: unknown, keys: string[]): string | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
};

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * C-0006-B2 Step 2：解析"业务事实身份"。
 * 只有恰好一条 ACTIVE CanonicalFact 通过 CanonicalFactSource 关联到该原始行时才给出身份；
 * 否则返回 null（调用方必须计数/告警，不得静默回退）。
 */
async function resolveCanonicalIdentity(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; ruleVersionId: string; sourceTransactionId: string | null },
): Promise<{ canonicalFactId: string; canonicalDedupeKey: string } | null> {
  if (!input.sourceTransactionId) return null;
  const link = await tx.canonicalFactSource.findFirst({
    where: {
      organizationId: input.organizationId,
      sourceTransactionId: input.sourceTransactionId,
      canonicalFact: { status: 'ACTIVE' },
    },
    select: { canonicalFactId: true },
  });
  if (!link) return null;
  return {
    canonicalFactId: link.canonicalFactId,
    canonicalDedupeKey: canonicalDedupeKeyFor({
      organizationId: input.organizationId,
      ruleVersionId: input.ruleVersionId,
      canonicalFactId: link.canonicalFactId,
    }),
  };
}

export interface PrismaDetectionRepositoryOptions {
  /** C-0006-B2 Step 3：身份模式；默认 legacy（读环境变量 DETECTION_IDENTITY_MODE）。 */
  identityMode?: DetectionIdentityMode;
}

export function createPrismaDetectionRepository(
  prisma: PrismaClient,
  options: PrismaDetectionRepositoryOptions = {},
): DetectionRepository {
  const identityMode = resolveDetectionIdentityMode(options.identityMode);
  const readExisting = async (
    dedupeKey: string,
  ): Promise<DetectionPersistenceResult | null> => {
    const existing = await prisma.ruleEvaluation.findUnique({
      where: { dedupeKey },
      select: { id: true, result: true, computed: true, opportunityId: true },
    });
    if (!existing) return null;
    return {
      evaluationId: existing.id,
      created: false,
      result: existing.result === 'OPPORTUNITY' ? 'OPPORTUNITY' : 'PASS',
      computed: existing.computed,
      opportunityId: existing.opportunityId,
    };
  };

  return {
    async listInvoices(organizationId, scope: DetectionScope, connectionId = null): Promise<InvoiceRow[]> {
      const rows = await prisma.sourceTransaction.findMany({
        where: {
          organizationId,
          domain: scope.domain,
          channel: scope.channel,
          referenceType: 'INVOICE',
          ...(connectionId ? { connectionId } : {}),
        },
        orderBy: { externalId: 'asc' },
      });
      return rows.map((row) => ({
        sourceTransactionId: row.id,
        externalId: row.externalId,
        occurredAt: row.occurredAt,
        amount: row.amount ? row.amount.toFixed(4) : null,
        currency: row.currency,
        trackingNumber: pickString(row.raw, ['Tracking Number', 'trackingNumber', 'tracking']),
      }));
    },

    async listTracking(organizationId, scope: DetectionScope, connectionId = null): Promise<TrackingRow[]> {
      const rows = await prisma.sourceTransaction.findMany({
        where: {
          organizationId,
          domain: scope.domain,
          channel: scope.channel,
          referenceType: 'TRACKING',
          ...(connectionId ? { connectionId } : {}),
        },
        orderBy: { externalId: 'asc' },
      });
      return rows.map((row) => ({
        sourceTransactionId: row.id,
        externalId: row.externalId,
        lane: pickString(row.raw, ['Lane', 'lane']),
        service: pickString(row.raw, ['Service', 'service']),
        weightKg: pickString(row.raw, ['Weight Kg', 'weightKg', 'weight']),
      }));
    },

    async listFreightRateRuleCandidates(
      organizationId,
      scope: DetectionScope,
    ): Promise<RuleCandidate[]> {
      const versions = await prisma.ruleVersion.findMany({
        where: {
          isActive: true,
          ruleSet: {
            scope: 'FREIGHT_RATE',
            domain: scope.domain,
            channel: scope.channel,
            isActive: true,
            OR: [{ organizationId }, { organizationId: null }],
          },
        },
        orderBy: [{ tier: 'asc' }, { effectiveFrom: 'desc' }],
      });
      const candidates: RuleCandidate[] = [];
      for (const version of versions) {
        candidates.push({
          ruleVersionId: version.id,
          tier: version.tier,
          version: version.version,
          effectiveFrom: version.effectiveFrom,
          effectiveTo: version.effectiveTo,
          isActive: version.isActive,
          definition: parseFreightRateDefinition(version.definition),
        });
      }
      return candidates;
    },

    async persistDetectionOutcome(
      input: DetectionPersistenceInput,
    ): Promise<DetectionPersistenceResult> {
      try {
        return await prisma.$transaction(async (tx) => {
          const resolvedIdentity = await resolveCanonicalIdentity(tx, {
            organizationId: input.organizationId,
            ruleVersionId: input.ruleVersionId,
            sourceTransactionId: input.sourceTransactionId,
          });
          // canonical 模式：身份缺失必须 fail closed，绝不退化到旧键
          if (identityMode === 'canonical' && !resolvedIdentity) {
            throw new CanonicalIdentityRequiredError(input.sourceTransactionId);
          }
          if (resolvedIdentity) {
            const sameIdentity = await tx.ruleEvaluation.findFirst({
              where: {
                organizationId: input.organizationId,
                canonicalDedupeKey: resolvedIdentity.canonicalDedupeKey,
              },
              select: {
                id: true,
                result: true,
                computed: true,
                opportunityId: true,
                canonicalDedupeKey: true,
              },
            });
            if (sameIdentity) {
              return {
                evaluationId: sameIdentity.id,
                created: false,
                result: sameIdentity.result === 'OPPORTUNITY' ? 'OPPORTUNITY' : 'PASS',
                computed: sameIdentity.computed,
                opportunityId: sameIdentity.opportunityId,
                canonicalIdentity: 'MAPPED',
              } satisfies DetectionPersistenceResult;
            }
          }
          const existing = await tx.ruleEvaluation.findUnique({
            where: { dedupeKey: input.dedupeKey },
            select: {
              id: true,
              result: true,
              computed: true,
              opportunityId: true,
              canonicalDedupeKey: true,
            },
          });
          if (existing) {
            return {
              evaluationId: existing.id,
              created: false,
              result: existing.result === 'OPPORTUNITY' ? 'OPPORTUNITY' : 'PASS',
              computed: existing.computed,
              opportunityId: existing.opportunityId,
              canonicalIdentity: existing.canonicalDedupeKey ? 'MAPPED' : 'MISSING',
            } satisfies DetectionPersistenceResult;
          }

          const canonicalIdentity = resolvedIdentity;
          // TRACK C2 M4：Opportunity 的 account 归属由服务端从 canonical fact 派生。
          const transactionAccountId = input.sourceTransactionId
            ? ((
                await tx.sourceTransaction.findFirst({
                  where: { organizationId: input.organizationId, id: input.sourceTransactionId },
                  select: { accountId: true },
                })
              )?.accountId ?? null)
            : null;
          const opportunityAccountId = canonicalIdentity
            ? ((
                await tx.canonicalFact.findFirst({
                  where: {
                    organizationId: input.organizationId,
                    id: canonicalIdentity.canonicalFactId,
                  },
                  select: { accountId: true },
                })
              )?.accountId ?? transactionAccountId)
            : transactionAccountId;

          const evaluation = await tx.ruleEvaluation.create({
            data: {
              organizationId: input.organizationId,
              ruleVersionId: input.ruleVersionId,
              sourceTransactionId: input.sourceTransactionId,
              result: input.result,
              computed: input.computed as Prisma.InputJsonValue,
              message: input.message,
              dedupeKey: input.dedupeKey,
              ...(canonicalIdentity
                ? {
                    canonicalFactId: canonicalIdentity.canonicalFactId,
                    canonicalDedupeKey: canonicalIdentity.canonicalDedupeKey,
                  }
                : {}),
            },
            select: { id: true },
          });

          let opportunityId: string | null = null;
          if (input.opportunity) {
            const opportunity = await tx.recoveryOpportunity.create({
              data: {
                organizationId: input.opportunity.organizationId,
                accountId: opportunityAccountId,
                domain: input.opportunity.domain,
                channel: input.opportunity.channel,
                opportunityType: input.opportunity.opportunityType,
                title: input.opportunity.title,
                description: input.opportunity.description,
                amountExpected: new Prisma.Decimal(input.opportunity.amountExpected),
                amountActual: new Prisma.Decimal(input.opportunity.amountActual),
                recoverableAmount: new Prisma.Decimal(input.opportunity.recoverableAmount),
                currency: input.opportunity.currency,
                status: 'DETECTED',
              },
              select: { id: true },
            });
            await tx.ruleEvaluation.update({
              where: { id: evaluation.id },
              data: { opportunityId: opportunity.id },
            });
            opportunityId = opportunity.id;
          }

          return {
            evaluationId: evaluation.id,
            created: true,
            result: input.result,
            computed: input.computed,
            opportunityId,
            canonicalIdentity: canonicalIdentity ? 'MAPPED' : 'MISSING',
          } satisfies DetectionPersistenceResult;
        });
      } catch (error) {
        // 并发下另一个事务先写入同一 dedupeKey：唯一键兜底，回读真实结果
        if (isUniqueViolation(error)) {
          const existing = await readExisting(input.dedupeKey);
          if (existing) return existing;
        }
        throw error;
      }
    },
  };
}
