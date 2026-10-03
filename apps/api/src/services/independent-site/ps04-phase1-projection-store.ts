/**
 * CHANGE B（MSG-20261003-141）— Independent-site Phase 1 结果的**只读投影**持久化。
 * ---------------------------------------------------------------
 * append-only + 幂等（UNIQUE(organizationId, disputeReference, resultDigest)）；
 * latest 由 computedAt DESC, id DESC 推导；不允许 mutable isLatest。
 * 只读语义由 DB CHECK 强制：externalWritePerformed=false / autoSubmitAllowed=false。
 */

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export interface Ps04Phase1ProjectionInput {
  organizationId: string;
  disputeReference: string;
  policyId: string;
  policyVersion: string;
  algorithmVersion: string;
  qualificationStatus: 'QUALIFIED' | 'CONDITIONAL' | 'NOT_QUALIFIED' | 'INDETERMINATE';
  qualificationReasonCodes: readonly string[];
  evidenceReadinessStatus: 'READY' | 'NOT_READY' | 'INDETERMINATE';
  evidenceSummary: Record<string, unknown>;
  claimReadyStatus: 'READY' | 'NOT_READY' | 'INDETERMINATE';
  packageId?: string | null;
  packageDigest?: string | null;
  computedAt: Date;
}

export interface Ps04Phase1ProjectionWriteResult {
  status: 'APPENDED' | 'ALREADY_APPENDED';
  projectionId: string;
}

export interface Ps04Phase1ProjectionStore {
  appendProjection(input: Ps04Phase1ProjectionInput): Promise<Ps04Phase1ProjectionWriteResult>;
  listProjections(input: { organizationId: string; disputeReference: string }): Promise<readonly Record<string, unknown>[]>;
  loadLatestProjection(input: { organizationId: string; disputeReference: string }): Promise<Record<string, unknown> | null>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

export function ps04Phase1ResultDigest(input: Omit<Ps04Phase1ProjectionInput, 'computedAt'>): string {
  return createHash('sha256')
    .update(
      canonical({
        disputeReference: input.disputeReference,
        policyId: input.policyId,
        policyVersion: input.policyVersion,
        algorithmVersion: input.algorithmVersion,
        qualificationStatus: input.qualificationStatus,
        qualificationReasonCodes: [...input.qualificationReasonCodes],
        evidenceReadinessStatus: input.evidenceReadinessStatus,
        evidenceSummary: input.evidenceSummary,
        claimReadyStatus: input.claimReadyStatus,
        packageId: input.packageId ?? null,
        packageDigest: input.packageDigest ?? null,
      }),
    )
    .digest('hex');
}

export function ps04Phase1ProjectionId(organizationId: string, disputeReference: string, resultDigest: string): string {
  return 'ps04p1_' + createHash('sha256').update(organizationId + '|' + disputeReference + '|' + resultDigest).digest('hex').slice(0, 32);
}

export function createPrismaPs04Phase1ProjectionStore(prisma: PrismaClient): Ps04Phase1ProjectionStore {
  return {
    async appendProjection(input) {
      const resultDigest = ps04Phase1ResultDigest(input);
      const id = ps04Phase1ProjectionId(input.organizationId, input.disputeReference, resultDigest);
      const existing = await prisma.independentSitePhase1Projection.findUnique({ where: { id } });
      if (existing) return { status: 'ALREADY_APPENDED', projectionId: id };
      await prisma.independentSitePhase1Projection.create({
        data: {
          id,
          organizationId: input.organizationId,
          disputeReference: input.disputeReference,
          policyId: input.policyId,
          policyVersion: input.policyVersion,
          algorithmVersion: input.algorithmVersion,
          qualificationStatus: input.qualificationStatus,
          qualificationReasonCodes: [...input.qualificationReasonCodes],
          evidenceReadinessStatus: input.evidenceReadinessStatus,
          evidenceSummary: input.evidenceSummary as never,
          claimReadyStatus: input.claimReadyStatus,
          packageId: input.packageId ?? null,
          packageDigest: input.packageDigest ?? null,
          externalWritePerformed: false,
          autoSubmitAllowed: false,
          resultDigest,
          computedAt: input.computedAt,
        },
      });
      return { status: 'APPENDED', projectionId: id };
    },
    async listProjections({ organizationId, disputeReference }) {
      const rows = await prisma.independentSitePhase1Projection.findMany({
        where: { organizationId, disputeReference },
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
      });
      return rows as unknown as Record<string, unknown>[];
    },
    async loadLatestProjection(args) {
      const rows = await this.listProjections(args);
      return rows[0] ?? null;
    },
  };
}

export const PS04_PHASE1_PROJECTION_BOUNDARY = {
  appendOnly: true,
  idempotentByResultDigest: true,
  externalWritePerformed: false,
  autoSubmitAllowed: false,
  latestDerivedNotMaterialised: true,
  productionCredentials: 'ABSENT',
} as const;
