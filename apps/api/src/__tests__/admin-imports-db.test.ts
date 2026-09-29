// MSG-20260929-36 验收（真实 PostgreSQL）：A4 查询隔离、状态映射 + 重试角标、
// 错误白名单无泄露、Quality Summary 标注 projection、只读快照。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  containsForbiddenKey,
  getImportBatch,
  getImportQualitySummary,
  listImportBatches,
  listImportErrors,
} from '../services/operations/admin-imports';

const prisma = new PrismaClient();
const ORG = 'ba000000-0000-4000-8000-000000000001';
const ORG_B = 'ba000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-29T09:00:00Z');

let ownerId = '';
let batchId = '';
let retriedBatchId = '';
let foreignBatchId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RecoveryPayout", "ClaimItemEvidence", "ClaimItem", "PaymentProcessingAttempt", "Payment", "PaymentEvent", "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "SourceTransaction", "ImportBatch", "FileAsset", "SourceConnection", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '导入租户', slug: 'import-admin-org' },
      { id: ORG_B, name: '外部租户', slug: 'import-admin-org-b' },
    ],
  });
  const owner = await prisma.user.create({
    data: { email: 'import-admin@example.com', displayName: '运营', status: 'ACTIVE' },
  });
  ownerId = owner.id;
  await prisma.membership.createMany({
    data: [{ organizationId: ORG, userId: owner.id, role: 'OPS', isActive: true }],
  });

  const partial = await prisma.importBatch.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      status: 'PARTIAL',
      rowsTotal: 10,
      rowsOk: 8,
      rowsFailed: 2,
      startedAt: NOW,
      errorReport: [
        {
          errorCode: 'MISSING_FIELD',
          rowNumber: 3,
          field: 'trackingNo',
          sourceColumnName: 'Tracking Number(s)',
          action: 'SKIPPED',
          rawRow: { trackingNo: '1Z999', customerName: 'SECRET_CUSTOMER' },
        },
      ],
    },
  });
  batchId = partial.id;

  const retried = await prisma.importBatch.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      status: 'IMPORTED',
      rowsTotal: 5,
      rowsOk: 5,
      rowsFailed: 0,
      startedAt: NOW,
    },
  });
  retriedBatchId = retried.id;
  await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      createdAt: NOW,
      action: 'import.retry_completed',
      entityType: 'ImportBatch',
      entityId: retried.id,
      changes: { rows: 5 },
    },
  });

  const foreign = await prisma.importBatch.create({
    data: {
      organizationId: ORG_B,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      status: 'FAILED',
      rowsTotal: 1,
      rowsOk: 0,
      rowsFailed: 1,
      startedAt: NOW,
      errorReport: [{ errorCode: 'FOREIGN_MARKER', rowNumber: 1 }],
    },
  });
  foreignBatchId = foreign.id;
});

const deps = { prisma, now: () => NOW };
const base = () => ({ organizationId: ORG, role: 'OPS' }) as const;

describe('MSG-36 · Admin Import/Validation（真实 PostgreSQL）', () => {
  it('01 查询隔离：A 看不到 B 的批次与错误', async () => {
    const list = await listImportBatches(deps, { ...base() });
    expect(list.items.map((row) => row.batchId)).toContain(batchId);
    expect(list.items.map((row) => row.batchId)).not.toContain(foreignBatchId);
    await expect(getImportBatch(deps, { ...base(), batchId: foreignBatchId })).rejects.toThrowError(/不存在/);
  });

  it('02 状态映射 + 重试角标：PARTIAL → partial + QUALITY_WARNING；IMPORTED+retry → retried_success + RETRIED', async () => {
    const list = await listImportBatches(deps, { ...base() });
    const partial = list.items.find((row) => row.batchId === batchId);
    expect(partial?.bucket).toBe('partial');
    expect(partial?.flags).toContain('QUALITY_WARNING');

    const retried = list.items.find((row) => row.batchId === retriedBatchId);
    expect(retried?.bucket).toBe('retried_success');
    expect(retried?.flags).toContain('RETRIED');
  });

  it('03 桶过滤：bucket=partial 只返回部分成功', async () => {
    const list = await listImportBatches(deps, { ...base(), filter: { bucket: 'partial' } });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.batchId).toBe(batchId);
  });

  it('04 L3 白名单：只返回原因码/行号/字段名，且无客户数据与金额键', async () => {
    const errors = await listImportErrors(deps, { ...base(), batchId });
    expect(errors.items).toHaveLength(1);
    expect(errors.items[0]).toEqual({
      errorCode: 'MISSING_FIELD',
      rowNumber: 3,
      field: 'trackingNo',
      sourceColumnName: 'Tracking Number(s)',
      action: 'SKIPPED',
    });
    const text = JSON.stringify(errors);
    expect(text).not.toContain('SECRET_CUSTOMER');
    expect(text).not.toContain('1Z999');
    expect(containsForbiddenKey(errors)).toBeNull();
  });

  it('05 批次详情：无金额键，时间线取自既有审计动作', async () => {
    const detail = await getImportBatch(deps, { ...base(), batchId: retriedBatchId });
    expect(detail.bucket).toBe('retried_success');
    expect(detail.timeline.some((event) => event.action === 'import.retry_completed')).toBe(true);
    expect(containsForbiddenKey(detail)).toBeNull();
  });

  it('06 Quality Summary 标注 projection，且计数与桶一致', async () => {
    const summary = await getImportQualitySummary(deps, { ...base() });
    expect(summary.projection).toBe(true);
    const partial = summary.buckets.find((row) => row.bucket === 'partial');
    expect(partial?.count).toBe(1);
    expect(partial?.flagCount).toBe(1);
    expect(containsForbiddenKey(summary)).toBeNull();
  });

  it('07 只读证明：读取前后关键表计数一致', async () => {
    const snapshot = async () => ({
      batches: await prisma.importBatch.count(),
      transactions: await prisma.sourceTransaction.count(),
      audits: await prisma.auditLog.count(),
    });
    const before = await snapshot();
    await listImportBatches(deps, { ...base() });
    await getImportBatch(deps, { ...base(), batchId });
    await listImportErrors(deps, { ...base(), batchId });
    await getImportQualitySummary(deps, { ...base() });
    expect(await snapshot()).toEqual(before);
  });

  it('08 FINANCE / VIEWER 无权访问 Import 视图', async () => {
    for (const role of ['FINANCE', 'VIEWER']) {
      await expect(listImportBatches(deps, { organizationId: ORG, role })).rejects.toThrowError(/无权/);
    }
  });
});
