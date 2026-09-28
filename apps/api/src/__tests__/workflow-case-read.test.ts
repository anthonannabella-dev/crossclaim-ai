/**
 * C-0008-B2-2 — case / evidence / claim-draft visibility guards (unit).
 * ------------------------------------------------------------------
 * Roles: OWNER / ADMIN / OPS may read cases + evidence; FINANCE and VIEWER are
 * refused. Claim text additionally requires viewClaimText and is only returned
 * by getClaimDraft (never by the list/detail views).
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  ForbiddenError,
  getCase,
  getClaimDraft,
  listCaseEvidence,
  listCases,
} from '../services/workflow';

const ORG = 'f0000000-0000-4000-8000-000000000012';
const CASE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function stubCase(claim: Record<string, unknown> | null) {
  const caseFindFirst: ReturnType<typeof vi.fn> = vi.fn(async () => ({
    id: CASE,
    caseNo: 'CASE-1',
    title: '案件',
    status: 'WON',
    domain: 'LOGISTICS',
    currency: 'USD',
    claimedAmount: new Prisma.Decimal('2.6625'),
    recoveredAmount: null,
    createdAt: new Date('2026-09-28T18:00:00Z'),
    opportunities: [{ opportunityId: 'opp-1', opportunity: { status: 'CONVERTED', title: '机会' } }],
    claims: [{ id: 'claim-1', round: 1, status: 'DRAFT', target: 'CARRIER', dueAt: null }],
  }));
  const claimFindFirst: ReturnType<typeof vi.fn> = vi.fn(async () => claim);
  return {
    prisma: {
      case: { findFirst: caseFindFirst, findMany: vi.fn(async () => []) },
      claim: { findFirst: claimFindFirst },
      caseEvidence: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient,
    caseFindFirst,
    claimFindFirst,
  };
}

const claimRow = {
  id: 'claim-1',
  round: 1,
  status: 'DRAFT',
  createdAt: new Date('2026-09-28T18:00:00Z'),
  aiDraftText: 'Claim draft (CASE-1) — FRT\nExpected charge: 17.7500 USD\n\nRecoverable amount: 2.6625 USD',
  finalText: null,
};

describe('C-0008-B2-2 — 案件与证据可见性', () => {
  it('FINANCE / VIEWER 不能读取案件与证据（403，触库前）', async () => {
    for (const role of ['FINANCE', 'VIEWER', 'UNKNOWN']) {
      const { prisma, caseFindFirst } = stubCase(claimRow);
      await expect(listCases(prisma, { organizationId: ORG, role })).rejects.toThrow(ForbiddenError);
      await expect(getCase(prisma, { organizationId: ORG, role }, CASE)).rejects.toThrow(ForbiddenError);
      await expect(listCaseEvidence(prisma, { organizationId: ORG, role }, CASE)).rejects.toThrow(
        ForbiddenError,
      );
      expect(caseFindFirst).not.toHaveBeenCalled();
    }
  });

  it('OWNER / ADMIN / OPS 可以读取案件（查询带 organizationId）', async () => {
    for (const role of ['OWNER', 'ADMIN', 'OPS']) {
      const { prisma, caseFindFirst } = stubCase(claimRow);
      await getCase(prisma, { organizationId: ORG, role }, CASE);
      expect(caseFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CASE, organizationId: ORG } }),
      );
    }
  });
});

describe('C-0008-B2-2 — Claim 正文（单独端点）', () => {
  it('FINANCE / VIEWER 取正文一律 403（触库前）', async () => {
    for (const role of ['FINANCE', 'VIEWER', 'UNKNOWN']) {
      const { prisma, caseFindFirst } = stubCase(claimRow);
      await expect(getClaimDraft(prisma, { organizationId: ORG, role }, CASE)).rejects.toThrow(
        ForbiddenError,
      );
      expect(caseFindFirst).not.toHaveBeenCalled();
    }
  });

  it('OWNER / ADMIN / OPS 得到 {id,status,generatedAt,sections,version}，且无 prompt/模型字段', async () => {
    for (const role of ['OWNER', 'ADMIN', 'OPS']) {
      const { prisma } = stubCase(claimRow);
      const view = await getClaimDraft(prisma, { organizationId: ORG, role }, CASE);
      expect(Object.keys(view).sort()).toEqual(
        ['caseId', 'generatedAt', 'id', 'isFinal', 'round', 'sections', 'status', 'version'].sort(),
      );
      expect(view).toMatchObject({ id: 'claim-1', status: 'DRAFT', version: 1, isFinal: false });
      expect(view.sections[0]).toContain('Claim draft');
      expect(view.sections).toHaveLength(3); // 空行被剔除
      expect(JSON.stringify(view)).not.toMatch(/prompt|model|trace|completion/i);
    }
  });

  it('存在 finalText 时优先返回最终文本（isFinal=true）', async () => {
    const { prisma } = stubCase({ ...claimRow, finalText: 'FINAL: 2.6625 USD' });
    const view = await getClaimDraft(prisma, { organizationId: ORG, role: 'OPS' }, CASE);
    expect(view.isFinal).toBe(true);
    expect(view.sections).toEqual(['FINAL: 2.6625 USD']);
  });

  it('没有 Claim 的案件 → NOT_FOUND', async () => {
    const { prisma } = stubCase(null);
    await expect(getClaimDraft(prisma, { organizationId: ORG, role: 'ADMIN' }, CASE)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
