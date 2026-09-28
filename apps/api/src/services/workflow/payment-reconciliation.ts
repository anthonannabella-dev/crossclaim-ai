/**
 * C-0010-B — finance reconciliation（只读差异清单）.
 * ---------------------------------------------------------------
 * Approved scope (MSG-20260928-82, restating MSG-79 Q4):
 *   · sources: `Payment` × `BillingInvoice` × `AuditLog`（Payment HITL 事件）
 *   · output : 差异清单 —— invoiceId / paymentId / amount / currency / status /
 *              differenceType / recommendation（CSV 与 JSON 同源）
 *   · rules  : **不做任何自动修账** —— 差异只出清单 + 审计事实，由 OWNER/ADMIN
 *              人工裁定；本模块**零写入**（不新增 Payment / 不改账单状态）
 *   · roles  : 与 `/payments` 一致（`viewBilling`；FINANCE 只读）
 *
 * 口径：`status` 列是「发票状态|付款状态」（无付款行时为 `NO_PAYMENT`），
 * 例如 `ISSUED|SUCCEEDED`，便于财务在一张表里看清两侧状态。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { PAYMENT_REVIEW_ACTIONS, resolvePaymentReviewState, type PaymentReviewState } from './payment';
import { assertPermission } from './permissions';

export const PAYMENT_DIFFERENCE_TYPES = [
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'AWAITING_PAYMENT_REVIEW',
  'PAYMENT_WITHOUT_PAID_INVOICE',
  'PAID_WITHOUT_PAYMENT',
  'PAID_AMOUNT_MISMATCH',
  'FAILED_PAYMENT',
] as const;

export type PaymentDifferenceType = (typeof PAYMENT_DIFFERENCE_TYPES)[number];

export const RECONCILIATION_CSV_HEADER = [
  'invoiceId',
  'paymentId',
  'amount',
  'currency',
  'status',
  'differenceType',
  'recommendation',
] as const;

export interface PaymentReconciliationItem {
  invoiceId: string;
  invoiceNo: string;
  paymentId: string | null;
  externalPaymentId: string | null;
  amount: string;
  currency: string;
  status: string;
  differenceType: PaymentDifferenceType;
  recommendation: string;
  detectedAt: Date;
}

export interface PaymentReconciliationReport {
  generatedAt: Date;
  scannedInvoices: number;
  items: PaymentReconciliationItem[];
  counts: Record<PaymentDifferenceType, number>;
}

export interface ReconciliationInvoiceFacts {
  invoice: {
    id: string;
    invoiceNo: string;
    status: string;
    total: string;
    paidAmount: string;
    currency: string;
  };
  payments: Array<{
    id: string;
    externalPaymentId: string;
    amount: string;
    currency: string;
    status: string;
  }>;
  reviewState: PaymentReviewState;
}

export interface ReconciliationVerdict {
  differenceType: PaymentDifferenceType;
  recommendation: string;
}

const money = (value: string | InstanceType<typeof Prisma.Decimal>): string =>
  new Prisma.Decimal(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);

/**
 * 单张发票的差异判定（纯函数，便于单测）：返回该发票上的全部差异点，
 * 无差异返回空数组。判定顺序与优先级在文档中固定，不随入参顺序变化。
 */
export function classifyInvoicePayments(facts: ReconciliationInvoiceFacts): ReconciliationVerdict[] {
  const { invoice, payments, reviewState } = facts;
  const verdicts: ReconciliationVerdict[] = [];
  const succeeded = payments.filter((payment) => payment.status === 'SUCCEEDED');

  for (const payment of succeeded) {
    if (money(payment.amount) !== money(invoice.total)) {
      verdicts.push({
        differenceType: 'AMOUNT_MISMATCH',
        recommendation: 'confirm_received_amount_against_invoice_total_before_any_state_change',
      });
      continue;
    }
    if (payment.currency !== invoice.currency) {
      verdicts.push({
        differenceType: 'CURRENCY_MISMATCH',
        recommendation: 'confirm_settlement_currency_with_the_provider',
      });
      continue;
    }
    if (invoice.status === 'PAID') continue;
    if (reviewState === 'PENDING') {
      verdicts.push({
        differenceType: 'AWAITING_PAYMENT_REVIEW',
        recommendation: 'owner_or_admin_must_approve_the_payment_review_before_PAID',
      });
      continue;
    }
    verdicts.push({
      differenceType: 'PAYMENT_WITHOUT_PAID_INVOICE',
      recommendation:
        reviewState === 'REJECTED'
          ? 'payment_review_was_rejected_review_the_invoice_before_retrying_PAID'
          : 'invoice_did_not_reach_PAID_check_the_billing_state_machine',
    });
  }

  if (invoice.status === 'PAID') {
    if (succeeded.length === 0) {
      verdicts.push({
        differenceType: 'PAID_WITHOUT_PAYMENT',
        recommendation: 'attach_the_bank_or_manual_reference_to_a_Payment_record',
      });
    } else {
      const received = succeeded.reduce((sum, payment) => sum.plus(new Prisma.Decimal(payment.amount)), new Prisma.Decimal(0));
      if (money(received) !== money(invoice.paidAmount)) {
        verdicts.push({
          differenceType: 'PAID_AMOUNT_MISMATCH',
          recommendation: 'paidAmount_does_not_equal_the_sum_of_succeeded_payments',
        });
      }
    }
  }

  for (const payment of payments) {
    if (payment.status !== 'FAILED') continue;
    verdicts.push({
      differenceType: 'FAILED_PAYMENT',
      recommendation: 'no_action_required_unless_the_client_was_charged_provider_side',
    });
  }

  return verdicts;
}

export async function listPaymentReconciliation(
  prisma: PrismaClient,
  actor: { organizationId: string; role: string },
  deps: { now?: () => Date; limit?: number } = {},
): Promise<PaymentReconciliationReport> {
  assertPermission(actor.role, 'viewBilling');
  const generatedAt = (deps.now ?? (() => new Date()))();
  const take = Math.min(Math.max(deps.limit ?? 200, 1), 500);

  const invoices = await prisma.billingInvoice.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      invoiceNo: true,
      status: true,
      total: true,
      paidAmount: true,
      currency: true,
      payments: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, externalPaymentId: true, amount: true, currency: true, status: true },
      },
    },
  });

  // 只有在「付款成功但发票还没 PAID」时才需要 Payment HITL 的推导状态
  const needsReviewState = invoices
    .filter(
      (invoice) =>
        invoice.status !== 'PAID' &&
        (invoice.payments ?? []).some((payment) => payment.status === 'SUCCEEDED'),
    )
    .map((invoice) => invoice.id);

  const reviewEvents = needsReviewState.length
    ? await prisma.auditLog.findMany({
        where: {
          organizationId: actor.organizationId,
          entityType: 'BillingInvoice',
          entityId: { in: needsReviewState },
          action: {
            in: [
              PAYMENT_REVIEW_ACTIONS.required,
              PAYMENT_REVIEW_ACTIONS.approved,
              PAYMENT_REVIEW_ACTIONS.rejected,
            ],
          },
        },
        orderBy: { createdAt: 'asc' },
        select: { entityId: true, action: true, createdAt: true },
      })
    : [];

  const reviewStateByInvoice = new Map<string, PaymentReviewState>();
  for (const invoiceId of needsReviewState) {
    const events = reviewEvents
      .filter((event) => event.entityId === invoiceId)
      .map((event) => ({ action: event.action, createdAt: event.createdAt }));
    reviewStateByInvoice.set(invoiceId, resolvePaymentReviewState(events));
  }

  const items: PaymentReconciliationItem[] = [];
  for (const invoice of invoices) {
    const payments = invoice.payments ?? [];
    const facts: ReconciliationInvoiceFacts = {
      invoice: {
        id: invoice.id,
        invoiceNo: invoice.invoiceNo,
        status: invoice.status,
        total: invoice.total.toFixed(4),
        paidAmount: invoice.paidAmount.toFixed(4),
        currency: invoice.currency,
      },
      payments: payments.map((payment) => ({
        id: payment.id,
        externalPaymentId: payment.externalPaymentId,
        amount: payment.amount.toFixed(4),
        currency: payment.currency,
        status: payment.status,
      })),
      reviewState: reviewStateByInvoice.get(invoice.id) ?? 'NOT_REQUIRED',
    };

    const verdicts = classifyInvoicePayments(facts);
    verdicts.forEach((verdict, index) => {
      // 逐条差异归属到具体付款行；纯发票级差异（PAID_WITHOUT_PAYMENT）挂在发票上
      const succeeded = facts.payments.filter((payment) => payment.status === 'SUCCEEDED');
      const failed = facts.payments.filter((payment) => payment.status === 'FAILED');
      const attributed =
        verdict.differenceType === 'FAILED_PAYMENT'
          ? (failed[Math.max(failed.length - 1 - index, 0)] ?? null)
          : verdict.differenceType === 'PAID_WITHOUT_PAYMENT'
            ? null
            : (succeeded[Math.min(index, Math.max(succeeded.length - 1, 0))] ?? null);
      const amount = attributed
        ? attributed.amount
        : money(facts.invoice.status === 'PAID' ? facts.invoice.paidAmount : facts.invoice.total);
      items.push({
        invoiceId: invoice.id,
        invoiceNo: invoice.invoiceNo,
        paymentId: attributed?.id ?? null,
        externalPaymentId: attributed?.externalPaymentId ?? null,
        amount,
        currency: attributed?.currency ?? invoice.currency,
        status: `${invoice.status}|${attributed?.status ?? 'NO_PAYMENT'}`,
        differenceType: verdict.differenceType,
        recommendation: verdict.recommendation,
        detectedAt: generatedAt,
      });
    });
  }

  items.sort((a, b) => {
    if (a.differenceType !== b.differenceType) return a.differenceType < b.differenceType ? -1 : 1;
    if (a.invoiceId !== b.invoiceId) return a.invoiceId < b.invoiceId ? -1 : 1;
    return (a.paymentId ?? '') < (b.paymentId ?? '') ? -1 : 1;
  });

  const counts = Object.fromEntries(PAYMENT_DIFFERENCE_TYPES.map((type) => [type, 0])) as Record<
    PaymentDifferenceType,
    number
  >;
  for (const item of items) counts[item.differenceType] += 1;

  return { generatedAt, scannedInvoices: invoices.length, items, counts };
}

/** 与洞察导出同一套转义规则：全部加引号，内部引号翻倍。 */
export function toReconciliationCsv(report: PaymentReconciliationReport): string {
  const lines = [RECONCILIATION_CSV_HEADER.join(',')];
  for (const item of report.items) {
    lines.push(
      [
        item.invoiceId,
        item.paymentId ?? '',
        item.amount,
        item.currency,
        item.status,
        item.differenceType,
        item.recommendation,
      ]
        .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
        .join(','),
    );
  }
  return lines.join('\n');
}
