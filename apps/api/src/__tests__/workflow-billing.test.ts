/**
 * C-0008-B2-3b — billing state machine + display guards (unit, no database).
 * -----------------------------------------------------------------------
 * DRAFT → ISSUED → PAID only; PAID needs paymentReference or note; roles come
 * from the approved matrix; a CAS miss is a 409 with no audit row.
 */

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  ForbiddenError,
} from '../services/workflow';
import {
  BILLING_TRANSITIONS,
  advanceBillingInvoice,
  canAdvanceBilling,
  listBillingInvoices,
} from '../services/workflow';

const ORG = 'f0000000-0000-4000-8000-000000000011';
const ACTOR = '88888888-8888-4888-8888-888888888888';
const INVOICE = '99999999-9999-4999-8999-999999999999';

interface FakeTx {
  billingInvoice: { updateMany: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
}

function fakePrisma(status: string, casHits = true) {
  const tx: FakeTx = {
    billingInvoice: {
      updateMany: vi.fn(async () => ({ count: casHits ? 1 : 0 })),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
  };
  const findFirst = vi.fn(async () => ({ id: INVOICE, status, invoiceNo: 'BILL-1', caseId: 'case-1', total: 100, currency: 'USD' }));
  const transaction = vi.fn(async (fn: (client: FakeTx) => Promise<unknown>) => fn(tx));
  return {
    prisma: { billingInvoice: { findFirst }, $transaction: transaction } as unknown as PrismaClient,
    tx,
    findFirst,
    transaction,
  };
}

const base = { organizationId: ORG, actorUserId: ACTOR, role: 'FINANCE', invoiceId: INVOICE } as const;

describe('C-0008-B2-3b — Billing 状态机', () => {
  it('只允许 DRAFT → ISSUED → PAID，其余一律非法', () => {
    expect(canAdvanceBilling('DRAFT', 'ISSUED')).toBe(true);
    expect(canAdvanceBilling('ISSUED', 'PAID')).toBe(true);
    expect(canAdvanceBilling('DRAFT', 'PAID')).toBe(false);
    expect(canAdvanceBilling('PAID', 'ISSUED')).toBe(false);
    expect(canAdvanceBilling('VOID', 'PAID')).toBe(false);
    expect(BILLING_TRANSITIONS.PAID).toEqual([]);
  });

  it('DRAFT → PAID 直接跳转被拒（即便带 note）', async () => {
    const { prisma, tx } = fakePrisma('DRAFT');
    await expect(
      advanceBillingInvoice(prisma, { ...base, to: 'PAID', note: 'bank transfer' }),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    expect(tx.billingInvoice.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('PAID 必须带 paymentReference 或 note（触库前拒绝）', async () => {
    const { prisma, findFirst } = fakePrisma('ISSUED');
    for (const extra of [{}, { paymentReference: '   ' }, { note: '  ' }]) {
      await expect(
        advanceBillingInvoice(prisma, { ...base, to: 'PAID', ...extra }),
      ).rejects.toMatchObject({ code: 'PAYMENT_REFERENCE_REQUIRED' });
    }
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('OPS 不能推进 Billing（只读）；VIEWER 不能查看', async () => {
    const { prisma, transaction } = fakePrisma('DRAFT');
    await expect(advanceBillingInvoice(prisma, { ...base, role: 'OPS', to: 'ISSUED' })).rejects.toThrow(
      ForbiddenError,
    );
    expect(transaction).not.toHaveBeenCalled();

    const listPrisma = { billingInvoice: { findMany: vi.fn(async () => []) } } as unknown as PrismaClient;
    await expect(listBillingInvoices(listPrisma, { organizationId: ORG, role: 'VIEWER' })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('CAS 未命中（并发）→ ILLEGAL_TRANSITION 且不写审计', async () => {
    const { prisma, tx } = fakePrisma('DRAFT', false);
    await expect(advanceBillingInvoice(prisma, { ...base, to: 'ISSUED' })).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('ISSUED → PAID 成功时写审计，只记录「是否提供支付引用」', async () => {
    const { prisma, tx } = fakePrisma('ISSUED');
    const result = await advanceBillingInvoice(prisma, {
      ...base,
      to: 'PAID',
      paymentReference: 'bank-ref-2026-09',
    });
    expect(result).toEqual({
      invoiceId: INVOICE,
      from: 'ISSUED',
      to: 'PAID',
      paymentReferenceProvided: true,
    });
    const changes = tx.auditLog.create.mock.calls[0][0].data.changes;
    expect(changes).toMatchObject({ from: 'ISSUED', to: 'PAID', paymentReferenceProvided: true });
    expect(JSON.stringify(changes)).not.toContain('bank-ref-2026-09');
  });
});
