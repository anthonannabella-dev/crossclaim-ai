/**
 * C-0009.3 P0 — masking + appeal-package delivery state (unit).
 * ---------------------------------------------------------------
 * Masking is display-only: the raw value stays available to the data owner, so
 * the customer's own evidence is never hidden. The locked state applies **only**
 * to the generated commercial deliverable.
 */

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  ForbiddenError,
  MASK_TOKEN,
  getAppealPackageState,
  maskIdentifier,
} from '../services/workflow';

const ORG = 'f0000000-0000-4000-8000-000000000015';
const CASE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

describe('C-0009.3 P0 — 敏感标识掩码', () => {
  it('按类型给出确定性掩码（架构方示例：112-****-4821）', () => {
    expect(maskIdentifier('112-845234-4821', 'ORDER_ID')).toBe('112-****-4821');
    expect(maskIdentifier('X001ABCDEF', 'FNSKU')).toBe('X00****DEF');
    expect(maskIdentifier('1Z999AA10123456784', 'TRACKING')).toBe('1Z****6784');
    expect(maskIdentifier('1128452344821', 'ORDER_ID')).toBe('1****4821');
    expect(maskIdentifier('ABCDEFGH', 'GENERIC')).toBe('AB****GH');
  });

  it('过短值整体掩码，避免「掩了等于没掩」；空值与 null 安全处理', () => {
    expect(maskIdentifier('ABC', 'FNSKU')).toBe(MASK_TOKEN);
    expect(maskIdentifier('AB-1', 'ORDER_ID')).toBe(MASK_TOKEN);
    expect(maskIdentifier('', 'GENERIC')).toBe('');
    expect(maskIdentifier(null)).toBeNull();
    expect(maskIdentifier(undefined)).toBeNull();
  });

  it('掩码是确定性纯函数（同输入同输出，可安全用于展示与快照）', () => {
    const first = maskIdentifier('1Z999AA10123456784', 'TRACKING');
    const second = maskIdentifier('1Z999AA10123456784', 'TRACKING');
    expect(first).toBe(second);
    expect(first).not.toBe('1Z999AA10123456784');
  });
});

describe('C-0009.3 P0 — 交付物 Locked 状态', () => {
  function stubPrisma(hasCase = true) {
    const findFirst: ReturnType<typeof vi.fn> = vi.fn(async () =>
      hasCase ? { id: CASE, caseNo: 'CASE-1' } : null,
    );
    return { prisma: { case: { findFirst } } as unknown as PrismaClient, findFirst };
  }

  it('交付物为 LOCKED 且未提供解锁能力；客户数据访问全部 AVAILABLE', async () => {
    const { prisma } = stubPrisma();
    const state = await getAppealPackageState(prisma, { organizationId: ORG, role: 'OPS' }, CASE);

    expect(state.deliverable).toMatchObject({
      kind: 'APPEAL_PACKAGE',
      state: 'LOCKED',
      unlockAvailable: false,
    });
    // 关键边界：锁的只是对外交付物，客户自有数据与证据链不受影响
    expect(state.customerDataAccess).toEqual({
      rawFiles: 'AVAILABLE',
      evidenceChain: 'AVAILABLE',
      auditTrail: 'AVAILABLE',
      note: expect.stringContaining('不得以支付绑定作为数据访问条件'),
    });
  });

  it('FINANCE / VIEWER 不可读（沿用案件可见性），跨租户 404', async () => {
    for (const role of ['FINANCE', 'VIEWER']) {
      const { prisma, findFirst } = stubPrisma();
      await expect(
        getAppealPackageState(prisma, { organizationId: ORG, role }, CASE),
      ).rejects.toThrow(ForbiddenError);
      expect(findFirst).not.toHaveBeenCalled();
    }

    const missing = stubPrisma(false);
    await expect(
      getAppealPackageState(missing.prisma, { organizationId: ORG, role: 'ADMIN' }, CASE),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
