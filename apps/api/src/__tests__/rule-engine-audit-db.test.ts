/**
 * C-0012 — Rule Engine Audit（真实 PostgreSQL）：只读性、复核写入与不变量。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildRuleEngineAudit,
  recordRecoverableAmountReview,
} from '../services/audit/rule-engine-audit';
import { createClaimItem } from '../services/claim/claim-items';
import { ForbiddenError } from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'b5000000-0000-4000-8000-000000000001';
let B2_CONNECTION_ID = '';
const NOW = new Date('2026-09-28T18:00:00Z');

let ownerId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ClaimItemEvidence", "ClaimItem", "PaymentProcessingAttempt", "Payment", "PaymentEvent", "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "SourceConnection", "PlatformAccount", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '审计租户', slug: 'audit-org' } });
  // TRACK B BATCH 2：连接器/内部调用方必须提供可信连接上下文（同租户 + 已绑定 PlatformAccount）。
  const b2Account = await prisma.platformAccount.create({
    data: {
      organizationId: ORG,
      platform: 'AMAZON',
      externalAccountId: 'fixture-' + ORG,
      displayName: 'fixture account',
    },
  });
  const b2Connection = await prisma.sourceConnection.create({
    data: {
      id: undefined,
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'API',
      status: 'ACTIVE',
      label: 'audit fixture',
      platformAccountId: b2Account.id,
    },
  });
  B2_CONNECTION_ID = b2Connection.id;
  const owner = await prisma.user.create({
    data: { email: 'audit-owner@example.com', displayName: '负责人', status: 'ACTIVE' },
  });
  ownerId = owner.id;
  await prisma.membership.createMany({
    data: [{ organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true }],
  });
});

const base = () =>
  ({ organizationId: ORG, actorUserId: ownerId, role: 'OWNER', trustedConnectionId: B2_CONNECTION_ID }) as const;

async function seedClaim(claimType: string, amount: string, occurredAt = NOW) {
  const created = await createClaimItem(
    prisma,
    {
      ...base(),
      platformType: 'AMAZON',
      claimType,
      platformRef: `ref-${claimType}-${amount}`,
      occurredAt,
      recoverableAmount: amount,
      normalizerVersion: 'normalizer-1.0.0',
    },
    { now: () => NOW },
  );
  return created.id;
}

describe('C-0012 — 审计聚合（真实 PostgreSQL）', () => {
  it('覆盖率 / 残差分类 / 漂移 / 新鲜度可复算，且三层状态正确', async () => {
    const confirmed = await seedClaim('FBA_LOSS', '100.0000', new Date('2026-09-01T00:00:00Z'));
    const adjusted = await seedClaim('FBA_LOSS', '200.0000', new Date('2026-09-02T00:00:00Z'));
    await seedClaim('OTIF_PENALTY', '300.0000');
    await createClaimItem(
      prisma,
      {
        ...base(),
        platformType: 'WALMART',
        claimType: 'WAREHOUSE_LOSS',
        platformRef: 'ref-no-amount',
        occurredAt: NOW,
        normalizerVersion: 'normalizer-1.0.0',
      },
      { now: () => NOW },
    );

    await recordRecoverableAmountReview(
      prisma,
      { ...base(), claimItemId: confirmed, ruleAmount: '100.0000', decision: 'CONFIRMED' },
      { now: () => NOW },
    );
    await recordRecoverableAmountReview(
      prisma,
      {
        ...base(),
        claimItemId: adjusted,
        ruleAmount: '200.0000',
        toAmount: '150.0000',
        decision: 'ADJUSTED',
        reason: '承运商只认一半',
      },
      { now: () => NOW },
    );

    const audit = await buildRuleEngineAudit(prisma, { organizationId: ORG, role: 'OWNER', now: () => NOW });
    expect(audit.coverage).toEqual({ claimItems: 4, withRecoverableAmount: 3, coverageRate: 0.75 });
    expect(audit.residuals.classification).toEqual({ NO_HUMAN_REVIEW: 1, CONFIRMED: 1, ADJUSTED: 1 });
    expect(audit.residuals.adjusted).toMatchObject({ count: 1, median: -50, p90Abs: 50, absSum: 50 });
    expect(audit.drift.changedPairs).toHaveLength(1);
    expect(audit.freshness.thresholdDays).toBe(180);
    expect(audit.engineeringStatus).toBe('PASS');
    expect(audit.auditRunStatus).toBe('RUN_RECORDED');
    expect(audit.commercialConclusion).toBe('OPEN');
  });

  it('审计是只读的：运行前后 ClaimItem / RuleVersion / AuditLog 内容不变', async () => {
    await seedClaim('FBA_LOSS', '100.0000');
    const before = {
      items: await prisma.claimItem.findMany({ orderBy: { id: 'asc' } }),
      audits: await prisma.auditLog.count({ where: { organizationId: ORG } }),
    };
    await buildRuleEngineAudit(prisma, { organizationId: ORG, role: 'ADMIN', now: () => NOW });
    const after = {
      items: await prisma.claimItem.findMany({ orderBy: { id: 'asc' } }),
      audits: await prisma.auditLog.count({ where: { organizationId: ORG } }),
    };
    expect(after.items).toEqual(before.items);
    expect(after.audits).toBe(before.audits);
  });

  it('复核只写审计：ClaimItem.recoverableAmount 不被改动；历史可追加（最新生效）', async () => {
    const id = await seedClaim('FBA_LOSS', '100.0000');

    await recordRecoverableAmountReview(
      prisma,
      { ...base(), claimItemId: id, ruleAmount: '100.0000', toAmount: '90.0000', decision: 'ADJUSTED', reason: '首次判断' },
      { now: () => new Date(NOW.getTime()) },
    );
    await recordRecoverableAmountReview(
      prisma,
      { ...base(), claimItemId: id, ruleAmount: '100.0000', decision: 'CONFIRMED' },
      { now: () => new Date(NOW.getTime() + 60_000) },
    );

    const row = await prisma.claimItem.findUniqueOrThrow({ where: { id } });
    expect(row.recoverableAmount?.toFixed(4)).toBe('100.0000');
    const reviews = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'claim.recoverable_amount_reviewed' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(reviews).toHaveLength(2);
    expect(reviews[0].changes).toMatchObject({ decision: 'CONFIRMED' });

    const audit = await buildRuleEngineAudit(prisma, { organizationId: ORG, role: 'OWNER', now: () => NOW });
    expect(audit.residuals.classification).toEqual({ NO_HUMAN_REVIEW: 0, CONFIRMED: 1, ADJUSTED: 0 });
  });

  it('提交的 ruleAmount 与历史规则输出不一致 → RULE_AMOUNT_MISMATCH（零写入）', async () => {
    const id = await seedClaim('FBA_LOSS', '100.0000');
    const before = await prisma.auditLog.count({ where: { organizationId: ORG } });
    await expect(
      recordRecoverableAmountReview(
        prisma,
        { ...base(), claimItemId: id, ruleAmount: '999.0000', decision: 'CONFIRMED' },
        { now: () => NOW },
      ),
    ).rejects.toMatchObject({ code: 'RULE_AMOUNT_MISMATCH' });
    expect(await prisma.auditLog.count({ where: { organizationId: ORG } })).toBe(before);
  });

  it('权限：FINANCE 可读审计报告但不可写复核；VIEWER 读也不可', async () => {
    const id = await seedClaim('FBA_LOSS', '100.0000');
    const financeRead = await buildRuleEngineAudit(prisma, { organizationId: ORG, role: 'FINANCE', now: () => NOW });
    expect(financeRead.coverage.claimItems).toBe(1);

    await expect(
      recordRecoverableAmountReview(
        prisma,
        { ...base(), role: 'FINANCE', claimItemId: id, ruleAmount: '100.0000', decision: 'CONFIRMED' },
        { now: () => NOW },
      ),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      buildRuleEngineAudit(prisma, { organizationId: ORG, role: 'VIEWER', now: () => NOW }),
    ).rejects.toThrow(ForbiddenError);
  });
});
