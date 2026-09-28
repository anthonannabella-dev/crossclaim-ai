/**
 * Wave 1 · 导入层**数据库级**测试（Gate 1 · Checkpoint 2）
 * ---------------------------------------------------------------
 * 只有真实 PostgreSQL 能证明：
 *   - 导入真的落 ImportBatch + SourceTransaction，且 raw 原样保留
 *   - 重复导入被 @@unique([organizationId, dedupeKey]) 挡住（幂等）
 *   - 不同租户可以有相同 dedupeKey（租户隔离正确）
 *   - 行级失败落成 PARTIAL 且 errorReport 入库
 *
 * 前置：DATABASE_URL 指向已执行 `prisma migrate deploy` 的 PostgreSQL（CI 已具备）。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assertSafeSource, withSourceEvidence } from '../services/adapters';
import { createPrismaImportRepository, runImport, runImportRows } from '../services/ingest';

const prisma = new PrismaClient();
const repository = createPrismaImportRepository(prisma);

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const CSV = [
  'Invoice No,Tracking Number,Invoice Date,Net Charge,Currency',
  'INV-1,1Z999,2026-09-01,100.50,USD',
  'INV-2,1Z888,2026-09-02,200.00,USD',
].join('\n');

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "SourceTransaction", "ImportBatch", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG_A, name: '导入租户 A', slug: 'ingest-org-a' },
      { id: ORG_B, name: '导入租户 B', slug: 'ingest-org-b' },
    ],
  });
});

function context(organizationId: string) {
  return { organizationId, domain: 'LOGISTICS' as const, channel: 'UPS' as const };
}

describe('导入层 · 真实数据库', () => {
  it('导入写入 ImportBatch + 2 条 SourceTransaction，raw 原样保留', async () => {
    const result = await runImport({ context: context(ORG_A), csvText: CSV, repository });

    expect(result.status).toBe('IMPORTED');
    expect(result.rowsOk).toBe(2);

    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: result.batchId } });
    expect(batch.status).toBe('IMPORTED');
    expect(batch.rowsTotal).toBe(2);
    expect(batch.rowsOk).toBe(2);
    expect(batch.rowsFailed).toBe(0);
    expect(batch.columnMapping).toMatchObject({ amount: 'Net Charge' });

    const rows = await prisma.sourceTransaction.findMany({
      where: { organizationId: ORG_A },
      orderBy: { externalId: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].raw).toMatchObject({ 'Invoice No': 'INV-1', 'Net Charge': '100.50' });
    expect(rows[0].amount?.toString()).toBe('100.5');
    expect(rows[0].currency).toBe('USD');
    expect(rows[0].importBatchId).toBe(result.batchId);
    expect(rows[0].occurredAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('重复导入同一文件：不新增交易，第二次全部计为重复', async () => {
    const first = await runImport({ context: context(ORG_A), csvText: CSV, repository });
    expect(first.rowsOk).toBe(2);

    const second = await runImport({ context: context(ORG_A), csvText: CSV, repository });
    expect(second.duplicates).toBe(2);
    expect(second.rowsOk).toBe(0);

    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG_A } })).toBe(2);
    // 第二次导入仍留批次痕迹（审计需要）
    expect(await prisma.importBatch.count({ where: { organizationId: ORG_A } })).toBe(2);
  });

  it('不同租户可以使用相同 dedupeKey（租户隔离正确）', async () => {
    await runImport({ context: context(ORG_A), csvText: CSV, repository });
    const b = await runImport({ context: context(ORG_B), csvText: CSV, repository });

    expect(b.rowsOk).toBe(2);
    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG_B } })).toBe(2);
  });

  it('行级失败 → 批次 PARTIAL，好行入库、errorReport 落库', async () => {
    const mixed = [
      'Invoice No,Invoice Date,Net Charge,Currency',
      'INV-1,2026-09-01,100.50,USD',
      'INV-2,2026-09-02,not-a-number,USD',
    ].join('\n');

    const result = await runImport({ context: context(ORG_A), csvText: mixed, repository });
    expect(result.status).toBe('PARTIAL');
    expect(result.rowsOk).toBe(1);
    expect(result.rowsFailed).toBe(1);

    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: result.batchId } });
    expect(batch.status).toBe('PARTIAL');
    const report = batch.errorReport as { issues: Array<{ row: number; code: string }> };
    expect(report.issues[0]).toMatchObject({ row: 2, code: 'INVALID_AMOUNT' });

    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG_A } })).toBe(1);
  });

  // CHANGE #33 / #38：guard 通过的 source 必须能被真实 Prisma 原样保存并回读（不只内存仓库）
  it('guard 通过的 JSON-safe source → 真实 SourceTransaction.raw 落库并原样回读', async () => {
    const source = {
      shipmentId: 'SHIP-1',
      platformFee: '3.20',
      nested: { flags: [true, false, null], note: '平台附加费' },
    };
    expect(() => assertSafeSource(source, { platform: 'ups-test', rowNumber: 1 })).not.toThrow();

    const result = await runImportRows({
      context: context(ORG_A),
      header: ['externalId', 'referenceType', 'occurredAt', 'amount', 'currency'],
      rows: [
        {
          externalId: 'DB-1',
          referenceType: 'INVOICE',
          occurredAt: '2026-09-28',
          amount: '12.34',
          currency: 'USD',
        },
      ],
      mapping: {
        externalId: 'externalId',
        referenceType: 'referenceType',
        occurredAt: 'occurredAt',
        amount: 'amount',
        currency: 'currency',
      },
      repository,
      rawProjection: (row) => withSourceEvidence(row, source),
    });

    expect(result.status).toBe('IMPORTED');
    const stored = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG_A, externalId: 'DB-1' },
    });
    expect(stored.raw).toMatchObject({ externalId: 'DB-1', amount: '12.34' });
    expect((stored.raw as { _source: unknown })._source).toEqual(source);
  });
});
