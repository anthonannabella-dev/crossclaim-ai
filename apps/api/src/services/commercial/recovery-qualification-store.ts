/**
 * P0-2 — qualification 判定的 append-only 持久化（Prisma/PostgreSQL）。
 *  · 判定 id 确定性派生 → 同一输入+同一 computedAt 幂等；重算（更晚 computedAt / 新 policyVersion）追加历史。
 *  · latest 由 computedAt DESC, id DESC 推导；UPDATE/DELETE 被 DB 触发器拒绝。
 */

import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import type { CustomerQualificationDecision } from './customer-qualification-gate';

export interface QualificationAssessmentWriteResult {
  status: 'APPENDED' | 'ALREADY_APPENDED';
  assessmentId: string;
}

export interface QualificationAssessmentStore {
  appendAssessment(input: {
    organizationId: string;
    algorithmVersion: string;
    inputDigest: string;
    decision: CustomerQualificationDecision;
    payload?: unknown;
  }): Promise<QualificationAssessmentWriteResult>;
  listAssessments(input: {
    organizationId: string;
    platformAccountId: string;
  }): Promise<readonly Record<string, unknown>[]>;
  loadLatestAssessment(input: {
    organizationId: string;
    platformAccountId: string;
  }): Promise<Record<string, unknown> | null>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

export function qualificationAssessmentId(input: {
  organizationId: string;
  platformAccountId: string;
  policyId: string;
  policyVersion: string;
  algorithmVersion: string;
  inputDigest: string;
  computedAt: string;
}): string {
  return createHash('sha256').update(canonical(input)).digest('hex').slice(0, 32);
}

export function createPrismaQualificationAssessmentStore(prisma: PrismaClient): QualificationAssessmentStore {
  return {
    async appendAssessment({ organizationId, algorithmVersion, inputDigest, decision, payload }) {
      if (decision.organizationId !== organizationId) {
        throw new Error('CROSS_TENANT_REJECTED: 判定与写入租户不一致');
      }
      const assessmentId = qualificationAssessmentId({
        organizationId,
        platformAccountId: decision.platformAccountId,
        policyId: decision.policyId,
        policyVersion: decision.policyVersion,
        algorithmVersion,
        inputDigest,
        computedAt: decision.computedAt,
      });
      const existing = await prisma.recoveryQualificationAssessmentRecord.findFirst({
        where: { id: assessmentId, organizationId },
      });
      if (existing) return { status: 'ALREADY_APPENDED', assessmentId };
      try {
        await prisma.recoveryQualificationAssessmentRecord.create({
          data: {
            id: assessmentId,
            organizationId,
            platformAccountId: decision.platformAccountId,
            policyId: decision.policyId,
            policyVersion: decision.policyVersion,
            algorithmVersion,
            inputDigest,
            resultDigest: createHash('sha256').update(canonical(decision)).digest('hex'),
            qualificationStatus: decision.qualificationStatus,
            currency: decision.currency,
            estimatedRecoveryAmount: decision.estimatedRecoveryAmount as never,
            estimatedExternalApiCost: decision.estimatedExternalApiCost as never,
            estimatedBrokerCost: decision.estimatedBrokerCost as never,
            expectedNetRecovery: decision.expectedNetRecovery as never,
            costRatio: (decision.costRatio ?? null) as never,
            payload: (payload ?? decision) as never,
            computedAt: new Date(decision.computedAt),
          },
        });
      } catch (error) {
        if ((error as { code?: string }).code !== 'P2002') throw error;
        return { status: 'ALREADY_APPENDED', assessmentId };
      }
      return { status: 'APPENDED', assessmentId };
    },

    async listAssessments({ organizationId, platformAccountId }) {
      const rows = await prisma.recoveryQualificationAssessmentRecord.findMany({
        where: { organizationId, platformAccountId },
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
      });
      return rows as unknown as Record<string, unknown>[];
    },

    async loadLatestAssessment({ organizationId, platformAccountId }) {
      const rows = await this.listAssessments({ organizationId, platformAccountId });
      return rows[0] ?? null;
    },
  };
}
