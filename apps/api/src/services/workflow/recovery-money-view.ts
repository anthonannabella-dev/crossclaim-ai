/**
 * TRACK A / PC-05 — RECOVERED MONEY VISIBILITY（customer-visible financial read projection）.
 * ---------------------------------------------------------------
 * 授权：MSG-20261003-86 ⑥（PC-05 RECOVERED MONEY VISIBILITY）。
 *
 * 冻结规则：
 *   1. 这是 MONEY VISIBILITY，不是 MONEY MOVEMENT：只读投影，不做 payment / collection /
 *      payout / PSP / FX / R46 重构 / account lineage 变更。
 *   2. 多币种安全：一律按 currency 分组，**不做**跨币种相加，也**不做** FX 换算。
 *   3. EXPECTED ≠ RECEIVED：EXPECTED 只进入 expected；到账金额（recovered）**只来自 RecoveryPayout**
 *      （CHANGE D）；DISPUTED 单独计数，
 *      不得当作「已安全追回」；VOID 从净额中排除；REVERSAL 冲减 netRecovered。
 *   4. Fee：区分 fee calculated（BillingInvoice.total）与 fee actually collected
 *      （BillingInvoice.paidAmount）；当前 collection = OFF → 恒定 `NOT_ENABLED`，不得假装已扣款。
 *   5. 只读、tenant-scoped；不返回 secret / payment credential 字段。
 *
 * 边界：NO platform write · Payment = 0 · autoplay = OFF · collection = OFF · R13 HOLD · TRANSPORT=false。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

export type MoneyStatus =
  | 'DISCOVERED'
  | 'IN_PROGRESS'
  | 'APPROVED'
  | 'PARTIALLY_RECOVERED'
  | 'RECOVERED'
  | 'DISPUTED'
  | 'REVERSED';

export const MONEY_STATUS_LABEL: Record<MoneyStatus, string> = {
  DISCOVERED: '已发现',
  IN_PROGRESS: '追回中',
  APPROVED: '已获批',
  PARTIALLY_RECOVERED: '部分已追回',
  RECOVERED: '已追回',
  DISPUTED: '有争议',
  REVERSED: '已冲回',
};

/** 客户 collection 状态：当前 collection = OFF，恒定 NOT_ENABLED。 */
export const COLLECTION_STATE = 'NOT_ENABLED' as const;

export interface CurrencyBucket {
  currency: string;
  discovered: string;
  expected: string;
  claimed: string;
  approved: string;
  recovered: string;
  disputed: string;
  adjustments: string;
  netRecovered: string;
  outstanding: string;
  feeCalculated: string;
  feeCollected: string;
}

export interface CaseMoneyView {
  caseId: string;
  caseNo: string;
  title: string;
  status: MoneyStatus;
  statusLabel: string;
  currency: string;
  /** PC-05 REVISE：金额一律按事实币种分桶；不做跨币种相加。 */
  byCurrency: CurrencyBucket[];
  /** case 自身币种的 bucket（若该币种无事实则为 null）。 */
  primaryBucket: CurrencyBucket | null;
  timeline: {
    discoveredAt: string | null;
    submittedAt: string | null;
    approvedAt: string | null;
    receivedAt: string | null;
  };
  lineage: { claimItems: number; settlements: number; ledgerEntries: number; adjustments: number };
}

export interface RecoveryMoneyView {
  organization: {
    byCurrency: CurrencyBucket[];
    collection: typeof COLLECTION_STATE;
    payment: 'ZERO' ;
  };
  cases: CaseMoneyView[];
  feeNote: string;
}

const ZERO = new Prisma.Decimal(0);
const money = (value: InstanceType<typeof Prisma.Decimal>): string =>
  value.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);

interface BucketAccumulator {
  discovered: InstanceType<typeof Prisma.Decimal>;
  expected: InstanceType<typeof Prisma.Decimal>;
  claimed: InstanceType<typeof Prisma.Decimal>;
  approved: InstanceType<typeof Prisma.Decimal>;
  recovered: InstanceType<typeof Prisma.Decimal>;
  disputed: InstanceType<typeof Prisma.Decimal>;
  adjustments: InstanceType<typeof Prisma.Decimal>;
  feeCalculated: InstanceType<typeof Prisma.Decimal>;
  feeCollected: InstanceType<typeof Prisma.Decimal>;
}

const newBucket = (): BucketAccumulator => ({
  discovered: ZERO,
  expected: ZERO,
  claimed: ZERO,
  approved: ZERO,
  recovered: ZERO,
  disputed: ZERO,
  adjustments: ZERO,
  feeCalculated: ZERO,
  feeCollected: ZERO,
});

function finalizeBucket(currency: string, bucket: BucketAccumulator): CurrencyBucket {
  const netRecovered = bucket.recovered.minus(bucket.adjustments);
  const outstanding = Prisma.Decimal.max(bucket.approved.minus(netRecovered), ZERO);
  return {
    currency,
    discovered: money(bucket.discovered),
    expected: money(bucket.expected),
    claimed: money(bucket.claimed),
    approved: money(bucket.approved),
    recovered: money(bucket.recovered),
    disputed: money(bucket.disputed),
    adjustments: money(bucket.adjustments),
    netRecovered: money(netRecovered),
    outstanding: money(outstanding),
    feeCalculated: money(bucket.feeCalculated),
    feeCollected: money(bucket.feeCollected),
  };
}

function deriveMoneyStatus(input: {
  recovered: InstanceType<typeof Prisma.Decimal>;
  disputed: InstanceType<typeof Prisma.Decimal>;
  adjustments: InstanceType<typeof Prisma.Decimal>;
  approved: InstanceType<typeof Prisma.Decimal>;
  claimed: InstanceType<typeof Prisma.Decimal>;
  hasDiscovered: boolean;
  hasSubmission: boolean;
}): MoneyStatus {
  const net = input.recovered.minus(input.adjustments);
  if (input.disputed.greaterThan(ZERO)) return 'DISPUTED';
  if (input.adjustments.greaterThan(ZERO) && net.lessThanOrEqualTo(ZERO)) return 'REVERSED';
  if (input.recovered.greaterThan(ZERO)) {
    const outstanding = input.approved.minus(net);
    return outstanding.lessThanOrEqualTo(ZERO) ? 'RECOVERED' : 'PARTIALLY_RECOVERED';
  }
  if (input.approved.greaterThan(ZERO)) return 'APPROVED';
  if (input.claimed.greaterThan(ZERO) || input.hasSubmission) return 'IN_PROGRESS';
  return input.hasDiscovered ? 'DISCOVERED' : 'IN_PROGRESS';
}

export interface RecoveryMoneyActor {
  organizationId: string;
  actorUserId: string;
  role: string;
}

export async function getRecoveryMoneyView(
  prisma: PrismaClient,
  actor: RecoveryMoneyActor,
  options: { caseId?: string } = {},
): Promise<RecoveryMoneyView> {
  // 与账单/金额读取同一权限口径（OWNER / ADMIN / OPS / FINANCE 可见金额；VIEWER 不可）。
  assertPermission(actor.role, 'viewBilling');

  const cases = await prisma.case.findMany({
    where: { organizationId: actor.organizationId, ...(options.caseId ? { id: options.caseId } : {}) },
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    take: options.caseId ? 1 : 100,
    select: {
      id: true,
      caseNo: true,
      title: true,
      currency: true,
      status: true,
      openedAt: true,
      claimItems: {
        select: {
          id: true,
          status: true,
          currency: true,
          recoverableAmount: true,
          closedReason: true,
          occurredAt: true,
          /** PC-05 FINAL-2 CHANGE C：唯一可用作 approvedAt 的真实 outcome 时间。 */
          closedAt: true,
        },
      },
      settlements: {
        select: {
          id: true,
          status: true,
          confirmationStatus: true,
          reconciliationStatus: true,
          reversedBySettlementId: true,
          amount: true,
          currency: true,
          receivedAt: true,
          /** PC-05 FINAL-2 CHANGE D：到账事实的唯一来源。 */
          payouts: { select: { id: true, amount: true, currency: true, receivedAt: true } },
        },
      },
      ledgerEntries: { select: { id: true, amount: true, currency: true, occurredAt: true } },
      billingInvoices: {
        select: { id: true, status: true, total: true, paidAmount: true, currency: true, invoiceNo: true },
      },
    },
  });
  if (options.caseId && cases.length === 0) {
    throw new WorkflowError('NOT_FOUND', '案件不存在或不属于该租户');
  }

  const caseIds = cases.map((row) => row.id);
  const adjustments = caseIds.length
    ? await prisma.settlementAdjustment.findMany({
        where: {
          organizationId: actor.organizationId,
          originalSettlement: { caseId: { in: caseIds } },
        },
        select: { id: true, amount: true, currency: true, adjustmentKind: true, originalSettlementId: true },
      })
    : [];
  const adjustmentsBySettlement = new Map<string, typeof adjustments>();
  // PC-05 ③：submittedAt 必须来自真实人工提交事实，不得由 claim item 状态猜测。
  const submissions = caseIds.length
    ? await prisma.recoveryManualSubmission.findMany({
        where: { organizationId: actor.organizationId, caseId: { in: caseIds } },
        select: { caseId: true, submittedAt: true },
      })
    : [];
  const submittedAtByCase = new Map<string, Date>();
  for (const submission of submissions) {
    const current = submittedAtByCase.get(submission.caseId);
    if (!current || submission.submittedAt < current) {
      submittedAtByCase.set(submission.caseId, submission.submittedAt);
    }
  }
  for (const adjustment of adjustments) {
    const list = adjustmentsBySettlement.get(adjustment.originalSettlementId) ?? [];
    list.push(adjustment);
    adjustmentsBySettlement.set(adjustment.originalSettlementId, list);
  }

  const orgBuckets = new Map<string, BucketAccumulator>();
  const caseViews: CaseMoneyView[] = [];

  for (const row of cases) {
    // PC-05 REVISE（MSG-20261003-87）：每个 case 维护「按事实币种」的 bucket 集合，
    // Settlement / Adjustment / Invoice / ClaimItem 都按各自 currency 落入各自 bucket，
    // 绝不允许把不同币种金额加进同一个 bucket。
    const caseBuckets = new Map<string, BucketAccumulator>();
    const bucketOf = (currency: string): BucketAccumulator => {
      const existing = caseBuckets.get(currency);
      if (existing) return existing;
      const created = newBucket();
      caseBuckets.set(currency, created);
      return created;
    };
    const addToOrg = (currency: string, source: BucketAccumulator): void => {
      const target = orgBuckets.get(currency) ?? newBucket();
      target.discovered = target.discovered.plus(source.discovered);
      target.expected = target.expected.plus(source.expected);
      target.claimed = target.claimed.plus(source.claimed);
      target.approved = target.approved.plus(source.approved);
      target.recovered = target.recovered.plus(source.recovered);
      target.disputed = target.disputed.plus(source.disputed);
      target.adjustments = target.adjustments.plus(source.adjustments);
      target.feeCalculated = target.feeCalculated.plus(source.feeCalculated);
      target.feeCollected = target.feeCollected.plus(source.feeCollected);
      orgBuckets.set(currency, target);
    };

    let hasSubmission = false;
    let discoveredAt: Date | null = null;
    const submittedAt: Date | null = submittedAtByCase.get(row.id) ?? null;
    let approvedAt: Date | null = null;
    let receivedAt: Date | null = null;

    for (const item of row.claimItems) {
      const recoverable = item.recoverableAmount ?? ZERO;
      const bucket = bucketOf(item.currency); // 事实自身币种
      bucket.discovered = bucket.discovered.plus(recoverable);
      if (item.status === 'SUBMITTED_MANUAL') {
        bucket.claimed = bucket.claimed.plus(recoverable);
        hasSubmission = true;
      }
      // CHANGE B（MSG-20261003-88）：approved 只来自真实 approved·recovered outcome；
      // SUBMITTED_MANUAL / CLOSED(REJECTED | NOT_WORTH_PURSUING | CUSTOMER_DECLINED) 一律不计。
      const isRecoveredOutcome =
        item.status === 'RECOVERED' ||
        (item.status === 'CLOSED' && item.closedReason === 'RECOVERED');
      if (isRecoveredOutcome) {
        bucket.approved = bucket.approved.plus(recoverable);
        // CHANGE C：approvedAt 只接受真实 persisted outcome 时间；无则为 null（不得用 occurredAt 顶替）。
        if (item.closedAt && (!approvedAt || item.closedAt < approvedAt)) approvedAt = item.closedAt;
      }
      if (!discoveredAt || item.occurredAt < discoveredAt) discoveredAt = item.occurredAt;
    }

    for (const settlement of row.settlements) {
      // CHANGE D（MSG-20261003-88）：Settlement 只提供 expected / disputed / reconciliation context；
      // 到账金额一律来自 RecoveryPayout，绝不再用 Settlement.amount 代表「已收到钱」。
      const contextBucket = bucketOf(settlement.currency);
      if (settlement.status === 'EXPECTED') {
        contextBucket.expected = contextBucket.expected.plus(settlement.amount);
      } else if (settlement.status === 'DISPUTED' || settlement.reconciliationStatus === 'DISPUTED') {
        contextBucket.disputed = contextBucket.disputed.plus(settlement.amount);
      }
      // CHANGE E：历史 payout 永不因 reconciliationStatus=REVERSED 而被抹掉（gross 历史保留）。
      for (const payout of settlement.payouts) {
        const payoutBucket = bucketOf(payout.currency);
        payoutBucket.recovered = payoutBucket.recovered.plus(payout.amount);
        if (payout.receivedAt && (!receivedAt || payout.receivedAt < receivedAt)) {
          receivedAt = payout.receivedAt;
        }
      }
    }

    // REVERSAL / CORRECTION 冲减净额（v1 只有 REVERSAL 生效于 net；VOID 语义为原计算不存在）
    for (const settlement of row.settlements) {
      for (const adjustment of adjustmentsBySettlement.get(settlement.id) ?? []) {
        if (adjustment.adjustmentKind === 'REVERSAL') {
          const bucket = bucketOf(adjustment.currency); // 事实自身币种
          bucket.adjustments = bucket.adjustments.plus(adjustment.amount);
        }
      }
    }

    for (const invoice of row.billingInvoices) {
      if (invoice.status === 'VOID') continue;
      const bucket = bucketOf(invoice.currency); // 事实自身币种
      bucket.feeCalculated = bucket.feeCalculated.plus(invoice.total);
      bucket.feeCollected = bucket.feeCollected.plus(invoice.paidAmount); // 当前恒为 0
    }

    for (const [currency, bucket] of caseBuckets) addToOrg(currency, bucket);

    const currencyKeys = [...caseBuckets.keys()].sort();
    const primaryKey = caseBuckets.has(row.currency) ? row.currency : currencyKeys[0];
    const primary = primaryKey ? (caseBuckets.get(primaryKey) as BucketAccumulator) : null;
    const statusSource = primary ?? newBucket();
    const status = deriveMoneyStatus({
      recovered: statusSource.recovered, // gross：历史 payout 合计
      disputed: statusSource.disputed,
      adjustments: statusSource.adjustments,
      approved: statusSource.approved,
      claimed: statusSource.claimed,
      hasDiscovered: row.claimItems.length > 0,
      hasSubmission,
    });

    caseViews.push({
      caseId: row.id,
      caseNo: row.caseNo,
      title: row.title,
      status,
      statusLabel: MONEY_STATUS_LABEL[status],
      currency: row.currency,
      byCurrency: currencyKeys.map((key) => finalizeBucket(key, caseBuckets.get(key) as BucketAccumulator)),
      primaryBucket: primary ? finalizeBucket(primaryKey as string, primary) : null,
      timeline: {
        discoveredAt: discoveredAt ? discoveredAt.toISOString() : null,
        submittedAt: submittedAt ? submittedAt.toISOString() : null,
        approvedAt: approvedAt ? approvedAt.toISOString() : null,
        receivedAt: receivedAt ? receivedAt.toISOString() : null,
      },
      lineage: {
        claimItems: row.claimItems.length,
        settlements: row.settlements.length,
        ledgerEntries: row.ledgerEntries.length,
        adjustments: row.settlements.reduce(
          (total, settlement) => total + (adjustmentsBySettlement.get(settlement.id)?.length ?? 0),
          0,
        ),
      },
    });
  }

  return {
    organization: {
      byCurrency: [...orgBuckets.entries()].map(([currency, bucket]) => finalizeBucket(currency, bucket)),
      collection: COLLECTION_STATE,
      payment: 'ZERO',
    },
    cases: caseViews,
    feeNote:
      'feeCalculated = 已计算的成功费；feeCollected = 实际已收取。当前 collection = NOT_ENABLED（Payment = 0），因此 feeCollected 恒为 0，不代表已扣款。',
  };
}
