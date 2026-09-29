// MSG-20260929-37 验收（真实 PostgreSQL）：A5 只读队列的隔离、状态一致性、角标、
// 金额/阈值泄露扫描、只读证明与权限。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FORBIDDEN_AMOUNT_KEYS,
  getRecoveryReviewItem,
  listRecoveryReviewQueue,
} from '../services/operations/admin-recovery-review';

const prisma = new PrismaClient();
const ORG = 'bb000000-0000-4000-8000-000000000001';
const ORG_B = 'bb000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-29T10:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

let ownerId = '';
let pendingCaseId = '';
let approvedCaseId = '';
let foreignCaseId = '';
let noReviewCaseId = '';

function scanKeys(value: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if ((FORBIDDEN_AMOUNT_KEYS as readonly string[]).includes(key)) found.push(key);
      walk(child);
    }
  };
  walk(value);
  return found;
}

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
      { id: ORG, name: '复核租户', slug: 'admin-review-org' },
      { id: ORG_B, name: '外部租户', slug: 'admin-review-org-b' },
    ],
  });
  const owner = await prisma.user.create({
    data: { email: 'admin-review@example.com', displayName: '负责人', status: 'ACTIVE' },
  });
  ownerId = owner.id;
  await prisma.membership.createMany({
    data: [{ organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true }],
  });

  const makeCase = async (organizationId: string, caseNo: string) =>
    (
      await prisma.case.create({
        data: {
          organizationId,
          caseNo,
          title: caseNo,
          domain: 'LOGISTICS',
          status: 'WON',
          currency: 'USD',
        },
      })
    ).id;

  pendingCaseId = await makeCase(ORG, 'CASE-RR-PENDING');
  approvedCaseId = await makeCase(ORG, 'CASE-RR-APPROVED');
  noReviewCaseId = await makeCase(ORG, 'CASE-RR-NONE');
  foreignCaseId = await makeCase(ORG_B, 'CASE-RR-FOREIGN');

  const audit = (entityId: string, action: string, createdAt: Date) =>
    prisma.auditLog.create({
      data: {
        organizationId: ORG,
        actorType: 'USER',
        actorUserId: ownerId,
        action,
        entityType: 'Case',
        entityId,
        createdAt,
      },
    });

  await audit(pendingCaseId, 'recovery.review_required', daysAgo(8));
  await audit(approvedCaseId, 'recovery.review_required', daysAgo(3));
  await audit(approvedCaseId, 'recovery.review_approved', daysAgo(2));
  await prisma.auditLog.create({
    data: {
      organizationId: ORG_B,
      actorType: 'SYSTEM',
      actorRef: 'foreign',
      action: 'recovery.review_required',
      entityType: 'Case',
      entityId: foreignCaseId,
      createdAt: daysAgo(1),
    },
  });
});

const deps = { prisma, now: () => NOW };
const base = () => ({ organizationId: ORG, role: 'OWNER' }) as const;

describe('MSG-37 · A5 恢复复核队列（真实 PostgreSQL）', () => {
  it('01 租户隔离：A 队列不含 B 的案件', async () => {
    const list = await listRecoveryReviewQueue(deps, { ...base() });
    const ids = list.items.map((row) => row.caseId);
    expect(ids).toContain(pendingCaseId);
    expect(ids).not.toContain(foreignCaseId);
    await expect(getRecoveryReviewItem(deps, { ...base(), caseId: foreignCaseId })).rejects.toThrowError(/不存在/);
  });

  it('02 状态严格来自既有审计：approved 覆盖 required；无审核记录不入队', async () => {
    const list = await listRecoveryReviewQueue(deps, { ...base() });
    expect(list.items.find((row) => row.caseId === pendingCaseId)?.bucket).toBe('pending_review');
    expect(list.items.find((row) => row.caseId === approvedCaseId)?.bucket).toBe('approved');
    expect(list.items.map((row) => row.caseId)).not.toContain(noReviewCaseId);
    await expect(getRecoveryReviewItem(deps, { ...base(), caseId: noReviewCaseId })).rejects.toThrowError(/没有既有审核记录/);
  });

  it('03 角标：待审 + HIGH_VALUE_REVIEW_REQUIRED；8 天前 → AGED；无证据 → MISSING_EVIDENCE_REF', async () => {
    const item = await getRecoveryReviewItem(deps, { ...base(), caseId: pendingCaseId });
    expect(item.flags).toEqual(
      expect.arrayContaining(['HIGH_VALUE_REVIEW_REQUIRED', 'AGED', 'MISSING_EVIDENCE_REF']),
    );
    // 已通过案件不再带待审角标
    const approved = await getRecoveryReviewItem(deps, { ...base(), caseId: approvedCaseId });
    expect(approved.flags).not.toContain('HIGH_VALUE_REVIEW_REQUIRED');
    expect(approved.decidedAt).not.toBeNull();
  });

  it('04 金额/阈值泄露扫描：响应中不存在任何禁用金额键', async () => {
    const list = await listRecoveryReviewQueue(deps, { ...base() });
    expect(scanKeys(list)).toEqual([]);
    expect(JSON.stringify(list)).not.toContain('threshold');
    expect(JSON.stringify(list)).not.toContain('1000');
    const item = await getRecoveryReviewItem(deps, { ...base(), caseId: pendingCaseId });
    expect(scanKeys(item)).toEqual([]);
  });

  it('05 证据仅元数据引用（evidenceId/kind/role/capturedAt），深链指向既有审核流程', async () => {
    const evidence = await prisma.evidenceArtifact.create({
      data: { organizationId: ORG, kind: 'POD', title: 'POD 证据', capturedAt: daysAgo(9) },
    });
    await prisma.caseEvidence.create({
      data: { organizationId: ORG, caseId: pendingCaseId, evidenceId: evidence.id, role: 'POD' },
    });
    const item = await getRecoveryReviewItem(deps, { ...base(), caseId: pendingCaseId });
    expect(item.evidenceRefs[0]).toEqual({
      evidenceId: evidence.id,
      kind: 'POD',
      role: 'POD',
      capturedAt: daysAgo(9).toISOString(),
    });
    expect(JSON.stringify(item.evidenceRefs)).not.toContain('storageKey');
    expect(item.reviewPath).toBe(`/cases/${pendingCaseId}/recovery-review`);
  });

  it('06 只读证明 + 权限：读取前后快照一致；OPS/FINANCE/VIEWER 被拒', async () => {
    const snapshot = async () => ({
      cases: await prisma.case.count(),
      audits: await prisma.auditLog.count(),
      caseEvidence: await prisma.caseEvidence.count(),
    });
    const before = await snapshot();
    await listRecoveryReviewQueue(deps, { ...base() });
    await getRecoveryReviewItem(deps, { ...base(), caseId: pendingCaseId });
    expect(await snapshot()).toEqual(before);

    for (const role of ['OPS', 'FINANCE', 'VIEWER']) {
      await expect(listRecoveryReviewQueue(deps, { organizationId: ORG, role })).rejects.toThrowError(/无权/);
    }
  });
});
