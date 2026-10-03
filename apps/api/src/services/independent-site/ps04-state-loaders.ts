/**
 * CHANGE E（MSG-20261003-142）— Independent-site runtime composition 的 Prisma 只读装载器。
 * 全部 tenant scoped；latest 由时间字段 + id 推导。
 */

import type { PrismaClient } from '@prisma/client';

import { createPrismaPs04Phase1ProjectionStore } from './ps04-phase1-projection-store';
import type { Ps04HandoffRow, Ps04ResponseRow, Ps04SettlementRow, Ps04StateReadDeps } from './ps04-state-read';

export function createPrismaPs04StateLoaders(prisma: PrismaClient): Ps04StateReadDeps {
  const phase1Store = createPrismaPs04Phase1ProjectionStore(prisma);
  return {
    async loadHandoff(organizationId: string, disputeReference: string) {
      const rows = await prisma.$queryRawUnsafe<
        { id: string; disputeReference: string; paymentAccountRef: string; channel: string; handoffReference: string; executionKey: string; observedAt: Date }[]
      >(
        'SELECT "id","disputeReference","paymentAccountRef","channel","handoffReference","executionKey","observedAt" FROM "IndependentSiteHandoffFact" WHERE "organizationId" = $1 AND "disputeReference" = $2',
        organizationId,
        disputeReference,
      );
      const row = rows[0];
      if (!row) return null;
      const mapped: Ps04HandoffRow = { ...row, observedAt: row.observedAt.toISOString() };
      return mapped;
    },
    async loadLatestResponse(organizationId: string, disputeReference: string) {
      const rows = await prisma.$queryRawUnsafe<
        { id: string; disputeReference: string; disposition: string; amount: string | null; currency: string; source: string; observedAt: Date }[]
      >(
        'SELECT "id","disputeReference","disposition","amount"::text AS amount,"currency","source","observedAt" FROM "IndependentSiteResponseFact" WHERE "organizationId" = $1 AND "disputeReference" = $2 ORDER BY "observedAt" DESC, "id" DESC LIMIT 1',
        organizationId,
        disputeReference,
      );
      const row = rows[0];
      if (!row) return null;
      const mapped: Ps04ResponseRow = { ...row, observedAt: row.observedAt.toISOString() };
      return mapped;
    },
    async loadLatestSettlement(organizationId: string, disputeReference: string) {
      const rows = await prisma.$queryRawUnsafe<
        { id: string; disputeReference: string; amount: string; currency: string; verification: string; reference: string; evidenceArtifactRef: string | null; receivedAt: Date }[]
      >(
        'SELECT "id","disputeReference","amount"::text AS amount,"currency","verification","reference","evidenceArtifactRef","receivedAt" FROM "IndependentSiteSettlementFact" WHERE "organizationId" = $1 AND "disputeReference" = $2 ORDER BY "receivedAt" DESC, "id" DESC LIMIT 1',
        organizationId,
        disputeReference,
      );
      const row = rows[0];
      if (!row) return null;
      const mapped: Ps04SettlementRow = { ...row, receivedAt: row.receivedAt.toISOString() };
      return mapped;
    },
    loadLatestPhase1Projection: (organizationId: string, disputeReference: string) =>
      phase1Store.loadLatestProjection({ organizationId, disputeReference }),
  };
}
