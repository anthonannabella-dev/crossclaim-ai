/**
 * C-0012 — Claim 规则引擎审计（**Audit Only**）
 * ---------------------------------------------------------------
 * 架构方裁定（MSG-20260928-122 / -124）：
 *   · 只回答「规则结果可不可解释」：覆盖率 / 残差 / 版本漂移 / 新鲜度
 *   · 残差必须分类：NO_HUMAN_REVIEW | CONFIRMED | ADJUSTED（不许把未复核数据混进分位）
 *   · 版本漂移只读真实历史（ClaimItem → RuleVersion），**禁止重跑旧规则做回测**
 *   · 新鲜度只输出 staleRuleCount + thresholdDays，**不判失效/expired**
 *   · 人工复核只写审计 `claim.recoverable_amount_reviewed`，**绝不修改 ClaimItem.recoverableAmount**
 *   · 写入前必须校验提交的 ruleAmount 与历史规则输出一致，否则 RULE_AMOUNT_MISMATCH
 *   · 「最近一条复核」按 `createdAt DESC, id DESC` 取，允许多次复核、历史只追加
 *   · 三层状态：engineeringStatus / auditRunStatus / commercialConclusion（恒 OPEN）
 */

import { Prisma, PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from './audit-log';
import { WorkflowError } from '../workflow/opportunity-review';
import { assertPermission } from '../workflow/permissions';

export const DEFAULT_STALE_RULE_DAYS = 180;
export const REVIEW_ACTION = 'claim.recoverable_amount_reviewed';
export const REVIEW_DECISIONS = ['CONFIRMED', 'ADJUSTED'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export type ResidualClass = 'NO_HUMAN_REVIEW' | 'CONFIRMED' | 'ADJUSTED';

export const COMMERCIAL_CONCLUSION = 'OPEN' as const;

/**
 * CLI 入口专用：`tools/` 下的脚本不在 apps/api 的依赖解析范围内，
 * 因此由本模块（位于 apps/api 内）负责创建 PrismaClient，避免 CLI 直连 `@prisma/client`。
 */
export function createRuleEngineAuditClient(): PrismaClient {
  return new PrismaClient();
}

const money = (value: Prisma.Decimal | string): string =>
  new Prisma.Decimal(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);

/** 中位数与 P90（绝对值）——纯函数，便于单测。 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentileAbs(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.map((value) => Math.abs(value)).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[index];
}

export interface ClaimItemAuditRow {
  id: string;
  platformType: string;
  claimType: string;
  ruleVersionId: string | null;
  recoverableAmount: string | null;
}

export interface ReviewAuditRow {
  id: string;
  claimItemId: string;
  ruleAmount: string | null;
  toAmount: string | null;
  decision: ReviewDecision | null;
  createdAt: Date;
}

export interface RuleEngineAudit {
  engineeringStatus: 'PASS' | 'FAIL';
  auditRunStatus: 'NOT_RUN' | 'RUN_RECORDED';
  commercialConclusion: typeof COMMERCIAL_CONCLUSION;
  generatedAt: string;
  organizationId: string;
  coverage: { claimItems: number; withRecoverableAmount: number; coverageRate: number };
  residuals: {
    classification: Record<ResidualClass, number>;
    adjusted: { count: number; median: number | null; p90Abs: number | null; absSum: number };
  };
  drift: {
    changedPairs: Array<{
      platformType: string;
      claimType: string;
      fromRuleVersionId: string | null;
      fromAmount: string;
      toRuleVersionId: string | null;
      toAmount: string;
    }>;
  };
  freshness: { staleRuleCount: number; thresholdDays: number };
}

/** 纯函数：把行数据聚合成审计结果（便于单测，不碰数据库）。 */
export function summarizeRuleEngineAudit(input: {
  organizationId: string;
  claimItems: ClaimItemAuditRow[];
  reviews: ReviewAuditRow[];
  staleRuleCount: number;
  thresholdDays?: number;
  now?: () => Date;
}): RuleEngineAudit {
  const thresholdDays = input.thresholdDays ?? DEFAULT_STALE_RULE_DAYS;
  const withAmount = input.claimItems.filter((row) => row.recoverableAmount !== null);

  // 最近一条复核：createdAt DESC, id DESC（MSG-124 REVISE-2）
  const latestByClaim = new Map<string, ReviewAuditRow>();
  for (const review of [...input.reviews].sort((a, b) => {
    const diff = b.createdAt.getTime() - a.createdAt.getTime();
    if (diff !== 0) return diff;
    return a.id < b.id ? 1 : -1;
  })) {
    if (!latestByClaim.has(review.claimItemId)) latestByClaim.set(review.claimItemId, review);
  }

  const classification: Record<ResidualClass, number> = {
    NO_HUMAN_REVIEW: 0,
    CONFIRMED: 0,
    ADJUSTED: 0,
  };
  const residuals: number[] = [];

  for (const item of withAmount) {
    const review = latestByClaim.get(item.id);
    const ruleAmount = new Prisma.Decimal(item.recoverableAmount as string);
    if (!review || review.toAmount === null || review.ruleAmount === null) {
      classification.NO_HUMAN_REVIEW += 1;
      continue;
    }
    const toAmount = new Prisma.Decimal(review.toAmount);
    const residual = toAmount.minus(ruleAmount).toNumber();
    if (residual === 0) {
      classification.CONFIRMED += 1;
    } else {
      classification.ADJUSTED += 1;
      residuals.push(residual);
    }
  }

  // 版本漂移：同一 (platformType, claimType) 在真实历史里出现过不同金额（不重算规则）
  const byType = new Map<string, ClaimItemAuditRow[]>();
  for (const item of withAmount) {
    const key = `${item.platformType}::${item.claimType}`;
    const bucket = byType.get(key) ?? [];
    bucket.push(item);
    byType.set(key, bucket);
  }
  const changedPairs: RuleEngineAudit['drift']['changedPairs'] = [];
  for (const bucket of byType.values()) {
    const distinct = new Map<string, ClaimItemAuditRow>();
    for (const item of bucket) distinct.set(`${item.ruleVersionId ?? 'NONE'}|${item.recoverableAmount}`, item);
    const groups = [...distinct.values()];
    if (groups.length < 2) continue;
    const [first, ...rest] = groups;
    for (const other of rest) {
      changedPairs.push({
        platformType: first.platformType,
        claimType: first.claimType,
        fromRuleVersionId: first.ruleVersionId,
        fromAmount: money(first.recoverableAmount as string),
        toRuleVersionId: other.ruleVersionId,
        toAmount: money(other.recoverableAmount as string),
      });
    }
  }

  const coverageRate =
    input.claimItems.length === 0 ? 0 : Number((withAmount.length / input.claimItems.length).toFixed(4));

  return {
    engineeringStatus: 'PASS',
    auditRunStatus: 'RUN_RECORDED',
    commercialConclusion: COMMERCIAL_CONCLUSION,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    organizationId: input.organizationId,
    coverage: {
      claimItems: input.claimItems.length,
      withRecoverableAmount: withAmount.length,
      coverageRate,
    },
    residuals: {
      classification,
      adjusted: {
        count: residuals.length,
        median: median(residuals),
        p90Abs: percentileAbs(residuals, 90),
        absSum: residuals.reduce((sum, value) => sum + Math.abs(value), 0),
      },
    },
    drift: { changedPairs },
    freshness: { staleRuleCount: input.staleRuleCount, thresholdDays },
  };
}

function readReviewRows(
  rows: Array<{ id: string; changes: unknown; createdAt: Date; entityId: string | null }>,
): ReviewAuditRow[] {
  return rows.map((row) => {
    const changes = (row.changes ?? {}) as Record<string, unknown>;
    const decision = typeof changes.decision === 'string' ? (changes.decision as ReviewDecision) : null;
    return {
      id: row.id,
      claimItemId:
        typeof changes.claimItemId === 'string' ? changes.claimItemId : (row.entityId ?? ''),
      ruleAmount: typeof changes.ruleAmount === 'string' ? changes.ruleAmount : null,
      toAmount: typeof changes.toAmount === 'string' ? changes.toAmount : null,
      decision,
      createdAt: row.createdAt,
    };
  });
}

/** 只读聚合（不写任何表）。 */
export async function buildRuleEngineAudit(
  prisma: PrismaClient,
  input: { organizationId: string; role: string; staleThresholdDays?: number; now?: () => Date },
): Promise<RuleEngineAudit> {
  assertPermission(input.role, 'viewClaimItemSummary');
  const now = (input.now ?? (() => new Date()))();
  const thresholdDays = input.staleThresholdDays ?? DEFAULT_STALE_RULE_DAYS;
  const cutoff = new Date(now.getTime() - thresholdDays * 24 * 60 * 60 * 1000);

  const claimItems = await prisma.claimItem.findMany({
    where: { organizationId: input.organizationId },
    select: { id: true, platformType: true, claimType: true, ruleVersionId: true, recoverableAmount: true },
  });
  const reviewRows = await prisma.auditLog.findMany({
    where: { organizationId: input.organizationId, action: REVIEW_ACTION },
    select: { id: true, changes: true, createdAt: true, entityId: true },
  });
  const staleRuleCount = await prisma.ruleVersion.count({
    where: {
      isActive: true,
      AND: [
        // 租户规则 + 全局规则（organizationId 为空）都算在内
        { OR: [{ organizationId: input.organizationId }, { organizationId: null }] },
        { OR: [{ lastVerified: null }, { lastVerified: { lt: cutoff } }] },
      ],
    },
  });

  return summarizeRuleEngineAudit({
    organizationId: input.organizationId,
    claimItems: claimItems.map((row) => ({
      id: row.id,
      platformType: row.platformType,
      claimType: row.claimType,
      ruleVersionId: row.ruleVersionId,
      recoverableAmount: row.recoverableAmount ? row.recoverableAmount.toFixed(4) : null,
    })),
    reviews: readReviewRows(reviewRows),
    staleRuleCount,
    thresholdDays,
    now: () => now,
  });
}

/** 人读报告（沿用 C-0009.1 的三层状态口径；不得出现商业结论词）。 */
export function renderRuleEngineAuditMarkdown(audit: RuleEngineAudit): string {
  const lines = [
    '# C-0012 Rule Engine Audit（只读；**不含商业结论**）',
    '',
    '```text',
    `engineeringStatus   : ${audit.engineeringStatus}`,
    `auditRunStatus      : ${audit.auditRunStatus}`,
    `commercialConclusion: ${audit.commercialConclusion}   ← 只能由人工判断`,
    '```',
    '',
    `- 生成时间：${audit.generatedAt}`,
    `- 覆盖率：${audit.coverage.withRecoverableAmount}/${audit.coverage.claimItems}（${audit.coverage.coverageRate}）`,
    '',
    '## 残差分类（不许把未复核数据混进分位）',
    '',
    '```text',
    `NO_HUMAN_REVIEW : ${audit.residuals.classification.NO_HUMAN_REVIEW}`,
    `CONFIRMED       : ${audit.residuals.classification.CONFIRMED}`,
    `ADJUSTED        : ${audit.residuals.classification.ADJUSTED}`,
    '```',
    '',
    `- ADJUSTED 残差：count=${audit.residuals.adjusted.count} · median=${audit.residuals.adjusted.median ?? 'n/a'} ·`,
    `  p90Abs=${audit.residuals.adjusted.p90Abs ?? 'n/a'} · absSum=${audit.residuals.adjusted.absSum}`,
    '',
    '## 版本漂移（只读真实历史，不做规则回测）',
    '',
  ];
  if (audit.drift.changedPairs.length === 0) {
    lines.push('- 无：同类损失事件在历史里只有一个金额结果');
  } else {
    for (const pair of audit.drift.changedPairs) {
      lines.push(
        `- ${pair.platformType}/${pair.claimType}：${pair.fromRuleVersionId ?? 'NONE'} → ${pair.fromAmount}` +
          ` ｜ ${pair.toRuleVersionId ?? 'NONE'} → ${pair.toAmount}`,
      );
    }
  }
  lines.push(
    '',
    '## 规则新鲜度（只提示 stale，不判失效）',
    '',
    `- staleRuleCount=${audit.freshness.staleRuleCount}（阈值 ${audit.freshness.thresholdDays} 天）`,
    '',
    '> 本报告只回答「规则结果可不可解释」；是否值得继续追、客户是否付费，一律由人工判断。',
    '',
  );
  return lines.join('\n');
}

export interface RecordReviewInput {
  organizationId: string;
  actorUserId: string;
  role: string;
  claimItemId: string;
  ruleAmount: string;
  toAmount?: string | null;
  decision?: ReviewDecision;
  reason?: string | null;
}

export interface RecordReviewResult {
  claimItemId: string;
  decision: ReviewDecision;
  ruleAmount: string;
  toAmount: string;
  reviewedAt: Date;
}

/**
 * 人工复核**只写审计**：不更新 `ClaimItem.recoverableAmount`（Audit Only）。
 * 提交的 `ruleAmount` 必须等于当前记录的规则输出，否则 RULE_AMOUNT_MISMATCH（MSG-124 REVISE-1）。
 */
export async function recordRecoverableAmountReview(
  prisma: PrismaClient,
  input: RecordReviewInput,
  deps: { now?: () => Date } = {},
): Promise<RecordReviewResult> {
  assertPermission(input.role, 'manageClaimItems');
  const item = await prisma.claimItem.findFirst({
    where: { id: input.claimItemId, organizationId: input.organizationId },
    select: { id: true, recoverableAmount: true, ruleVersionId: true },
  });
  if (!item) throw new WorkflowError('NOT_FOUND', `ClaimItem ${input.claimItemId} 不存在或不属于该租户`);
  if (!item.recoverableAmount) {
    throw new WorkflowError('INVALID_INPUT', '该 ClaimItem 还没有规则金额，无法复核');
  }

  const recordedRuleAmount = money(item.recoverableAmount);
  let submitted: string;
  try {
    submitted = money(input.ruleAmount);
  } catch {
    throw new WorkflowError('INVALID_INPUT', 'ruleAmount 必须是金额字符串');
  }
  if (submitted !== recordedRuleAmount) {
    throw new WorkflowError(
      'RULE_AMOUNT_MISMATCH',
      `提交的 ruleAmount(${submitted}) 与历史规则输出(${recordedRuleAmount}) 不一致`,
    );
  }

  const rawDecision = typeof input.decision === 'string' ? input.decision.trim().toUpperCase() : '';
  const toAmount = input.toAmount === null || input.toAmount === undefined ? recordedRuleAmount : money(input.toAmount);
  const decision: ReviewDecision | '' = (REVIEW_DECISIONS as readonly string[]).includes(rawDecision)
    ? (rawDecision as ReviewDecision)
    : '';
  if (!decision) throw new WorkflowError('INVALID_INPUT', 'decision 必须是 CONFIRMED 或 ADJUSTED');
  if (decision === 'CONFIRMED' && toAmount !== recordedRuleAmount) {
    throw new WorkflowError('INVALID_INPUT', 'CONFIRMED 时 toAmount 必须等于规则金额');
  }
  if (decision === 'ADJUSTED' && toAmount === recordedRuleAmount) {
    throw new WorkflowError('INVALID_INPUT', 'ADJUSTED 时 toAmount 必须与规则金额不同');
  }
  if (decision === 'ADJUSTED' && (!input.reason || input.reason.trim() === '')) {
    throw new WorkflowError('REASON_REQUIRED', 'ADJUSTED 必须给出 reason');
  }

  const at = (deps.now ?? (() => new Date()))();
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.actorUserId,
      action: REVIEW_ACTION,
      entityType: 'ClaimItem',
      entityId: item.id,
      changes: {
        claimItemId: item.id,
        ruleAmount: recordedRuleAmount,
        toAmount,
        decision,
        ruleVersionId: item.ruleVersionId,
        reviewerUserId: input.actorUserId,
        ...(input.reason ? { reason: input.reason.trim() } : {}),
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

  return { claimItemId: item.id, decision, ruleAmount: recordedRuleAmount, toAmount, reviewedAt: at };
}
