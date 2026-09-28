/**
 * C-0010-B — finance reconciliation, unit level（无数据库）。
 * 覆盖差异判定、CSV 形状与权限闸门。
 */

import { type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  ForbiddenError,
  RECONCILIATION_CSV_HEADER,
  classifyInvoicePayments,
  listPaymentReconciliation,
  toReconciliationCsv,
  type ReconciliationInvoiceFacts,
} from '../services/workflow';

const NOW = new Date('2026-09-28T18:00:00Z');

function facts(overrides: {
  status?: string;
  total?: string;
  paidAmount?: string;
  currency?: string;
  reviewState?: ReconciliationInvoiceFacts['reviewState'];
  payments?: ReconciliationInvoiceFacts['payments'];
} = {}): ReconciliationInvoiceFacts {
  return {
    invoice: {
      id: 'inv-1',
      invoiceNo: 'BILL-1',
      status: overrides.status ?? 'ISSUED',
      total: overrides.total ?? '1000.0000',
      paidAmount: overrides.paidAmount ?? '0.0000',
      currency: overrides.currency ?? 'USD',
    },
    payments: overrides.payments ?? [
      {
        id: 'pay-1',
        externalPaymentId: 'pi_1',
        amount: '1000.0000',
        currency: 'USD',
        status: 'SUCCEEDED',
      },
    ],
    reviewState: overrides.reviewState ?? 'NOT_REQUIRED',
  };
}

const types = (input: ReconciliationInvoiceFacts) => classifyInvoicePayments(input).map((v) => v.differenceType);

describe('C-0010-B — 差异判定（纯函数）', () => {
  it('金额与账单不等 → 只报 AMOUNT_MISMATCH（不再叠加其他类型）', () => {
    const input = facts({
      payments: [
        { id: 'p', externalPaymentId: 'pi', amount: '99.0000', currency: 'USD', status: 'SUCCEEDED' },
      ],
    });
    expect(types(input)).toEqual(['AMOUNT_MISMATCH']);
  });

  it('金额一致但币种不同 → CURRENCY_MISMATCH', () => {
    const input = facts({
      payments: [
        { id: 'p', externalPaymentId: 'pi', amount: '1000.0000', currency: 'EUR', status: 'SUCCEEDED' },
      ],
    });
    expect(types(input)).toEqual(['CURRENCY_MISMATCH']);
  });

  it('钱到了但发票没 PAID：按 Payment HITL 状态分流', () => {
    expect(types(facts({ reviewState: 'PENDING' }))).toEqual(['AWAITING_PAYMENT_REVIEW']);
    expect(types(facts({ reviewState: 'REJECTED' }))).toEqual(['PAYMENT_WITHOUT_PAID_INVOICE']);
    expect(types(facts({ reviewState: 'NOT_REQUIRED' }))).toEqual(['PAYMENT_WITHOUT_PAID_INVOICE']);
  });

  it('发票 PAID 但没有付款行 → PAID_WITHOUT_PAYMENT', () => {
    expect(types(facts({ status: 'PAID', paidAmount: '1000.0000', payments: [] }))).toEqual([
      'PAID_WITHOUT_PAYMENT',
    ]);
  });

  it('发票 PAID 但 paidAmount 不等于成功付款合计 → PAID_AMOUNT_MISMATCH', () => {
    expect(types(facts({ status: 'PAID', paidAmount: '900.0000' }))).toEqual(['PAID_AMOUNT_MISMATCH']);
  });

  it('失败付款单独成行，且不掩盖金额不符', () => {
    const onlyFailed = facts({
      payments: [{ id: 'p', externalPaymentId: 'pi', amount: '1000.0000', currency: 'USD', status: 'FAILED' }],
    });
    expect(types(onlyFailed)).toEqual(['FAILED_PAYMENT']);

    const mixed = facts({
      payments: [
        { id: 'p1', externalPaymentId: 'pi_1', amount: '900.0000', currency: 'USD', status: 'SUCCEEDED' },
        { id: 'p2', externalPaymentId: 'pi_2', amount: '1.0000', currency: 'USD', status: 'FAILED' },
      ],
    });
    expect(types(mixed).sort()).toEqual(['AMOUNT_MISMATCH', 'FAILED_PAYMENT']);
  });

  it('对账一致的发票不产生任何差异行', () => {
    expect(types(facts({ status: 'PAID', paidAmount: '1000.0000' }))).toEqual([]);
  });
});

describe('C-0010-B — CSV 形状', () => {
  it('表头是架构方指定的 7 列；内容全部加引号且换行分隔', () => {
    expect([...RECONCILIATION_CSV_HEADER]).toEqual([
      'invoiceId',
      'paymentId',
      'amount',
      'currency',
      'status',
      'differenceType',
      'recommendation',
    ]);
    const csv = toReconciliationCsv({
      generatedAt: NOW,
      scannedInvoices: 1,
      counts: {
        AMOUNT_MISMATCH: 1,
        CURRENCY_MISMATCH: 0,
        AWAITING_PAYMENT_REVIEW: 0,
        PAYMENT_WITHOUT_PAID_INVOICE: 0,
        PAID_WITHOUT_PAYMENT: 0,
        PAID_AMOUNT_MISMATCH: 0,
        FAILED_PAYMENT: 0,
      },
      items: [
        {
          invoiceId: 'inv,1',
          invoiceNo: 'BILL-1',
          paymentId: 'pay-1',
          externalPaymentId: 'pi_1',
          amount: '99.0000',
          currency: 'USD',
          status: 'ISSUED|SUCCEEDED',
          differenceType: 'AMOUNT_MISMATCH',
          recommendation: 'confirm_amount',
          detectedAt: NOW,
        },
      ],
    });
    const lines = csv.split('\n');
    expect(lines[0]).toBe('invoiceId,paymentId,amount,currency,status,differenceType,recommendation');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      '"inv,1","pay-1","99.0000","USD","ISSUED|SUCCEEDED","AMOUNT_MISMATCH","confirm_amount"',
    );
  });
});

function fakePrisma(invoices: unknown[]) {
  const findMany = vi.fn(async () => invoices);
  const auditFindMany = vi.fn(async () => []);
  const prisma = {
    billingInvoice: { findMany },
    auditLog: { findMany: auditFindMany },
  } as unknown as PrismaClient;
  return { prisma, findMany, auditFindMany };
}

describe('C-0010-B — 权限与只读性', () => {
  it('VIEWER 无 viewBilling → Forbidden，且不发起查询', async () => {
    const { prisma, findMany } = fakePrisma([]);
    await expect(
      listPaymentReconciliation(prisma, { organizationId: 'org-1', role: 'VIEWER' }, { now: () => NOW }),
    ).rejects.toThrow(ForbiddenError);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('FINANCE 可读；只调用只读查询（无 create/update/delete）', async () => {
    const { prisma, auditFindMany } = fakePrisma([
      {
        id: 'inv-1',
        invoiceNo: 'BILL-1',
        status: 'ISSUED',
        total: { toFixed: () => '1000.0000' },
        paidAmount: { toFixed: () => '0.0000' },
        currency: 'USD',
        payments: [
          {
            id: 'pay-1',
            externalPaymentId: 'pi_1',
            amount: { toFixed: () => '1000.0000' },
            currency: 'USD',
            status: 'SUCCEEDED',
          },
        ],
      },
    ]);
    const report = await listPaymentReconciliation(
      prisma,
      { organizationId: 'org-1', role: 'FINANCE' },
      { now: () => NOW },
    );
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      invoiceId: 'inv-1',
      paymentId: 'pay-1',
      differenceType: 'PAYMENT_WITHOUT_PAID_INVOICE',
      status: 'ISSUED|SUCCEEDED',
      detectedAt: NOW,
    });
    expect(report.counts.PAYMENT_WITHOUT_PAID_INVOICE).toBe(1);
    expect(auditFindMany).toHaveBeenCalledTimes(1);
    expect(Object.keys(prisma as never)).toEqual(['billingInvoice', 'auditLog']);
  });
});
