// MSG-20260929-26 验收（离线部分）：Recovery Confirmation 的语义拆分与金额投影。
//   · 确认轴与对账轴互不覆盖（CONFIRMED + NOT_STARTED 必须合法）
//   · received 与 confirmed 的关系 → NOT_STARTED / PARTIAL / RECONCILED / DISPUTED
//   · receivedAmount 为投影（Σ payouts），不是第二个落库事实源
//   · 录入校验（payoutRef / 金额 / 币种 / 来源）与权限 fail-closed
// 纯离线：不触库、不发对外请求、不做任何资金动作。

import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { permissionsFor } from '../services/workflow/permissions';
import {
  PAYOUT_SOURCE_TYPES,
  normalizePayoutInput,
  projectRecoveryState,
  reconciliationFromPayouts,
  recordRecoveryPayout,
} from '../services/recovery/recovery-confirmation';

const dec = (value: string) => new Prisma.Decimal(value);

describe('MSG-26 · 对账状态推导（I2/I3/I4）', () => {
  it('01 未到账 → NOT_STARTED（与确认状态无关）', () => {
    expect(reconciliationFromPayouts(dec('100.0000'), dec('0.0000'))).toBe('NOT_STARTED');
  });

  it('02 部分到账 → PARTIAL', () => {
    expect(reconciliationFromPayouts(dec('100.0000'), dec('40.0000'))).toBe('PARTIAL');
  });

  it('03 全额到账 → RECONCILED', () => {
    expect(reconciliationFromPayouts(dec('100.0000'), dec('100.0000'))).toBe('RECONCILED');
  });

  it('04 超额到账 → DISPUTED（不自动改账，D3）', () => {
    expect(reconciliationFromPayouts(dec('100.0000'), dec('100.0001'))).toBe('DISPUTED');
  });
});

describe('MSG-26 · 双轴投影（确认 ≠ 到账）', () => {
  it('05 CONFIRMED + NOT_STARTED 是合法状态（已确认但未到账）', () => {
    const projection = projectRecoveryState({
      settlementId: 's-1',
      confirmationStatus: 'CONFIRMED',
      reconciliationStatus: 'NOT_STARTED',
      confirmedAmount: '100.0000',
      payouts: [],
    });
    expect(projection.confirmedAmount).toBe('100.0000');
    expect(projection.receivedAmount).toBe('0.0000');
    expect(projection.variance).toBe('-100.0000');
    expect(projection.derivedReconciliationStatus).toBe('NOT_STARTED');
    expect(projection.needsFinanceReview).toBe(false);
  });

  it('06 多期到账累加为 receivedAmount（SUM，不落库）', () => {
    const projection = projectRecoveryState({
      settlementId: 's-1',
      confirmationStatus: 'CONFIRMED',
      reconciliationStatus: 'PARTIAL',
      confirmedAmount: '100.0000',
      payouts: [{ amount: '25.5000' }, { amount: '30.0000' }],
    });
    expect(projection.receivedAmount).toBe('55.5000');
    expect(projection.payoutCount).toBe(2);
    expect(projection.derivedReconciliationStatus).toBe('PARTIAL');
  });

  it('07 全额到账 → RECONCILED，差异为 0', () => {
    const projection = projectRecoveryState({
      settlementId: 's-1',
      confirmationStatus: 'CONFIRMED',
      reconciliationStatus: 'RECONCILED',
      confirmedAmount: '80.0000',
      payouts: [{ amount: '50.0000' }, { amount: '30.0000' }],
    });
    expect(projection.derivedReconciliationStatus).toBe('RECONCILED');
    expect(projection.variance).toBe('0.0000');
    expect(projection.needsFinanceReview).toBe(false);
  });

  it('08 超额 → DISPUTED，需 FINANCE 人工处置', () => {
    const projection = projectRecoveryState({
      settlementId: 's-1',
      confirmationStatus: 'CONFIRMED',
      reconciliationStatus: 'DISPUTED',
      confirmedAmount: '10.0000',
      payouts: [{ amount: '12.0000' }],
    });
    expect(projection.derivedReconciliationStatus).toBe('DISPUTED');
    expect(projection.needsFinanceReview).toBe(true);
  });

  it('09 REVERSED 为终局：后续到账不得静默覆盖（I7）', () => {
    const projection = projectRecoveryState({
      settlementId: 's-1',
      confirmationStatus: 'CONFIRMED',
      reconciliationStatus: 'REVERSED',
      confirmedAmount: '100.0000',
      payouts: [{ amount: '100.0000' }],
    });
    expect(projection.derivedReconciliationStatus).toBe('REVERSED');
    expect(projection.needsFinanceReview).toBe(true);
  });

  it('10 PENDING_CONFIRMATION 与到账互不影响（两轴独立）', () => {
    const projection = projectRecoveryState({
      settlementId: 's-1',
      confirmationStatus: 'PENDING_CONFIRMATION',
      reconciliationStatus: 'PARTIAL',
      confirmedAmount: '60.0000',
      payouts: [{ amount: '60.0000' }],
    });
    expect(projection.confirmationStatus).toBe('PENDING_CONFIRMATION');
    expect(projection.derivedReconciliationStatus).toBe('RECONCILED');
  });
});

describe('MSG-26 · 录入校验（离线）', () => {
  const base = {
    payoutRef: 'PY-1',
    amount: '10.0000',
    currency: 'usd',
    receivedAt: new Date('2026-09-29T00:00:00Z'),
    sourceType: 'platform_settlement',
  };

  it('11 正常输入被归一化（币种大写、来源白名单）', () => {
    const normalized = normalizePayoutInput(base);
    expect(normalized.currency).toBe('USD');
    expect(normalized.sourceType).toBe('PLATFORM_SETTLEMENT');
    expect(normalized.amount.toFixed(4)).toBe('10.0000');
  });

  it('12 payoutRef 空值被拒', () => {
    expect(() => normalizePayoutInput({ ...base, payoutRef: '   ' })).toThrowError(/payoutRef/);
  });

  it('13 金额非法（非十进制 / 0 / 负数）被拒', () => {
    for (const amount of ['abc', '0', '0.0000', '-1']) {
      expect(() => normalizePayoutInput({ ...base, amount }), amount).toThrowError();
    }
  });

  it('14 来源必须在白名单内（禁自由文本扩散）', () => {
    expect(() => normalizePayoutInput({ ...base, sourceType: 'FROM_MY_BANK_APP' })).toThrowError(/sourceType/);
    expect(PAYOUT_SOURCE_TYPES).toContain('BANK_TRANSFER');
  });

  it('15 receivedAt 必须是合法时间', () => {
    expect(() => normalizePayoutInput({ ...base, receivedAt: '2026-09-29' })).toThrowError(/receivedAt/);
    expect(() => normalizePayoutInput({ ...base, receivedAt: new Date('nope') })).toThrowError(/receivedAt/);
  });
});

describe('MSG-27 · 到账登记权限 recoveryPayoutRecord', () => {
  it('16 权限矩阵：OWNER/ADMIN/FINANCE 可登记；OPS/VIEWER/未知角色 fail-closed', () => {
    for (const role of ['OWNER', 'ADMIN', 'FINANCE']) {
      expect(permissionsFor(role).recoveryPayoutRecord, role).toBe(true);
    }
    for (const role of ['OPS', 'VIEWER', 'SUPERADMIN', '', null, undefined]) {
      expect(permissionsFor(role as never).recoveryPayoutRecord, String(role)).toBe(false);
    }
  });

  it('17 无权限者，在任何 DB 访问之前即被拒绝', async () => {
    let touched = false;
    const prismaStub = {
      settlement: {
        findFirst: () => {
          touched = true;
          return Promise.resolve(null);
        },
      },
    } as never;
    const auditStub = { record: () => Promise.resolve({ id: 'a', createdAt: new Date() }) };

    for (const role of ['VIEWER', 'OPS', 'SUPERADMIN', '']) {
      await expect(
        recordRecoveryPayout(
          {
            organizationId: '00000000-0000-4000-8000-000000000001',
            settlementId: 's-1',
            actorUserId: 'u-1',
            role,
            payoutRef: 'PY-1',
            amount: '1.0000',
            currency: 'USD',
            receivedAt: new Date('2026-09-29T00:00:00Z'),
            sourceType: 'OTHER',
          },
          { prisma: prismaStub, audit: auditStub as never },
        ),
        role,
      ).rejects.toThrowError();
    }
    expect(touched).toBe(false);
  });
});
