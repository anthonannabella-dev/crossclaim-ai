/**
 * C-0008-B2-2 — case / evidence / claim-draft reads against real PostgreSQL.
 * ----------------------------------------------------------------------
 * Proves the approved visibility contract:
 *   · case list + detail never carry claim text
 *   · evidence metadata is tenant- and case-scoped (no foreign artifacts)
 *   · claim text is only available through getClaimDraft (OWNER/ADMIN/OPS)
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ForbiddenError,
  getCase,
  getClaimDraft,
  listCaseEvidence,
  listCases,
} from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'ac000000-0000-4000-8000-00000000000a';
const ORG_B = 'ac000000-0000-4000-8000-00000000000b';
const NOW = new Date('2026-09-28T18:00:00Z');

let financeId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '案件读取租户', slug: 'case-read-org' },
      { id: ORG_B, name: '外部租户', slug: 'case-read-org-b' },
    ],
  });
  const [owner, finance] = await Promise.all([
    prisma.user.create({ data: { email: 'case-read-owner@example.com', displayName: '所有者', status: 'ACTIVE' } }),
    prisma.user.create({ data: { email: 'case-read-finance@example.com', displayName: '财务', status: 'ACTIVE' } }),
  ]);
  financeId = finance.id;
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true },
      { organizationId: ORG, userId: finance.id, role: 'FINANCE', isActive: true },
    ],
  });
});

async function seedCaseWithEvidenceAndClaim(options: { organizationId?: string; withEvidence?: boolean } = {}) {
  const organizationId = options.organizationId ?? ORG;
  const opportunity = await prisma.recoveryOpportunity.create({
    data: {
      organizationId,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      status: 'CONVERTED',
      opportunityType: 'FREIGHT_RATE_VARIANCE',
      title: '案件读取用例',
      amountExpected: new Prisma.Decimal('17.7500'),
      amountActual: new Prisma.Decimal('20.4125'),
      recoverableAmount: new Prisma.Decimal('2.6625'),
      currency: 'USD',
      detectedAt: NOW,
    },
  });
  const kase = await prisma.case.create({
    data: {
      organizationId,
      caseNo: `CASE-${opportunity.id}`,
      title: '案件读取案件',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('2.6625'),
      currency: 'USD',
    },
  });
  await prisma.caseOpportunity.create({
    data: { organizationId, caseId: kase.id, opportunityId: opportunity.id },
  });
  const claim = await prisma.claim.create({
    data: {
      organizationId,
      caseId: kase.id,
      round: 1,
      status: 'DRAFT',
      target: 'CARRIER',
      aiDraftText: 'Claim draft (CASE-1) — FRT\nExpected charge: 17.7500 USD\nRecoverable amount: 2.6625 USD',
    },
  });
  let evidenceId: string | null = null;
  if (options.withEvidence !== false) {
    const evidence = await prisma.evidenceArtifact.create({
      data: {
        organizationId,
        kind: 'INVOICE',
        title: '承运商发票',
        description: 'fixture',
        capturedAt: NOW,
      },
    });
    evidenceId = evidence.id;
    await prisma.caseEvidence.create({
      data: { organizationId, caseId: kase.id, evidenceId: evidence.id, role: 'INVOICE' },
    });
  }
  return { opportunity, kase, claim, evidenceId };
}

describe('C-0008-B2-2 — 案件 / 证据 / Claim 正文（真实 PostgreSQL）', () => {
  it('案件列表与详情都不含 Claim 正文', async () => {
    const { kase } = await seedCaseWithEvidenceAndClaim();

    const list = await listCases(prisma, { organizationId: ORG, role: 'OWNER' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: kase.id, status: 'WON', claimedAmount: '2.6625' });
    expect(JSON.stringify(list)).not.toContain('Claim draft');

    const detail = await getCase(prisma, { organizationId: ORG, role: 'OPS' }, kase.id);
    expect(detail.claims).toHaveLength(1);
    expect(detail.claims[0]).toMatchObject({ round: 1, status: 'DRAFT', target: 'CARRIER' });
    expect(Object.keys(detail.claims[0]).sort()).toEqual(['dueAt', 'id', 'round', 'status', 'target']);
    expect(JSON.stringify(detail)).not.toContain('Claim draft');
  });

  it('证据列表只给元数据、按租户与案件隔离', async () => {
    const mine = await seedCaseWithEvidenceAndClaim();
    const foreign = await seedCaseWithEvidenceAndClaim({ organizationId: ORG_B });

    const items = await listCaseEvidence(prisma, { organizationId: ORG, role: 'OWNER' }, mine.kase.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'INVOICE', role: 'INVOICE', title: '承运商发票', hasFile: false });
    expect(Object.keys(items[0]).sort()).toEqual(
      ['addedAt', 'capturedAt', 'description', 'evidenceId', 'hasFile', 'kind', 'reliability', 'role', 'title'].sort(),
    );

    // 外部租户的案件对当前租户不可见
    await expect(
      listCaseEvidence(prisma, { organizationId: ORG, role: 'OWNER' }, foreign.kase.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // 外部租户自己的证据仍可读（各自隔离）
    const foreignItems = await listCaseEvidence(
      prisma,
      { organizationId: ORG_B, role: 'OWNER' },
      foreign.kase.id,
    );
    expect(foreignItems).toHaveLength(1);
    expect(foreignItems[0].evidenceId).not.toBe(items[0].evidenceId);
  });

  it('Claim 正文：OWNER/OPS 可读，FINANCE 403，跨租户 404', async () => {
    const { kase } = await seedCaseWithEvidenceAndClaim();

    const view = await getClaimDraft(prisma, { organizationId: ORG, role: 'OWNER' }, kase.id);
    expect(view.status).toBe('DRAFT');
    expect(view.version).toBe(1);
    expect(view.sections).toHaveLength(3);
    expect(view.sections[0]).toContain('Claim draft');

    await expect(
      getClaimDraft(prisma, { organizationId: ORG, role: 'FINANCE' }, kase.id),
    ).rejects.toThrow(ForbiddenError);

    const foreign = await seedCaseWithEvidenceAndClaim({ organizationId: ORG_B });
    await expect(
      getClaimDraft(prisma, { organizationId: ORG, role: 'OWNER' }, foreign.kase.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(financeId).toBeTruthy();
  });
});
