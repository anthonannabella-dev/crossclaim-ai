/**
 * C-0009 Commission Reconciliation — matching engine (unit, no database).
 * ---------------------------------------------------------------
 * Enforces the approved rules: payoutReference/orderId matching only (a time
 * window alone never matches), rule-based explanations (no AI confidence),
 * two-layer result (reconciliationStatus + billingStatus), dry-run default with
 * zero writes, idempotency, and OWNER/ADMIN-only execution.
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  ForbiddenError,
  normalizePayoutItem,
  reconcilePayoutItems,
} from '../services/workflow';

const ORG = 'f0000000-0000-4000-8000-000000000016';
const ACTOR = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CASE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SETTLEMENT = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const NOW = new Date('2026-09-28T18:00:00Z');

function fakePrisma(options: {
  settlements?: Array<Record<string, unknown>>;
  invoices?: Array<Record<string, unknown>>;
  termsRate?: string | null;
} = {}) {
  const settlements = options.settlements ?? [];
  const invoices = options.invoices ?? [];
  const termsRate = options.termsRate === undefined ? '0.1500' : options.termsRate;

  const feeCreate: ReturnType<typeof vi.fn> = vi.fn(async () => ({ id: 'fee-1' }));
  const invoiceCreate: ReturnType<typeof vi.fn> = vi.fn(async () => ({
    id: 'invoice-1',
    invoiceNo: 'BILL-CASE-1',
  }));
  const auditCreate: ReturnType<typeof vi.fn> = vi.fn(async () => ({ id: 'audit-1' }));
  const tx = {
    feeCalculation: { create: feeCreate },
    billingInvoice: { create: invoiceCreate },
    auditLog: { create: auditCreate },
  };

  const prisma = {
    settlement: { findMany: vi.fn(async () => settlements) },
    billingInvoice: { findMany: vi.fn(async () => invoices) },
    auditLog: {
      findFirst: vi.fn(async () =>
        termsRate === null
          ? null
          : { changes: { successFeeRate: termsRate, source: 'manual_input' } },
      ),
      create: auditCreate,
    },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;

  return { prisma, feeCreate, invoiceCreate, auditCreate };
}

const settlementRow = {
  id: SETTLEMENT,
  caseId: CASE,
  amount: new Prisma.Decimal('1500.0000'),
  currency: 'USD',
  receivedAt: new Date('2026-09-20T00:00:00Z'),
  note: 'payout payout-ref-2026-09 confirmed',
  case: { id: CASE, caseNo: 'CASE-1', currency: 'USD', status: 'WON' },
};

const item = { payoutReference: 'payout-ref-2026-09', amount: '1500.0000', currency: 'USD', payoutDate: '2026-09-21' };
const base = { organizationId: ORG, actorUserId: ACTOR, role: 'ADMIN' } as const;

describe('C-0009 — 赔付条目标准化', () => {
  it('必须至少有 payoutReference 或 platformOrderId；金额/币种/日期校验', () => {
    expect(() => normalizePayoutItem({ amount: '1.0000', currency: 'USD' })).toThrow(/payoutReference/);
    expect(() => normalizePayoutItem({ payoutReference: 'r', amount: 'abc', currency: 'USD' })).toThrow(/amount/);
    expect(() => normalizePayoutItem({ payoutReference: 'r', amount: '0', currency: 'USD' })).toThrow(/amount/);
    // 小写会被规范化为大写（接受）；长度/字符集非法才拒绝
    expect(normalizePayoutItem({ payoutReference: 'r', amount: '1.0000', currency: 'usd' }).currency).toBe('USD');
    expect(() => normalizePayoutItem({ payoutReference: 'r', amount: '1.0000', currency: 'US' })).toThrow(/currency/);
    expect(() => normalizePayoutItem({ payoutReference: 'r', amount: '1.0000', currency: 'US1' })).toThrow(/currency/);
    expect(() => normalizePayoutItem({ payoutReference: 'r', amount: '1.0000', currency: 'USD', payoutDate: 'nope' })).toThrow(
      /payoutDate/,
    );
  });

  it('dedupeKey 确定性（同输入同 key）', () => {
    const first = normalizePayoutItem(item as never);
    const second = normalizePayoutItem(item as never);
    expect(first.dedupeKey).toBe(second.dedupeKey);
    expect(first.amount).toBe('1500.0000');
  });
});

describe('C-0009 — 匹配、解释与两层结果', () => {
  it('FINANCE / OPS / VIEWER 不得执行对账（OWNER/ADMIN 专属）', async () => {
    for (const role of ['FINANCE', 'OPS', 'VIEWER']) {
      const { prisma } = fakePrisma();
      await expect(
        reconcilePayoutItems(prisma, { ...base, role, items: [item] }, { now: () => NOW }),
      ).rejects.toThrow(ForbiddenError);
    }
  });

  it('仅时间窗接近（无 ref/orderId 命中）→ UNMATCHED，且解释是规则理由', async () => {
    const { prisma } = fakePrisma({ settlements: [settlementRow] });
    const summary = await reconcilePayoutItems(
      prisma,
      { ...base, items: [{ platformOrderId: 'UNKNOWN-ORDER', amount: '1500.0000', currency: 'USD', payoutDate: '2026-09-21' }] },
      { now: () => NOW },
    );
    const result = summary.results[0];
    expect(result.reconciliationStatus).toBe('UNMATCHED');
    expect(result.billingStatus).toBe('NOT_APPLICABLE');
    expect(result.confidenceReason).toContain('time window alone never matches');
    // 解释里不得出现 AI 置信度式数字
    expect(result.confidenceReason).not.toMatch(/confidence\s*[:=]?\s*0?\.\d+/i);
  });

  it('dry-run 默认：MATCHED + NOT_APPLICABLE，且零写入', async () => {
    const { prisma, feeCreate, invoiceCreate, auditCreate } = fakePrisma({ settlements: [settlementRow] });
    const summary = await reconcilePayoutItems(prisma, { ...base, items: [item] }, { now: () => NOW });

    expect(summary.dryRun).toBe(true);
    const result = summary.results[0];
    expect(result.reconciliationStatus).toBe('MATCHED');
    expect(result.billingStatus).toBe('NOT_APPLICABLE');
    expect(result.matchType).toBe('PAYOUT_REFERENCE');
    expect(result.matchedFields).toEqual(['payoutReference']);
    expect(result.confidenceReason).toContain('matched by exact payoutReference');
    expect(result.confidenceReason).toContain('dry run');
    expect(result.feeAmount).toBe('225.0000'); // 1500 × 0.15
    expect(feeCreate).not.toHaveBeenCalled();
    expect(invoiceCreate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('执行模式：只创建 DRAFT 账单 + 两条审计；charged=false（reconciled ≠ paid）', async () => {
    const { prisma, feeCreate, invoiceCreate, auditCreate } = fakePrisma({ settlements: [settlementRow] });
    const summary = await reconcilePayoutItems(
      prisma,
      { ...base, items: [item], dryRun: false },
      { now: () => NOW },
    );

    const result = summary.results[0];
    expect(result.reconciliationStatus).toBe('MATCHED');
    expect(result.billingStatus).toBe('DRAFT_CREATED');
    expect(result.billingInvoiceId).toBe('invoice-1');
    expect(feeCreate).toHaveBeenCalledTimes(1);
    expect(invoiceCreate).toHaveBeenCalledTimes(1);
    expect(invoiceCreate.mock.calls[0][0].data).toMatchObject({ status: 'DRAFT', currency: 'USD' });
    const actions = auditCreate.mock.calls.map((call) => call[0].data.action);
    expect(actions).toEqual(['commission.calculated', 'commission.charge_created']);
    expect(auditCreate.mock.calls[0][0].data.changes).toMatchObject({ charged: false, billingStatus: 'DRAFT_CREATED' });
  });

  it('金额不一致 → AMBIGUOUS（matchedFields 含 amount）；已开票 → ALREADY_CHARGED/ALREADY_BILLED', async () => {
    const mismatch = fakePrisma({ settlements: [settlementRow] });
    const mismatchSummary = await reconcilePayoutItems(
      mismatch.prisma,
      { ...base, items: [{ ...item, amount: '1200.0000' }] },
      { now: () => NOW },
    );
    expect(mismatchSummary.results[0].reconciliationStatus).toBe('AMBIGUOUS');
    expect(mismatchSummary.results[0].matchedFields).toContain('amount');

    const billed = fakePrisma({
      settlements: [settlementRow],
      invoices: [{ id: 'invoice-existing', caseId: CASE, status: 'DRAFT' }],
    });
    const billedSummary = await reconcilePayoutItems(billed.prisma, { ...base, items: [item] }, { now: () => NOW });
    expect(billedSummary.results[0]).toMatchObject({
      reconciliationStatus: 'ALREADY_CHARGED',
      billingStatus: 'ALREADY_BILLED',
      billingInvoiceId: 'invoice-existing',
    });
  });

  it('同批重复条目 → DUPLICATE_IGNORED；费率未确认 → COMMERCIAL_TERMS_PENDING', async () => {
    const duplicate = fakePrisma({ settlements: [settlementRow] });
    const summary = await reconcilePayoutItems(
      duplicate.prisma,
      { ...base, items: [item, item], dryRun: false },
      { now: () => NOW },
    );
    expect(summary.results.map((r) => r.reconciliationStatus)).toEqual(['MATCHED', 'DUPLICATE_IGNORED']);

    const noTerms = fakePrisma({ settlements: [settlementRow], termsRate: null });
    await expect(
      reconcilePayoutItems(noTerms.prisma, { ...base, items: [item], dryRun: false }, { now: () => NOW }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_TERMS_PENDING' });
  });
});
