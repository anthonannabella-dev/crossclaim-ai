/**
 * RECOVERY CONFIRMATION — 到账事实登记与投影
 * ---------------------------------------------------------------
 * 依据：MSG-20260929-22（RECOVERY-CONFIRMATION-DESIGN = GO；D1–D4 GO / D5 HOLD）
 *       MSG-20260929-24（REVISE：必须拆开确认语义与对账语义、明确历史默认与金额来源）
 *       MSG-20260929-26（RECOVERY-CONFIRMATION-SCHEMA-DELTA R2 = GO / READY_FOR_IMPLEMENTATION）
 *
 * 两条**互不覆盖**的事实轴（MSG-20260929-24 的核心修正）：
 *   · confirmationStatus   —— 业务确认：这笔回收是否已被人工确认为事实
 *   · reconciliationStatus —— 到账对账：钱是否真的到账、到了多少、是否有问题
 *   合法组合示例：CONFIRMED + NOT_STARTED（已确认、但还没到账）。
 *
 * 金额唯一事实来源（对 MSG-20260929-24 C3 的落实）：
 *   confirmedAmount = Settlement.amount              （既有列，不新增金额字段）
 *   receivedAmount  = Σ RecoveryPayout.amount        （读取时投影，**不落库**）
 *   → 不产生第二份金额事实源；投影可随时重算、不会漂移。
 *
 * 明确不做：不自动扣佣（D5 HOLD）、不自动改账单（D3，冲回只留审计与对账状态）、
 * 不接任何支付通道、不发起对外请求、不修改 FeeCalculation / RecoveryLedgerEntry / BillingInvoice。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import type { AuditWriter } from '../audit';
import { WorkflowError } from '../workflow/opportunity-review';
import { assertPermission } from '../workflow/permissions';

const MONEY_SCALE = 4;
const PAYOUT_REF_MAX = 256;
const DECIMAL_STRING_RE = /^\d+(\.\d+)?$/;

/** 到账来源（迁移方案未新增第三个 TYPE，故用服务层白名单约束，禁自由文本扩散） */
export const PAYOUT_SOURCE_TYPES = ['PLATFORM_SETTLEMENT', 'BANK_TRANSFER', 'OTHER'] as const;
export type PayoutSourceType = (typeof PAYOUT_SOURCE_TYPES)[number];

export type ConfirmationStatus = 'CONFIRMED' | 'PENDING_CONFIRMATION' | 'REJECTED_BY_REVIEW';
export type ReconciliationStatus = 'NOT_STARTED' | 'PARTIAL' | 'RECONCILED' | 'DISPUTED' | 'REVERSED';

export const RECOVERY_CONFIRMATION_ACTION = {
  payoutRecorded: 'recovery_payout.recorded',
  payoutDuplicate: 'recovery_payout.duplicate_ignored',
  reconciliationChanged: 'settlement.reconciliation_changed',
  confirmationRecorded: 'settlement.confirmation_recorded',
  reversalLinked: 'settlement.reversal_linked',
} as const;

export interface RecoveryConfirmationDeps {
  prisma: PrismaClient;
  audit: AuditWriter;
  now?: () => Date;
}

export interface ActorInput {
  organizationId: string;
  settlementId: string;
  actorUserId: string;
  role: string;
}

export interface NormalizedPayoutInput {
  payoutRef: string;
  amount: InstanceType<typeof Prisma.Decimal>;
  currency: string;
  receivedAt: Date;
  sourceType: PayoutSourceType;
}

const money = (value: string | InstanceType<typeof Prisma.Decimal>): InstanceType<typeof Prisma.Decimal> =>
  new Prisma.Decimal(value).toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP);

/** 十进制字符串、> 0、4 位小数 HALF_UP（与资金域既有口径一致） */
export function assertMoneyValue(value: unknown, field: string): InstanceType<typeof Prisma.Decimal> {
  if (typeof value !== 'string' || !DECIMAL_STRING_RE.test(value.trim())) {
    throw new WorkflowError('INVALID_INPUT', `${field} 必须是十进制字符串`);
  }
  const amount = new Prisma.Decimal(value.trim());
  if (!amount.gt(0)) {
    throw new WorkflowError('INVALID_INPUT', `${field} 必须 > 0`);
  }
  return money(amount);
}

export function assertPayoutRef(value: unknown): string {
  const ref = typeof value === 'string' ? value.trim() : '';
  if (ref === '') {
    throw new WorkflowError('INVALID_INPUT', 'payoutRef 不能为空（到账必须可追溯到平台/银行引用）');
  }
  if (ref.length > PAYOUT_REF_MAX) {
    throw new WorkflowError('INVALID_INPUT', `payoutRef 不得超过 ${PAYOUT_REF_MAX} 个字符`);
  }
  return ref;
}

export function assertPayoutSourceType(value: unknown): PayoutSourceType {
  const source = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!(PAYOUT_SOURCE_TYPES as readonly string[]).includes(source)) {
    throw new WorkflowError(
      'INVALID_INPUT',
      `sourceType 必须是 ${PAYOUT_SOURCE_TYPES.join(' / ')} 之一`,
    );
  }
  return source as PayoutSourceType;
}

/** 纯函数：录入前归一化 + 校验（离线单测覆盖，不触库） */
export function normalizePayoutInput(input: {
  payoutRef: unknown;
  amount: unknown;
  currency: unknown;
  receivedAt: unknown;
  sourceType: unknown;
}): NormalizedPayoutInput {
  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '';
  if (currency === '' || currency.length > 8) {
    throw new WorkflowError('INVALID_INPUT', 'currency 必填（ISO 4217，大写）');
  }
  if (!(input.receivedAt instanceof Date) || Number.isNaN(input.receivedAt.getTime())) {
    throw new WorkflowError('INVALID_INPUT', 'receivedAt 必须是合法时间');
  }
  return {
    payoutRef: assertPayoutRef(input.payoutRef),
    amount: assertMoneyValue(input.amount, 'amount'),
    currency,
    receivedAt: input.receivedAt,
    sourceType: assertPayoutSourceType(input.sourceType),
  };
}

/**
 * I2/I3/I4：由到账事实推导对账状态（纯函数，唯一的推导入口）。
 *   received == 0                → NOT_STARTED
 *   0 < received < confirmed     → PARTIAL
 *   received == confirmed        → RECONCILED
 *   received >  confirmed        → DISPUTED（不自动改账，D3）
 */
export function reconciliationFromPayouts(
  confirmed: InstanceType<typeof Prisma.Decimal>,
  received: InstanceType<typeof Prisma.Decimal>,
): ReconciliationStatus {
  if (received.lte(0)) return 'NOT_STARTED';
  if (received.gt(confirmed)) return 'DISPUTED';
  if (received.eq(confirmed)) return 'RECONCILED';
  return 'PARTIAL';
}

export interface RecoveryProjection {
  settlementId: string;
  confirmationStatus: ConfirmationStatus;
  /** 落库的对账状态（REVERSED 为终局保留态，不因新到账被覆盖） */
  reconciliationStatus: ReconciliationStatus;
  /** 由到账事实推导的对账状态 */
  derivedReconciliationStatus: ReconciliationStatus;
  confirmedAmount: string;
  receivedAmount: string;
  /** received - confirmed */
  variance: string;
  payoutCount: number;
  /** true = 需要 FINANCE 人工处置（争议或已冲回），系统不自动改账 */
  needsFinanceReview: boolean;
}

/**
 * 读侧投影：确认金额取 Settlement.amount，到账金额取 Σ payouts（不落库）。
 * `reversed` 时保留 REVERSED（I7：冲回是终局，不被后续到账静默覆盖）。
 */
export function projectRecoveryState(input: {
  settlementId: string;
  confirmationStatus: ConfirmationStatus;
  reconciliationStatus: ReconciliationStatus;
  confirmedAmount: string | InstanceType<typeof Prisma.Decimal>;
  payouts: Array<{ amount: string | InstanceType<typeof Prisma.Decimal> }>;
}): RecoveryProjection {
  const confirmed = money(input.confirmedAmount);
  const received = input.payouts.reduce(
    (sum, payout) => sum.plus(money(payout.amount)),
    new Prisma.Decimal(0),
  );
  const derived =
    input.reconciliationStatus === 'REVERSED'
      ? 'REVERSED'
      : reconciliationFromPayouts(confirmed, received);
  return {
    settlementId: input.settlementId,
    confirmationStatus: input.confirmationStatus,
    reconciliationStatus: input.reconciliationStatus,
    derivedReconciliationStatus: derived,
    confirmedAmount: confirmed.toFixed(MONEY_SCALE),
    receivedAmount: received.toFixed(MONEY_SCALE),
    variance: received.minus(confirmed).toFixed(MONEY_SCALE),
    payoutCount: input.payouts.length,
    needsFinanceReview: derived === 'DISPUTED' || derived === 'REVERSED',
  };
}

async function loadSettlement(deps: RecoveryConfirmationDeps, organizationId: string, settlementId: string) {
  const settlement = await deps.prisma.settlement.findFirst({
    where: { id: settlementId, organizationId },
    select: {
      id: true,
      organizationId: true,
      amount: true,
      currency: true,
      confirmationStatus: true,
      reconciliationStatus: true,
      reversedBySettlementId: true,
    },
  });
  if (!settlement) {
    // 跨租户与不存在返回同一错误码：不泄露其他租户是否存在该 Settlement
    throw new WorkflowError('NOT_FOUND', 'Settlement 不存在或不属于该租户');
  }
  return settlement;
}

export interface RecordPayoutInput extends ActorInput {
  payoutRef: unknown;
  amount: unknown;
  currency: unknown;
  receivedAt: unknown;
  sourceType: unknown;
}

export interface RecordPayoutResult {
  settlementId: string;
  payoutId: string;
  /** true = 本次新登记；false = 命中 (organizationId, payoutRef) 幂等，未重复累加 */
  created: boolean;
  receivedAmount: string;
  confirmedAmount: string;
  reconciliationStatus: ReconciliationStatus;
}

/**
 * 登记一笔真实到账（唯一事实来源）。I1/I6 在此实现：
 *   I1 同租户（loadSettlement 按 organizationId 过滤）
 *   I6 (organizationId, payoutRef) 唯一 → 重复登记返回既有事实，不重复累加
 * 权限：MSG-20260929-27 F2 为到账事实录入新增 recoveryPayoutRecord
 *       （OWNER/ADMIN/FINANCE）—— 与 Claim Tracking 的外部事件登记分离。
 *       本函数只登记到账事实，不构成财务确认，也不构成扣款授权（D5 HOLD）。
 */
export async function recordRecoveryPayout(
  input: RecordPayoutInput,
  deps: RecoveryConfirmationDeps,
): Promise<RecordPayoutResult> {
  assertPermission(input.role, 'recoveryPayoutRecord');
  const normalized = normalizePayoutInput(input);
  const at = (deps.now ?? (() => new Date()))();
  const settlement = await loadSettlement(deps, input.organizationId, input.settlementId);

  if (settlement.confirmationStatus === 'REJECTED_BY_REVIEW') {
    throw new WorkflowError('ILLEGAL_TRANSITION', '该 Settlement 已被复核否决，不得再登记到账');
  }
  if (settlement.reconciliationStatus === 'REVERSED' || settlement.reversedBySettlementId) {
    throw new WorkflowError('ILLEGAL_TRANSITION', '该 Settlement 已冲回，不得再登记到账（I7）');
  }
  if (normalized.currency !== settlement.currency) {
    throw new WorkflowError(
      'CURRENCY_MISMATCH',
      `到账币种必须与 Settlement 一致（Settlement ${settlement.currency}，收到 ${normalized.currency}）`,
    );
  }

  // I6 幂等优先：同一 (org, payoutRef) 视为同一次到账事实
  const existing = await deps.prisma.recoveryPayout.findFirst({
    where: { organizationId: input.organizationId, payoutRef: normalized.payoutRef },
    select: { id: true, settlementId: true },
  });
  if (existing) {
    if (existing.settlementId !== settlement.id) {
      throw new WorkflowError('ILLEGAL_TRANSITION', '该 payoutRef 已登记到另一笔 Settlement');
    }
    const projection = await readProjection(deps, input.organizationId, settlement.id);
    await deps.audit.record({
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.actorUserId,
      action: RECOVERY_CONFIRMATION_ACTION.payoutDuplicate,
      entityType: 'RecoveryPayout',
      entityId: existing.id,
      changes: { payoutRef: normalized.payoutRef, settlementId: settlement.id, amount: normalized.amount.toFixed(MONEY_SCALE) },
    });
    return {
      settlementId: settlement.id,
      payoutId: existing.id,
      created: false,
      receivedAmount: projection.receivedAmount,
      confirmedAmount: projection.confirmedAmount,
      // 返回**由到账事实推导**的状态（落库值可能滞后于事实，投影才是对外契约）
      reconciliationStatus: projection.derivedReconciliationStatus,
    };
  }

  const payout = await deps.prisma.recoveryPayout.create({
    data: {
      organizationId: input.organizationId,
      settlementId: settlement.id,
      payoutRef: normalized.payoutRef,
      amount: normalized.amount,
      currency: normalized.currency,
      receivedAt: normalized.receivedAt,
      sourceType: normalized.sourceType,
      createdBy: input.actorUserId,
    },
  });

  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'USER',
    actorUserId: input.actorUserId,
    action: RECOVERY_CONFIRMATION_ACTION.payoutRecorded,
    entityType: 'RecoveryPayout',
    entityId: payout.id,
    changes: {
      settlementId: settlement.id,
      payoutRef: normalized.payoutRef,
      amount: normalized.amount.toFixed(MONEY_SCALE),
      currency: normalized.currency,
      receivedAt: normalized.receivedAt.toISOString(),
      sourceType: normalized.sourceType,
    },
  });

  const projection = await readProjection(deps, input.organizationId, settlement.id);
  await syncReconciliationStatus(input, deps, settlement, projection, at);

  return {
    settlementId: settlement.id,
    payoutId: payout.id,
    created: true,
    receivedAmount: projection.receivedAmount,
    confirmedAmount: projection.confirmedAmount,
    reconciliationStatus: projection.derivedReconciliationStatus,
  };
}

export interface RecoveryProjectionWithPayouts extends RecoveryProjection {
  payouts: Array<{ id: string; payoutRef: string; amount: string; currency: string; receivedAt: string; sourceType: string }>;
}

/** 读侧：Settlement + 到账投影（不落库 receivedAmount） */
export async function readProjection(
  deps: RecoveryConfirmationDeps,
  organizationId: string,
  settlementId: string,
): Promise<RecoveryProjectionWithPayouts> {
  const settlement = await loadSettlement(deps, organizationId, settlementId);
  const payouts = await deps.prisma.recoveryPayout.findMany({
    where: { organizationId, settlementId },
    orderBy: { receivedAt: 'asc' },
    select: { id: true, payoutRef: true, amount: true, currency: true, receivedAt: true, sourceType: true },
  });
  const projection = projectRecoveryState({
    settlementId,
    confirmationStatus: settlement.confirmationStatus,
    reconciliationStatus: settlement.reconciliationStatus,
    confirmedAmount: settlement.amount,
    payouts,
  });
  return {
    ...projection,
    payouts: payouts.map((row) => ({
      id: row.id,
      payoutRef: row.payoutRef,
      amount: money(row.amount).toFixed(MONEY_SCALE),
      currency: row.currency,
      receivedAt: row.receivedAt.toISOString(),
      sourceType: row.sourceType,
    })),
  };
}

/** 把投影结果写回 settlement.reconciliationStatus（CAS，冲突不覆盖并发结果） */
async function syncReconciliationStatus(
  input: ActorInput,
  deps: RecoveryConfirmationDeps,
  settlement: { id: string; reconciliationStatus: ReconciliationStatus },
  projection: RecoveryProjection,
  at: Date,
): Promise<void> {
  const next = projection.derivedReconciliationStatus;
  if (next === settlement.reconciliationStatus) return;

  const updated = await deps.prisma.settlement.updateMany({
    where: {
      id: settlement.id,
      organizationId: input.organizationId,
      reconciliationStatus: settlement.reconciliationStatus,
    },
    data: { reconciliationStatus: next },
  });
  if (updated.count === 0) {
    throw new WorkflowError('ILLEGAL_TRANSITION', 'Settlement 对账状态已变化，请刷新后重试');
  }

  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'USER',
    actorUserId: input.actorUserId,
    action: RECOVERY_CONFIRMATION_ACTION.reconciliationChanged,
    entityType: 'Settlement',
    entityId: settlement.id,
    changes: {
      from: settlement.reconciliationStatus,
      to: next,
      confirmedAmount: projection.confirmedAmount,
      receivedAmount: projection.receivedAmount,
      variance: projection.variance,
      evaluatedAt: at.toISOString(),
    },
  });
}

export interface RecordConfirmationInput extends ActorInput {
  confirmationStatus: ConfirmationStatus;
  note?: string;
}

/**
 * 业务确认（第一轴）：是否被人工确认为事实。R2 要求 OWNER/ADMIN + AuditLog。
 * 与到账（第二轴）完全解耦：CONFIRMED + NOT_STARTED 是合法且常见的状态。
 */
export async function recordRecoveryConfirmation(
  input: RecordConfirmationInput,
  deps: RecoveryConfirmationDeps,
): Promise<{ settlementId: string; confirmationStatus: ConfirmationStatus; changed: boolean }> {
  assertPermission(input.role, 'claimTrackingApprove');
  const settlement = await loadSettlement(deps, input.organizationId, input.settlementId);
  const at = (deps.now ?? (() => new Date()))();
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : '';

  const updated = await deps.prisma.settlement.updateMany({
    where: {
      id: settlement.id,
      organizationId: input.organizationId,
      confirmationStatus: settlement.confirmationStatus,
    },
    data: {
      confirmationStatus: input.confirmationStatus,
      // R2a：人工确认留痕（confirmedAt 复用既有列，避免第二个时间事实源）
      ...(input.confirmationStatus === 'CONFIRMED'
        ? { confirmedByUserId: input.actorUserId, confirmedAt: at }
        : {}),
    },
  });
  if (updated.count === 0) {
    throw new WorkflowError('ILLEGAL_TRANSITION', 'Settlement 确认状态已变化，请刷新后重试');
  }

  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'USER',
    actorUserId: input.actorUserId,
    action: RECOVERY_CONFIRMATION_ACTION.confirmationRecorded,
    entityType: 'Settlement',
    entityId: settlement.id,
    changes: {
      from: settlement.confirmationStatus,
      to: input.confirmationStatus,
      ...(note ? { note } : {}),
    },
  });

  return {
    settlementId: settlement.id,
    confirmationStatus: input.confirmationStatus,
    changed: settlement.confirmationStatus !== input.confirmationStatus,
  };
}

export interface LinkReversalInput extends ActorInput {
  /** 已存在的冲回 Settlement（本函数**不创建**任何资金对象，D3） */
  reversalSettlementId: string;
}

/**
 * R4 冲回链：把原 Settlement 指向冲回 Settlement，并把对账状态置 REVERSED。
 * I7：只改状态与链路，**不改金额**；冲回后的财务处置留给 FINANCE（D3）。
 */
export async function linkReversal(
  input: LinkReversalInput,
  deps: RecoveryConfirmationDeps,
): Promise<{ settlementId: string; reconciliationStatus: 'REVERSED' }> {
  assertPermission(input.role, 'claimTrackingApprove');
  if (input.reversalSettlementId === input.settlementId) {
    throw new WorkflowError('INVALID_INPUT', '冲回 Settlement 不能是原 Settlement 自身');
  }
  const settlement = await loadSettlement(deps, input.organizationId, input.settlementId);
  await loadSettlement(deps, input.organizationId, input.reversalSettlementId);
  if (settlement.reversedBySettlementId) {
    throw new WorkflowError('ILLEGAL_TRANSITION', '该 Settlement 已绑定冲回链（I7 不可重复/不可回退）');
  }

  const updated = await deps.prisma.settlement.updateMany({
    where: {
      id: settlement.id,
      organizationId: input.organizationId,
      reversedBySettlementId: null,
      reconciliationStatus: settlement.reconciliationStatus,
    },
    data: { reversedBySettlementId: input.reversalSettlementId, reconciliationStatus: 'REVERSED' },
  });
  if (updated.count === 0) {
    throw new WorkflowError('ILLEGAL_TRANSITION', 'Settlement 状态已变化，请刷新后重试');
  }

  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'USER',
    actorUserId: input.actorUserId,
    action: RECOVERY_CONFIRMATION_ACTION.reversalLinked,
    entityType: 'Settlement',
    entityId: settlement.id,
    changes: {
      reversalSettlementId: input.reversalSettlementId,
      from: settlement.reconciliationStatus,
      to: 'REVERSED',
      // 金额未被修改 —— 自行留证，便于事后核对（I7）
      confirmedAmount: money(settlement.amount).toFixed(MONEY_SCALE),
    },
  });

  return { settlementId: settlement.id, reconciliationStatus: 'REVERSED' };
}
