/**
 * C-0008-B2-1 — case creation guards (unit, no database).
 * ---------------------------------------------------------------
 * Everything that can be refused before touching the closure is refused here:
 * role matrix (OPS may build a case but may not set the fee rate), commercial
 * terms validation, entry-state gate and closure-scope gate.
 */

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { createCaseForOpportunity } from '../services/workflow';
import { ForbiddenError } from '../services/workflow';

const ORG = 'f0000000-0000-4000-8000-00000000000f';
const ACTOR = '44444444-4444-4444-8444-444444444444';
const OPP = '55555555-5555-4555-8555-555555555555';
const TERMS = { successFeeRate: '0.1500', source: 'manual_input' };

function stubPrisma(row: { id: string; status: string; domain: string; channel: string } | null) {
  const findFirst = vi.fn(async () => row);
  return { prisma: { recoveryOpportunity: { findFirst } } as unknown as PrismaClient, findFirst };
}

const base = {
  organizationId: ORG,
  actorUserId: ACTOR,
  opportunityId: OPP,
  commercialTerms: TERMS,
} as const;

const closable = { id: OPP, status: 'QUALIFIED', domain: 'LOGISTICS', channel: 'OTHER' } as const;

describe('C-0008-B2-1 — 建案权限（费率只允许 OWNER / ADMIN 填写）', () => {
  it('OPS 可以建案但不能填写费率 → ForbiddenError', async () => {
    const { prisma, findFirst } = stubPrisma(closable);
    await expect(
      createCaseForOpportunity(prisma, { ...base, role: 'OPS' }),
    ).rejects.toThrow(ForbiddenError);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('FINANCE / VIEWER / 未知角色不能建案', async () => {
    for (const role of ['FINANCE', 'VIEWER', 'UNKNOWN']) {
      const { prisma } = stubPrisma(closable);
      await expect(createCaseForOpportunity(prisma, { ...base, role })).rejects.toThrow(
        ForbiddenError,
      );
    }
  });

  it('OWNER / ADMIN 通过权限检查，进入后续校验', async () => {
    for (const role of ['OWNER', 'ADMIN']) {
      const { prisma, findFirst } = stubPrisma(closable);
      // 后续会走到 closure（stub 没有 case/closure 依赖），这里只断言权限已放行。
      await expect(createCaseForOpportunity(prisma, { ...base, role })).rejects.not.toThrow(
        ForbiddenError,
      );
      expect(findFirst).toHaveBeenCalledTimes(1);
    }
  });
});

describe('C-0008-B2-1 — commercialTerms 校验（复用 Gate 2 断言）', () => {
  const cases: Array<[string, unknown]> = [
    ['缺少对象', undefined],
    ['字符串', '0.15'],
    ['数组', [0.15]],
    ['空费率', { successFeeRate: '', source: 'manual_input' }],
    ['百分号写法', { successFeeRate: '15%', source: 'manual_input' }],
    ['零费率', { successFeeRate: '0', source: 'manual_input' }],
    ['超过 1', { successFeeRate: '1.0001', source: 'manual_input' }],
    ['缺 source', { successFeeRate: '0.1500', source: '   ' }],
  ];

  it.each(cases)('%s → INVALID_COMMERCIAL_TERMS', async (_label, commercialTerms) => {
    const { prisma, findFirst } = stubPrisma(closable);
    await expect(
      createCaseForOpportunity(prisma, { ...base, role: 'ADMIN', commercialTerms }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMERCIAL_TERMS' });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('合法费率（(0, 1] 十进制字符串）通过校验', async () => {
    const { prisma, findFirst } = stubPrisma(closable);
    await expect(
      createCaseForOpportunity(prisma, {
        ...base,
        role: 'ADMIN',
        commercialTerms: { successFeeRate: '0.15', source: 'manual_input' },
      }),
    ).rejects.not.toMatchObject({ code: 'INVALID_COMMERCIAL_TERMS' });
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('C-0008-B2-1 — 准入状态与 closure 范围', () => {
  it('DETECTED（未人工确认）不允许建案 → ILLEGAL_TRANSITION', async () => {
    for (const status of ['DETECTED', 'REJECTED', 'EXPIRED']) {
      const { prisma } = stubPrisma({ ...closable, status });
      await expect(
        createCaseForOpportunity(prisma, { ...base, role: 'ADMIN' }),
      ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    }
  });

  it('CONVERTED（已建案）仍可进入（幂等复用）', async () => {
    const { prisma, findFirst } = stubPrisma({ ...closable, status: 'CONVERTED' });
    await expect(
      createCaseForOpportunity(prisma, { ...base, role: 'ADMIN' }),
    ).rejects.not.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('超出 Gate 2 closure 范围（channel 非 OTHER）→ SCOPE_NOT_SUPPORTED', async () => {
    for (const patch of [{ channel: 'UPS' }, { domain: 'PLATFORM' }]) {
      const { prisma } = stubPrisma({ ...closable, ...patch });
      await expect(
        createCaseForOpportunity(prisma, { ...base, role: 'ADMIN' }),
      ).rejects.toMatchObject({ code: 'SCOPE_NOT_SUPPORTED' });
    }
  });

  it('机会不存在或跨租户 → NOT_FOUND，且查询带 organizationId', async () => {
    const { prisma, findFirst } = stubPrisma(null);
    await expect(
      createCaseForOpportunity(prisma, { ...base, role: 'ADMIN' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: OPP, organizationId: ORG },
      select: { id: true, status: true, domain: true, channel: true },
    });
  });
});
