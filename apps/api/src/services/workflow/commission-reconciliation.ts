/**
 * C-0009 Commission Reconciliation — matching engine + billing suggestion.
 * ---------------------------------------------------------------
 * Approved design (MSG-20260928-74) and plan (MSG-20260928-75):
 *   · match only by `payoutReference` OR `platformOrderId` — a time window
 *     alone NEVER matches (it may only explain/attenuate a candidate);
 *   · explanation is a **rule reason string** ("matched by exact payoutReference"),
 *     never an AI/LLM confidence score;
 *   · result carries TWO layers: `reconciliationStatus` (match outcome) and
 *     `billingStatus` (what happened to billing) — MATCHED ≠ billed;
 *   · `reconciled ≠ paid`: nothing here marks an invoice PAID, touches
 *     Settlement, or moves money;
 *   · dry-run is the default: no writes unless explicitly disabled;
 *   · idempotent: duplicate items in the request are ignored; a case already
 *     billed for the same payout reference is reported as ALREADY_CHARGED;
 *   · no Schema change, no payment dependency, no webhook, no refund reversal.
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import { billingInvoiceNoFor } from '../recovery';
import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

const MONEY_SCALE = 4;
const DECIMAL_STRING_RE = /^\d+(\.\d+)?$/;
export const TIME_WINDOW_DAYS = 14;

export type ReconciliationStatus =
  | 'MATCHED'
  | 'AMBIGUOUS'
  | 'UNMATCHED'
  | 'DUPLICATE_IGNORED'
  | 'ALREADY_CHARGED';

export type BillingStatus = 'NOT_APPLICABLE' | 'DRAFT_CREATED' | 'ALREADY_BILLED' | 'FAILED';

export type MatchType = 'PAYOUT_REFERENCE' | 'ORDER_ID' | 'MANUAL_REVIEW';

export interface PayoutItemInput {
  payoutReference?: unknown;
  platformOrderId?: unknown;
  amount?: unknown;
  currency?: unknown;
  payoutDate?: unknown;
}

export interface NormalizedPayoutItem {
  payoutReference: string;
  platformOrderId: string;
  amount: string;
  currency: string;
  payoutDate: Date;
  dedupeKey: string;
}

export interface ReconciliationResult {
  payoutReference: string;
  platformOrderId: string;
  amount: string;
  currency: string;
  reconciliationStatus: ReconciliationStatus;
  billingStatus: BillingStatus;
  matchType: MatchType;
  matchedFields: string[];
  /** 规则解释（例如 "matched by exact payoutReference"）；绝不是 AI 置信度。 */
  confidenceReason: string;
  caseId: string | null;
  settlementId: string | null;
  feeAmount: string | null;
  billingInvoiceId: string | null;
}

const money = (value: string | InstanceType<typeof Prisma.Decimal>): string =>
  new Prisma.Decimal(value).toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP).toFixed(MONEY_SCALE);

export function normalizePayoutItem(input: PayoutItemInput): NormalizedPayoutItem {
  const payoutReference = typeof input.payoutReference === 'string' ? input.payoutReference.trim() : '';
  const platformOrderId = typeof input.platformOrderId === 'string' ? input.platformOrderId.trim() : '';
  const rawAmount = typeof input.amount === 'string' ? input.amount.trim() : '';
  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '';

  if (payoutReference === '' && platformOrderId === '') {
    throw new WorkflowError('INVALID_INPUT', 'payoutReference 与 platformOrderId 至少要有一个');
  }
  if (!DECIMAL_STRING_RE.test(rawAmount)) {
    throw new WorkflowError('INVALID_INPUT', 'amount 必须是十进制字符串');
  }
  const amount = new Prisma.Decimal(rawAmount);
  if (!amount.gt(0)) throw new WorkflowError('INVALID_INPUT', 'amount 必须 > 0');
  if (!/^[A-Z]{3}$/.test(currency)) throw new WorkflowError('INVALID_INPUT', 'currency 必须是 3 位大写代码');

  const payoutDateRaw = typeof input.payoutDate === 'string' ? input.payoutDate.trim() : '';
  const payoutDate = payoutDateRaw === '' ? new Date() : new Date(payoutDateRaw);
  if (Number.isNaN(payoutDate.getTime())) {
    throw new WorkflowError('INVALID_INPUT', 'payoutDate 不是合法日期');
  }

  const dedupeKey = [
    payoutReference,
    platformOrderId,
    money(amount),
    currency,
    payoutDate.toISOString().slice(0, 10),
  ].join('|');

  return {
    payoutReference,
    platformOrderId,
    amount: money(amount),
    currency,
    payoutDate,
    dedupeKey,
  };
}

export interface ReconcileDeps {
  now?: () => Date;
}

export interface ReconcileInput {
  organizationId: string;
  actorUserId: string;
  role: string;
  items: PayoutItemInput[];
  /** 默认 true：只匹配与计算，不写任何数据。 */
  dryRun?: boolean;
}

export interface ReconcileSummary {
  dryRun: boolean;
  results: ReconciliationResult[];
}

export async function reconcilePayoutItems(
  prisma: PrismaClient,
  input: ReconcileInput,
  deps: ReconcileDeps = {},
): Promise<ReconcileSummary> {
  // 执行对账与 AMBIGUOUS 裁定都只允许 OWNER / ADMIN（FINANCE 只读）
  assertPermission(input.role, 'setCommercialTerms');
  assertPermission(input.role, 'advanceBilling');

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new WorkflowError('INVALID_INPUT', 'items 不能为空');
  }
  if (input.items.length > 500) {
    throw new WorkflowError('INVALID_INPUT', '单次最多 500 条');
  }
  const dryRun = input.dryRun !== false;
  const at = (deps.now ?? (() => new Date()))();

  // 案件与已确认回收（本轮匹配范围：本租户 RECEIVED 的 Settlement）
  const settlements = await prisma.settlement.findMany({
    where: { organizationId: input.organizationId, status: 'RECEIVED' },
    select: {
      id: true,
      caseId: true,
      amount: true,
      currency: true,
      receivedAt: true,
      note: true,
      case: { select: { id: true, caseNo: true, currency: true, status: true } },
    },
  });
  const billedByCase = new Map<string, string>();
  const invoices = await prisma.billingInvoice.findMany({
    where: { organizationId: input.organizationId, caseId: { not: null } },
    select: { id: true, caseId: true, status: true },
  });
  for (const invoice of invoices) {
    if (invoice.caseId) billedByCase.set(invoice.caseId, invoice.id);
  }

  const results: ReconciliationResult[] = [];
  const seen = new Set<string>();

  for (const rawItem of input.items) {
    const item = normalizePayoutItem(rawItem);
    const base: ReconciliationResult = {
      payoutReference: item.payoutReference,
      platformOrderId: item.platformOrderId,
      amount: item.amount,
      currency: item.currency,
      reconciliationStatus: 'UNMATCHED',
      billingStatus: 'NOT_APPLICABLE',
      matchType: 'MANUAL_REVIEW',
      matchedFields: [],
      confidenceReason: '',
      caseId: null,
      settlementId: null,
      feeAmount: null,
      billingInvoiceId: null,
    };

    // 幂等：同一批内重复条目
    if (seen.has(item.dedupeKey)) {
      results.push({
        ...base,
        reconciliationStatus: 'DUPLICATE_IGNORED',
        confidenceReason: 'duplicate item in the same request (dedupeKey match)',
      });
      continue;
    }
    seen.add(item.dedupeKey);

    // 匹配：payoutReference 优先，其次 platformOrderId（仅时间窗不匹配）
    const byReference = item.payoutReference
      ? settlements.filter((row) => (row.note ?? '').includes(item.payoutReference))
      : [];
    const byOrder = item.platformOrderId
      ? settlements.filter((row) => (row.case?.caseNo ?? '').includes(item.platformOrderId))
      : [];
    const candidates = byReference.length > 0 ? byReference : byOrder;
    const matchType: MatchType = byReference.length > 0 ? 'PAYOUT_REFERENCE' : byOrder.length > 0 ? 'ORDER_ID' : 'MANUAL_REVIEW';
    const matchedFields =
      matchType === 'PAYOUT_REFERENCE'
        ? ['payoutReference']
        : matchType === 'ORDER_ID'
          ? ['platformOrderId']
          : [];

    if (candidates.length === 0) {
      results.push({
        ...base,
        confidenceReason: 'no settlement matched by payoutReference or platformOrderId (time window alone never matches)',
      });
      continue;
    }
    if (candidates.length > 1) {
      results.push({
        ...base,
        reconciliationStatus: 'AMBIGUOUS',
        matchType,
        matchedFields,
        confidenceReason: `${candidates.length} settlements matched by ${matchedFields.join('+')} — manual review required`,
      });
      continue;
    }

    const settlement = candidates[0];
    const amountMatches = money(settlement.amount) === item.amount;
    const currencyMatches = settlement.currency === item.currency;
    const dayDistance = settlement.receivedAt
      ? Math.abs(settlement.receivedAt.getTime() - item.payoutDate.getTime()) / 86_400_000
      : Number.POSITIVE_INFINITY;

    if (!amountMatches || !currencyMatches) {
      results.push({
        ...base,
        reconciliationStatus: 'AMBIGUOUS',
        matchType,
        matchedFields: [...matchedFields, ...(currencyMatches ? [] : ['currency']), ...(amountMatches ? [] : ['amount'])],
        confidenceReason: `matched by ${matchedFields.join('+')} but ${amountMatches ? '' : 'amount mismatch; '}${currencyMatches ? '' : 'currency mismatch'}`.trim(),
      });
      continue;
    }

    const caseId = settlement.caseId ?? settlement.case?.id ?? null;
    const isWithinWindow = dayDistance <= TIME_WINDOW_DAYS;
    const reasonParts = [`matched by exact ${matchedFields.join('+')}`];
    reasonParts.push(
      isWithinWindow
        ? `within ${TIME_WINDOW_DAYS}-day window`
        : `outside ${TIME_WINDOW_DAYS}-day window (used as explanation only)`,
    );

    const existingInvoice = caseId ? billedByCase.get(caseId) : undefined;
    if (existingInvoice) {
      results.push({
        ...base,
        reconciliationStatus: 'ALREADY_CHARGED',
        billingStatus: 'ALREADY_BILLED',
        matchType,
        matchedFields,
        confidenceReason: `${reasonParts.join('; ')}; a billing invoice already exists for this case`,
        caseId,
        settlementId: settlement.id,
        billingInvoiceId: existingInvoice,
      });
      continue;
    }

    // 费率必须已确认（fail closed，无默认费率）
    const terms = await loadConfirmedTerms(prisma, input.organizationId, caseId);
    const feeAmount = money(new Prisma.Decimal(item.amount).times(new Prisma.Decimal(terms.successFeeRate)));

    if (dryRun) {
      results.push({
        ...base,
        reconciliationStatus: 'MATCHED',
        billingStatus: 'NOT_APPLICABLE',
        matchType,
        matchedFields,
        confidenceReason: `${reasonParts.join('; ')}; dry run — no billing written`,
        caseId,
        settlementId: settlement.id,
        feeAmount,
      });
      continue;
    }

    // 执行：只创建 FeeCalculation + BillingInvoice(DRAFT)；绝不改 Settlement、绝不置 PAID
    const created = await prisma.$transaction(async (tx) => {
      const fee = await tx.feeCalculation.create({
        data: {
          organizationId: input.organizationId,
          settlementId: settlement.id,
          caseId,
          basis: 'RECOVERED_AMOUNT_PCT',
          rate: new Prisma.Decimal(terms.successFeeRate),
          baseAmount: new Prisma.Decimal(item.amount),
          feeAmount: new Prisma.Decimal(feeAmount),
          currency: item.currency,
          computation: {
            settlementId: settlement.id,
            payoutReference: item.payoutReference,
            platformOrderId: item.platformOrderId,
            baseAmount: item.amount,
            rate: terms.successFeeRate,
            feeAmount,
            rounding: { scale: MONEY_SCALE, mode: 'HALF_UP' },
            source: 'commission_reconciliation',
            matchType,
            matchedFields,
          } as Prisma.InputJsonValue,
        },
      });
      const caseNo = settlement.case?.caseNo ?? `CASE-${caseId}`;
      const invoice = await tx.billingInvoice.create({
        data: {
          organizationId: input.organizationId,
          caseId,
          invoiceNo: billingInvoiceNoFor(caseNo),
          status: 'DRAFT',
          subtotal: new Prisma.Decimal(feeAmount),
          taxAmount: new Prisma.Decimal(0),
          total: new Prisma.Decimal(feeAmount),
          currency: item.currency,
          fees: { connect: { id: fee.id } },
        },
      });

      const changes = {
        payoutReference: item.payoutReference,
        platformOrderId: item.platformOrderId,
        amount: item.amount,
        currency: item.currency,
        feeAmount,
        rate: terms.successFeeRate,
        caseId,
        settlementId: settlement.id,
        invoiceNo: invoice.invoiceNo,
        reconciliationStatus: 'MATCHED',
        billingStatus: 'DRAFT_CREATED',
        matchType,
        matchedFields,
        charged: false,
      };
      for (const action of ['commission.calculated', 'commission.charge_created'] as const) {
        const row = prepareAuditInsert(
          {
            organizationId: input.organizationId,
            actorType: 'USER',
            actorUserId: input.actorUserId,
            action,
            entityType: 'BillingInvoice',
            entityId: invoice.id,
            changes,
          },
          { maxStringLength: 512 },
        );
        await tx.auditLog.create({
          data: {
            organizationId: row.organizationId,
            actorType: row.actorType,
            actorUserId: row.actorUserId,
            actorRef: row.actorRef,
            action: row.action,
            entityType: row.entityType,
            entityId: row.entityId,
            changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
            ip: row.ip,
            userAgent: row.userAgent,
            createdAt: at,
          },
        });
      }
      return { feeId: fee.id, invoiceId: invoice.id };
    });

    results.push({
      ...base,
      reconciliationStatus: 'MATCHED',
      billingStatus: 'DRAFT_CREATED',
      matchType,
      matchedFields,
      confidenceReason: reasonParts.join('; '),
      caseId,
      settlementId: settlement.id,
      feeAmount,
      billingInvoiceId: created.invoiceId,
    });
  }

  if (!dryRun) {
    // 异常条目统一留痕（不计费）
    for (const result of results) {
      if (result.reconciliationStatus !== 'UNMATCHED' && result.reconciliationStatus !== 'AMBIGUOUS') continue;
      const row = prepareAuditInsert(
        {
          organizationId: input.organizationId,
          actorType: 'USER',
          actorUserId: input.actorUserId,
          action: 'commission.reconciliation_failed',
          entityType: 'Settlement',
          entityId: result.settlementId ?? 'unmatched',
          changes: {
            payoutReference: result.payoutReference,
            platformOrderId: result.platformOrderId,
            amount: result.amount,
            currency: result.currency,
            reconciliationStatus: result.reconciliationStatus,
            reason: result.confidenceReason,
          },
        },
        { maxStringLength: 512 },
      );
      await prisma.auditLog.create({
        data: {
          organizationId: row.organizationId,
          actorType: row.actorType,
          actorUserId: row.actorUserId,
          actorRef: row.actorRef,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
          ip: row.ip,
          userAgent: row.userAgent,
          createdAt: at,
        },
      });
    }
  }

  return { dryRun, results };
}

interface ConfirmedTerms {
  successFeeRate: string;
  source: string;
}

async function loadConfirmedTerms(
  prisma: PrismaClient,
  organizationId: string,
  caseId: string | null,
): Promise<ConfirmedTerms> {
  if (!caseId) {
    throw new WorkflowError('COMMERCIAL_TERMS_PENDING', '匹配到赔付但无法定位案件，无法计费');
  }
  const confirmed = await prisma.auditLog.findFirst({
    where: { organizationId, entityType: 'Case', entityId: caseId, action: 'commercial_terms.created' },
    orderBy: { createdAt: 'desc' },
    select: { changes: true },
  });
  const changes = (confirmed?.changes ?? null) as Record<string, unknown> | null;
  const successFeeRate = typeof changes?.successFeeRate === 'string' ? changes.successFeeRate : '';
  const source = typeof changes?.source === 'string' ? changes.source : '';
  if (!confirmed || successFeeRate === '') {
    throw new WorkflowError('COMMERCIAL_TERMS_PENDING', '该案件尚未完成商务确认，不能计费');
  }
  return { successFeeRate, source };
}
