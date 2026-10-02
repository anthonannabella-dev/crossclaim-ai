/**
 * Prisma projection for cross-source reconciliation (C-0005 / Gate 3).
 * Read-only, tenant-scoped; amounts are compared as Decimal(18,4) strings.
 */

import type { Channel, PrismaClient, RecoveryDomain } from '@prisma/client';

import type { FactSourceTransaction } from './reconcile';

export interface ReconcileScope {
  organizationId: string;
  domain?: RecoveryDomain;
  channel?: Channel;
}

export interface ReconciliationRepository {
  load(scope: ReconcileScope): Promise<FactSourceTransaction[]>;
}

export function createPrismaReconciliationRepository(
  prisma: PrismaClient,
): ReconciliationRepository {
  return {
    async load(scope: ReconcileScope): Promise<FactSourceTransaction[]> {
      const rows = await prisma.sourceTransaction.findMany({
        where: {
          organizationId: scope.organizationId,
          ...(scope.domain ? { domain: scope.domain } : {}),
          ...(scope.channel ? { channel: scope.channel } : {}),
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          connectionId: true,
          accountId: true,
          referenceType: true,
          externalId: true,
          occurredAt: true,
          amount: true,
          currency: true,
          connection: { select: { kind: true, platformAccountId: true } },
        },
      });

      return rows.map((row) => ({
        id: row.id,
        connectionId: row.connectionId,
        connectionKind: row.connection?.kind ?? null,
        accountId: row.accountId ?? row.connection?.platformAccountId ?? null,
        referenceType: row.referenceType,
        externalId: row.externalId,
        occurredAt: row.occurredAt,
        amount: row.amount === null ? null : row.amount.toFixed(4),
        currency: row.currency,
      }));
    },
  };
}
