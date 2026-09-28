/**
 * C-0008-B2-3a — confirmRecoveryOutcome guards (unit, no database).
 * ---------------------------------------------------------------
 * Everything that must be refused before touching the money chain: role matrix,
 * missing/empty basis reference, non-positive or non-decimal amounts.
 */

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { confirmRecoveryOutcome } from '../services/workflow';
import { ForbiddenError } from '../services/workflow';

const ORG = 'f0000000-0000-4000-8000-000000000010';
const ACTOR = '66666666-6666-4666-8666-666666666666';
const CASE = '77777777-7777-4777-8777-777777777777';

function untouchable() {
  const transaction = vi.fn(() => {
    throw new Error('DB_SHOULD_NOT_BE_TOUCHED');
  });
  const findFirst = vi.fn(() => {
    throw new Error('DB_SHOULD_NOT_BE_TOUCHED');
  });
  return {
    prisma: { $transaction: transaction, case: { findFirst } } as unknown as PrismaClient,
    transaction,
    findFirst,
  };
}

const base = {
  organizationId: ORG,
  actorUserId: ACTOR,
  caseId: CASE,
  recoveredAmount: '1000.0000',
  currency: 'USD',
  basisReference: 'carrier-email-20260928',
} as const;

describe('C-0008-B2-3a — 确认回收结果：权限与输入校验', () => {
  it('OPS / VIEWER / 未知角色不能确认回收结果', async () => {
    for (const role of ['OPS', 'VIEWER', 'UNKNOWN']) {
      const { prisma, transaction, findFirst } = untouchable();
      await expect(confirmRecoveryOutcome(prisma, { ...base, role })).rejects.toThrow(ForbiddenError);
      expect(transaction).not.toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
    }
  });

  it('OWNER / ADMIN / FINANCE 通过权限检查（FINANCE 可确认回收结果）', async () => {
    for (const role of ['OWNER', 'ADMIN', 'FINANCE']) {
      const { prisma } = untouchable();
      await expect(confirmRecoveryOutcome(prisma, { ...base, role })).rejects.not.toThrow(
        ForbiddenError,
      );
    }
  });

  it('basisReference 为空 → INVALID_INPUT（禁止无依据确认到账）', async () => {
    const { prisma, findFirst } = untouchable();
    for (const basisReference of ['', '   ', undefined, 123]) {
      await expect(
        confirmRecoveryOutcome(prisma, { ...base, role: 'ADMIN', basisReference }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('金额必须为 > 0 的十进制字符串', async () => {
    const { prisma, findFirst } = untouchable();
    for (const recoveredAmount of ['0', '0.0000', '-1', 'abc', '1e3', undefined, 1000]) {
      await expect(
        confirmRecoveryOutcome(prisma, { ...base, role: 'ADMIN', recoveredAmount }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(findFirst).not.toHaveBeenCalled();
  });
});
