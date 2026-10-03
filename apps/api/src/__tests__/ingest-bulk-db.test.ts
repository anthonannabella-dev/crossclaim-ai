/**
 * O6 — 数据库导入链路「1 万行」批量基准
 * ---------------------------------------------------------------
 * 已有覆盖：适配层 1 万行（validation-run-scenarios #11，纯内存、不落库）。
 * 本文件补的是**落库链路**：parse → normalize → validate → ImportBatch → SourceTransaction
 * （含 C-0006-A CanonicalFact 双写）。
 *
 * 验证目标不是性能优化，而是：
 *   - 不崩溃、不丢行（行数在批次记录与库内一致）
 *   - 可追溯（首/末行存在，raw 保留来源列原文）
 *   - 幂等（同一文件二次导入 0 新增，批次仍留痕）
 *   - 行级失败不中断整批（PARTIAL + 精确计数 + 行号）
 *
 * 规模选择：
 *   - 用例 1（主证据）= 10,000 行
 *   - 用例 2 / 3（幂等与部分失败语义）= 2,000 行，语义与行数无关，避免 CI 时间翻倍
 *
 * 实测（本地 PostgreSQL 16 容器，2026-09-29）：10,000 行落库 ≈ 59s。
 * 瓶颈是事实层逐条 upsert（每个事实 2 次往返），已登记为技术债 TD-8；
 * 本文件同时是「事务超时」缺陷的回归闸门（修复前 10,000 行必然
 * `Transaction already closed`）。
 *
 * 前置：DATABASE_URL 指向已执行 prisma migrate deploy 的 PostgreSQL。
 * CI 由 workflow env 注入；本地见 src/test-setup.ts。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPrismaImportRepository, runImport } from '../services/ingest';

const prisma = new PrismaClient();
const repository = createPrismaImportRepository(prisma);

const ORG_A = '11111111-1111-4111-8111-111111111111';
/** 主证据规模：1 万行 */
const BULK_ROWS = 10_000;
/** 语义类用例规模（幂等 / 部分失败），与行数无关 */
const SEMANTIC_ROWS = 2_000;
/** 宽松上限：本用例是「批量正确性 + 不崩溃」闸门，不是性能调优。 */
const ELAPSED_BUDGET_MS = 300_000;
const TEST_TIMEOUT_MS = 300_000;

const HEADER = 'Invoice No,Tracking Number,Invoice Date,Net Charge,Currency';

/** 生成 CSV；badDataRowNumber 是 1 基的数据行号（表头不计） */
function buildCsv(rowCount: number, badDataRowNumber = -1): string {
  const lines: string[] = [HEADER];
  for (let index = 0; index < rowCount; index += 1) {
    const seq = String(index).padStart(6, '0');
    const isBad = index + 1 === badDataRowNumber;
    lines.push(
      'INV-' + seq + ',1Z' + seq + ',2026-09-01,' + (isBad ? 'not-a-number' : '99.9900') + ',USD',
    );
  }
  return lines.join('\n');
}

const CONNECTION_BY_ORG = new Map<string, string>();

function context(organizationId: string) {
  const connectionId = CONNECTION_BY_ORG.get(organizationId);
  if (!connectionId) throw new Error('FIXTURE_CONNECTION_MISSING:' + organizationId);
  return { organizationId, connectionId, domain: 'LOGISTICS' as const, channel: 'UPS' as const };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "CanonicalFactSource", "CanonicalFact", "SourceTransaction", "ImportBatch", "FileAsset", "SourceConnection", "PlatformAccount", "AuditLog", "Organization" CASCADE;',
  );
  await prisma.organization.create({
    data: { id: ORG_A, name: '批量导入租户', slug: 'ingest-bulk-org' },
  });
  // TRACK B BATCH 1：批量 ingest 同样要求连接已绑定 PlatformAccount。
  const account = await prisma.platformAccount.create({
    data: {
      organizationId: ORG_A,
      platform: 'AMAZON',
      externalAccountId: 'fixture-' + ORG_A,
      displayName: 'fixture account',
    },
  });
  const connection = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG_A,
      domain: 'LOGISTICS',
      channel: 'UPS',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      label: 'bulk fixture',
      platformAccountId: account.id,
    },
  });
  CONNECTION_BY_ORG.set(ORG_A, connection.id);
});

describe('导入层 · 批量落库（真实数据库）', () => {
  it(
    '1 万行 CSV → 全部落库，批次 IMPORTED，行可追溯且事实层双写完成',
    async () => {
      const csv = buildCsv(BULK_ROWS);
      const startedAt = Date.now();
      const result = await runImport({ context: context(ORG_A), csvText: csv, repository });
      const elapsedMs = Date.now() - startedAt;

      expect(result.status).toBe('IMPORTED');
      expect(result.rowsTotal).toBe(BULK_ROWS);
      expect(result.rowsOk).toBe(BULK_ROWS);
      expect(result.rowsFailed).toBe(0);
      expect(result.duplicates).toBe(0);

      expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG_A } })).toBe(
        BULK_ROWS,
      );

      const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: result.batchId } });
      expect(batch.status).toBe('IMPORTED');
      expect(batch.rowsTotal).toBe(BULK_ROWS);
      expect(batch.rowsOk).toBe(BULK_ROWS);
      expect(batch.rowsFailed).toBe(0);
      expect(batch.finishedAt).not.toBeNull();

      // 可追溯：首行与末行都在，且 raw 保留了来源列原文
      const first = await prisma.sourceTransaction.findFirstOrThrow({
        where: { organizationId: ORG_A, externalId: 'INV-000000' },
      });
      const last = await prisma.sourceTransaction.findFirstOrThrow({
        where: { organizationId: ORG_A, externalId: 'INV-009999' },
      });
      expect(first.importBatchId).toBe(result.batchId);
      expect(last.importBatchId).toBe(result.batchId);
      expect(first.raw).toMatchObject({ 'Invoice No': 'INV-000000', 'Net Charge': '99.9900' });
      expect(last.raw).toMatchObject({ 'Invoice No': 'INV-009999' });

      // C-0006-A：事实层与原始行同一事务写入，不允许「有行无事实」
      expect(await prisma.canonicalFact.count({ where: { organizationId: ORG_A } })).toBe(
        BULK_ROWS,
      );

      expect(elapsedMs).toBeLessThan(ELAPSED_BUDGET_MS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '同一文件再次导入 → 0 新增（幂等），批次仍留痕',
    async () => {
      const csv = buildCsv(SEMANTIC_ROWS);
      const first = await runImport({ context: context(ORG_A), csvText: csv, repository });
      expect(first.rowsOk).toBe(SEMANTIC_ROWS);

      const second = await runImport({ context: context(ORG_A), csvText: csv, repository });
      expect(second.status).toBe('IMPORTED');
      expect(second.rowsOk).toBe(0);
      expect(second.duplicates).toBe(SEMANTIC_ROWS);
      expect(second.rowsFailed).toBe(0);

      expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG_A } })).toBe(
        SEMANTIC_ROWS,
      );
      // 两次导入各留一条批次记录（审计需要）
      expect(await prisma.importBatch.count({ where: { organizationId: ORG_A } })).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '批量第 1500 行非法 → PARTIAL，其余行入库、失败行号精确',
    async () => {
      const csv = buildCsv(SEMANTIC_ROWS, 1500);
      const result = await runImport({ context: context(ORG_A), csvText: csv, repository });

      expect(result.status).toBe('PARTIAL');
      expect(result.rowsTotal).toBe(SEMANTIC_ROWS);
      expect(result.rowsOk).toBe(SEMANTIC_ROWS - 1);
      expect(result.rowsFailed).toBe(1);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        row: 1500,
        field: 'amount',
        code: 'INVALID_AMOUNT',
      });

      expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG_A } })).toBe(
        SEMANTIC_ROWS - 1,
      );
      const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: result.batchId } });
      expect(batch.status).toBe('PARTIAL');
      expect(batch.rowsFailed).toBe(1);

      // 坏行不落库（不猜金额），坏行之后的好行不因坏行被丢弃
      expect(
        await prisma.sourceTransaction.findFirst({
          where: { organizationId: ORG_A, externalId: 'INV-001499' },
        }),
      ).toBeNull();
      expect(
        await prisma.sourceTransaction.findFirst({
          where: { organizationId: ORG_A, externalId: 'INV-001500' },
        }),
      ).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
