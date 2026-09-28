/**
 * DetectionRepository 的 Prisma 实现（C-0004 Checkpoint 1）
 * ---------------------------------------------------------------
 * 只做“读账单/轨迹 + 读规则候选 + 写评估/机会”的翻译工作，不含业务判断。
 * 账单/轨迹都来自既有 SourceTransaction（referenceType 区分），不引入新表。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { parseFreightRateDefinition, type RuleCandidate } from './freight-rate';
import type {
  DetectionRepository,
  EvaluationDraft,
  InvoiceRow,
  OpportunityDraft,
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

export function createPrismaDetectionRepository(prisma: PrismaClient): DetectionRepository {
  return {
    async listInvoices(organizationId, connectionId = null): Promise<InvoiceRow[]> {
      const rows = await prisma.sourceTransaction.findMany({
        where: {
          organizationId,
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

    async listTracking(organizationId, connectionId = null): Promise<TrackingRow[]> {
      const rows = await prisma.sourceTransaction.findMany({
        where: {
          organizationId,
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

    async listFreightRateRuleCandidates(organizationId): Promise<RuleCandidate[]> {
      const versions = await prisma.ruleVersion.findMany({
        where: {
          isActive: true,
          ruleSet: { scope: 'FREIGHT_RATE', isActive: true, OR: [{ organizationId }, { organizationId: null }] },
        },
        orderBy: [{ tier: 'asc' }, { effectiveFrom: 'desc' }],
      });
      const candidates: RuleCandidate[] = [];
      for (const version of versions) {
        const definition = parseFreightRateDefinition(version.definition);
        candidates.push({
          ruleVersionId: version.id,
          tier: version.tier,
          version: version.version,
          effectiveFrom: version.effectiveFrom,
          effectiveTo: version.effectiveTo,
          isActive: version.isActive,
          definition,
        });
      }
      return candidates;
    },

    async findEvaluationByDedupeKey(dedupeKey) {
      const found = await prisma.ruleEvaluation.findUnique({
        where: { dedupeKey },
        select: { id: true, opportunityId: true },
      });
      return found ?? null;
    },

    async createEvaluation(draft: EvaluationDraft) {
      const created = await prisma.ruleEvaluation.create({
        data: {
          organizationId: draft.organizationId,
          ruleVersionId: draft.ruleVersionId,
          sourceTransactionId: draft.sourceTransactionId,
          result: draft.result,
          computed: draft.computed as Prisma.InputJsonValue,
          message: draft.message,
          dedupeKey: draft.dedupeKey,
        },
        select: { id: true },
      });
      return { id: created.id };
    },

    async createOpportunity(draft: OpportunityDraft) {
      const created = await prisma.recoveryOpportunity.create({
        data: {
          organizationId: draft.organizationId,
          domain: draft.domain,
          channel: draft.channel,
          opportunityType: draft.opportunityType,
          title: draft.title,
          description: draft.description,
          amountExpected: new Prisma.Decimal(draft.amountExpected),
          amountActual: new Prisma.Decimal(draft.amountActual),
          recoverableAmount: new Prisma.Decimal(draft.recoverableAmount),
          currency: draft.currency,
          status: 'DETECTED',
        },
        select: { id: true },
      });
      return { id: created.id };
    },

    async linkEvaluationToOpportunity(evaluationId, opportunityId) {
      await prisma.ruleEvaluation.update({
        where: { id: evaluationId },
        data: { opportunityId },
      });
    },
  };
}
