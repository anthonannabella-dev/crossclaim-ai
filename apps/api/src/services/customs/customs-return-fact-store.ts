/**
 * P0-1 — Return / Export / Destruction 事实的 append-only 持久化（Prisma/PostgreSQL）。
 *  · contentDigest 幂等：重复 ingest 收敛为同一份事实；digest 相同但 immutable payload 不同 → fail-closed。
 *  · 只追加；UPDATE/DELETE 由 DB 触发器拒绝；tenant / account lineage 由 DB + 应用双层保证。
 */

import type { PrismaClient } from '@prisma/client';

import { CustomsReturnMatchError, decimal6, type CustomsReturnFact } from './customs-return-matching';

export interface CustomsReturnFactWriteResult {
  status: 'RECORDED' | 'ALREADY_RECORDED';
  returnFactId: string;
  contentDigest: string;
}

export interface CustomsReturnFactStore {
  recordReturnFact(input: { organizationId: string; fact: CustomsReturnFact }): Promise<CustomsReturnFactWriteResult>;
  listReturnFactsForEntry(input: { organizationId: string; entryNumber: string }): Promise<readonly CustomsReturnFact[]>;
}

const P2002 = 'P2002';

function rowToFact(row: Record<string, unknown>): CustomsReturnFact {
  return {
    returnFactId: String(row.id),
    organizationId: String(row.organizationId),
    platformAccountId: String(row.platformAccountId),
    entryNumber: String(row.entryNumber),
    htsCode: String(row.htsCode),
    sku: (row.sku as string | null) ?? null,
    kind: String(row.kind) as CustomsReturnFact['kind'],
    quantity: (row.quantity as { toFixed: (digits: number) => string }).toFixed(6),
    currency: String(row.currency),
    jurisdiction: String(row.jurisdiction),
    importerOfRecordRef: String(row.importerOfRecordRef),
    source: String(row.source) as CustomsReturnFact['source'],
    rawReference: String(row.rawReference),
    observedAt: (row.observedAt as Date).toISOString(),
    contentDigest: String(row.contentDigest),
    readOnly: true,
    filingPerformed: false,
    paymentPerformed: false,
    productionCredentials: 'ABSENT',
  };
}

function sameImmutablePayload(row: Record<string, unknown>, fact: CustomsReturnFact): boolean {
  const stored = rowToFact(row);
  return (
    stored.organizationId === fact.organizationId &&
    stored.platformAccountId === fact.platformAccountId &&
    stored.entryNumber === fact.entryNumber &&
    stored.htsCode === fact.htsCode &&
    stored.sku === fact.sku &&
    stored.kind === fact.kind &&
    decimal6(stored.quantity) === decimal6(fact.quantity) &&
    stored.currency === fact.currency &&
    stored.jurisdiction === fact.jurisdiction &&
    stored.importerOfRecordRef === fact.importerOfRecordRef &&
    stored.source === fact.source &&
    stored.rawReference === fact.rawReference &&
    stored.observedAt === fact.observedAt
  );
}

export function createPrismaCustomsReturnFactStore(prisma: PrismaClient): CustomsReturnFactStore {
  async function findExisting(organizationId: string, contentDigest: string) {
    const row = await prisma.customsReturnFactRecord.findFirst({ where: { organizationId, contentDigest } });
    return (row as unknown as Record<string, unknown> | null) ?? null;
  }

  return {
    async recordReturnFact({ organizationId, fact }) {
      if (fact.organizationId !== organizationId) {
        throw new CustomsReturnMatchError('CROSS_TENANT_LINEAGE', '事实与写入租户不一致');
      }
      const existing = await findExisting(organizationId, fact.contentDigest);
      if (existing) {
        if (!sameImmutablePayload(existing, fact)) {
          throw new CustomsReturnMatchError('INVALID_REQUEST', 'contentDigest 相同但 immutable payload 不同（fail-closed）');
        }
        return { status: 'ALREADY_RECORDED', returnFactId: String(existing.id), contentDigest: fact.contentDigest };
      }
      try {
        await prisma.customsReturnFactRecord.create({
          data: {
            id: fact.returnFactId,
            organizationId: fact.organizationId,
            platformAccountId: fact.platformAccountId,
            entryNumber: fact.entryNumber,
            htsCode: fact.htsCode,
            sku: fact.sku,
            kind: fact.kind,
            quantity: decimal6(fact.quantity) as never,
            currency: fact.currency,
            jurisdiction: fact.jurisdiction,
            importerOfRecordRef: fact.importerOfRecordRef,
            source: fact.source,
            rawReference: fact.rawReference,
            observedAt: new Date(fact.observedAt),
            contentDigest: fact.contentDigest,
          },
        });
        return { status: 'RECORDED', returnFactId: fact.returnFactId, contentDigest: fact.contentDigest };
      } catch (error) {
        if ((error as { code?: string }).code !== P2002) throw error;
        const raced = await findExisting(organizationId, fact.contentDigest);
        if (!raced) throw error;
        if (!sameImmutablePayload(raced, fact)) {
          throw new CustomsReturnMatchError('INVALID_REQUEST', '并发写入后 payload 不一致（fail-closed）');
        }
        return { status: 'ALREADY_RECORDED', returnFactId: String(raced.id), contentDigest: fact.contentDigest };
      }
    },

    async listReturnFactsForEntry({ organizationId, entryNumber }) {
      const rows = await prisma.customsReturnFactRecord.findMany({
        where: { organizationId, entryNumber },
        orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
      });
      return (rows as unknown as Record<string, unknown>[]).map(rowToFact);
    },
  };
}
