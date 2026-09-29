// MSG-20260929-34 验收（真实 PostgreSQL）：Admin Phase 1 的租户隔离、元数据-only 列表、
// 详情端点、只读快照一致、凭据零暴露。

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  getAuditEntry,
  getTenantOverview,
  listAuditEntries,
} from '../services/operations/admin-console';

const prisma = new PrismaClient();
const ORG = 'b9000000-0000-4000-8000-000000000001';
const ORG_B = 'b9000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-29T10:00:00Z');

let ownerId = '';
let foreignAuditId = '';
let ownAuditId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RecoveryPayout", "ClaimItemEvidence", "ClaimItem", "PaymentProcessingAttempt", "Payment", "PaymentEvent", "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: 'Admin 租户', slug: 'admin-org' },
      { id: ORG_B, name: '外部租户', slug: 'admin-org-b' },
    ],
  });
  const owner = await prisma.user.create({
    data: { email: 'admin-owner@example.com', displayName: '负责人', status: 'ACTIVE' },
  });
  ownerId = owner.id;
  await prisma.membership.createMany({
    data: [{ organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true }],
  });

  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'CASE-ADMIN-1',
      title: 'Admin 用例案件',
      domain: 'LOGISTICS',
      status: 'CLAIMED',
      currency: 'USD',
    },
  });
  await prisma.claim.create({
    data: { organizationId: ORG, caseId: kase.id, round: 1, status: 'SUBMITTED', target: 'PLATFORM' },
  });
  const settlement = await prisma.settlement.create({
    data: {
      organizationId: ORG,
      caseId: kase.id,
      status: 'RECEIVED',
      source: 'OTHER',
      amount: new Prisma.Decimal('100.0000'),
      currency: 'USD',
    },
  });
  expect(settlement.id).toBeTruthy();

  const own = await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      // 固定时间戳：避免 DB 实时时钟漂移到检索窗口之外（用例必须确定性）
      createdAt: new Date('2026-09-29T09:00:00Z'),
      action: 'case.created',
      entityType: 'Case',
      entityId: kase.id,
      changes: { caseNo: 'CASE-ADMIN-1', source: 'admin-test' },
    },
  });
  ownAuditId = own.id;

  // cc_audit_actor_shape_check：actorType=USER 要求该用户是**本租户成员**
  const foreignUser = await prisma.user.create({
    data: { email: 'admin-foreign@example.com', displayName: '外部用户', status: 'ACTIVE' },
  });
  await prisma.membership.create({
    data: { organizationId: ORG_B, userId: foreignUser.id, role: 'OWNER', isActive: true },
  });
  const foreign = await prisma.auditLog.create({
    data: {
      organizationId: ORG_B,
      actorType: 'USER',
      actorUserId: foreignUser.id,
      createdAt: new Date('2026-09-29T09:00:00Z'),
      action: 'case.created',
      entityType: 'Case',
      entityId: 'foreign-case',
      changes: { secretMarker: 'FOREIGN_MARKER' },
    },
  });
  foreignAuditId = foreign.id;
});

const deps = { prisma, now: () => NOW };
const base = () => ({ organizationId: ORG, role: 'OWNER' }) as const;

describe('MSG-34 · Admin Console Phase 1（真实 PostgreSQL）', () => {
  it('01 租户隔离：审计列表不含 B 的行；B 的实体也不出现在 A 的窗口内', async () => {
    const list = await listAuditEntries(deps, { ...base() });
    expect(list.items.map((row) => row.id)).toContain(ownAuditId);
    expect(list.items.map((row) => row.id)).not.toContain(foreignAuditId);
    expect(JSON.stringify(list)).not.toContain('FOREIGN_MARKER');
  });

  it('02 actorUserId 过滤也受租户约束（不跨租户）', async () => {
    const list = await listAuditEntries(deps, {
      ...base(),
      filter: { actorUserId: ownerId },
    });
    expect(list.items.length).toBe(1);
    expect(list.items[0]?.id).toBe(ownAuditId);
  });

  it('03 列表只返回元数据：不含 changes（D3）', async () => {
    const list = await listAuditEntries(deps, { ...base() });
    for (const item of list.items) expect(item).not.toHaveProperty('changes');
  });

  it('04 详情端点返回 changes；跨租户记录 → NOT_FOUND', async () => {
    const detail = await getAuditEntry(deps, { ...base(), auditId: ownAuditId });
    expect(detail.changes).toMatchObject({ caseNo: 'CASE-ADMIN-1' });

    await expect(getAuditEntry(deps, { ...base(), auditId: foreignAuditId })).rejects.toThrowError(/不存在/);
  });

  it('05 租户概览：只露状态与计数，不含凭据字段', async () => {
    const overview = await getTenantOverview(deps, { ...base() });
    expect(overview.members.total).toBe(1);
    expect(overview.claims.some((row) => row.status === 'SUBMITTED')).toBe(true);
    expect(overview.settlements.total).toBe(1);
    const text = JSON.stringify(overview);
    for (const forbidden of ['storageKey', 'secret', 'password', 'token', 'credential']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('06 只读证明：三个模块读取前后关键表快照一致', async () => {
    const snapshot = async () => ({
      organizations: await prisma.organization.count(),
      memberships: await prisma.membership.count(),
      audits: await prisma.auditLog.count(),
      claims: await prisma.claim.count(),
      settlements: await prisma.settlement.count(),
    });
    const before = await snapshot();
    await getTenantOverview(deps, { ...base() });
    await listAuditEntries(deps, { ...base() });
    await getAuditEntry(deps, { ...base(), auditId: ownAuditId });
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  it('07 OPS 只能访问 System Health；FINANCE/VIEWER 一律拒绝', async () => {
    await expect(getTenantOverview(deps, { organizationId: ORG, role: 'OPS' })).rejects.toThrowError(/无权/);
    await expect(listAuditEntries(deps, { organizationId: ORG, role: 'OPS' })).rejects.toThrowError(/无权/);
    for (const role of ['FINANCE', 'VIEWER']) {
      await expect(getTenantOverview(deps, { organizationId: ORG, role })).rejects.toThrowError(/无权/);
    }
  });

  it('08 审计窗口超限 → INVALID_WINDOW', async () => {
    await expect(
      listAuditEntries(deps, {
        ...base(),
        filter: { from: '2026-01-01T00:00:00Z', to: NOW.toISOString() },
      }),
    ).rejects.toThrowError(/不得超过/);
  });
});
