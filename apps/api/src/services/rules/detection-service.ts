/**
 * Detection Spine 编排（C-0004 Checkpoint 1）
 * ---------------------------------------------------------------
 *   SourceTransaction(INVOICE) + SourceTransaction(TRACKING)
 *     → 规则选择（RuleSet/RuleVersion，按 tier 优先级）
 *     → FREIGHT_RATE_V1 确定性评估
 *     → RuleEvaluation（幂等键）
 *     → RecoveryOpportunity（仅当 recoverable > 0）
 *
 * 本层只做“检测”，不做 Case / Claim / Settlement（属于 C-0004 Checkpoint 2）。
 * 幂等：RuleEvaluation.dedupeKey 唯一；同一 dedupeKey 已存在且已挂 opportunity → 整行跳过。
 */

import { createHash } from 'node:crypto';

import {
  evaluateFreightRate,
  parseFreightRateDefinition,
  selectRuleVersion,
  definitionHash,
  type RuleCandidate,
} from './freight-rate';

export const DETECTION_ENGINE_VERSION = 'FREIGHT_RATE_V1@1';
export const FREIGHT_RATE_OVERCHARGE = 'FREIGHT_RATE_OVERCHARGE';

export interface InvoiceRow {
  sourceTransactionId: string;
  externalId: string | null;
  occurredAt: Date | null;
  amount: string | null;
  currency: string;
  /** 承运商账单里的运单号（原始行保留，检测层据此与轨迹配对） */
  trackingNumber: string | null;
}

export interface TrackingRow {
  sourceTransactionId: string;
  externalId: string | null;
  lane: string | null;
  service: string | null;
  weightKg: string | null;
}

export interface EvaluationDraft {
  organizationId: string;
  ruleVersionId: string;
  sourceTransactionId: string;
  result: 'PASS' | 'OPPORTUNITY' | 'NEEDS_MORE_DATA';
  computed: unknown;
  message: string | null;
  dedupeKey: string;
}

export interface OpportunityDraft {
  organizationId: string;
  domain: 'LOGISTICS';
  channel: 'OTHER';
  opportunityType: string;
  title: string;
  description: string | null;
  amountExpected: string;
  amountActual: string;
  recoverableAmount: string;
  currency: string;
}

/** 检测端口：实现可以是 Prisma，也可以是测试内存实现 */
export interface DetectionRepository {
  listInvoices(organizationId: string, connectionId?: string | null): Promise<InvoiceRow[]>;
  listTracking(organizationId: string, connectionId?: string | null): Promise<TrackingRow[]>;
  listFreightRateRuleCandidates(organizationId: string): Promise<RuleCandidate[]>;
  findEvaluationByDedupeKey(
    dedupeKey: string,
  ): Promise<{ id: string; opportunityId: string | null } | null>;
  createEvaluation(draft: EvaluationDraft): Promise<{ id: string }>;
  createOpportunity(draft: OpportunityDraft): Promise<{ id: string }>;
  linkEvaluationToOpportunity(evaluationId: string, opportunityId: string): Promise<void>;
}

export interface DetectionRowOutcome {
  invoiceExternalId: string | null;
  trackingExternalId: string | null;
  result: 'PASS' | 'OPPORTUNITY' | 'NEEDS_MORE_DATA';
  ruleTier: string | null;
  ruleVersionId: string | null;
  expected: string | null;
  actual: string | null;
  recoverable: string | null;
  opportunityId: string | null;
  skippedReason?: string;
}

export interface DetectionRunResult {
  engineVersion: string;
  invoicesConsidered: number;
  evaluationsCreated: number;
  opportunitiesCreated: number;
  skippedExisting: number;
  unmatchedTracking: number;
  outcomes: DetectionRowOutcome[];
}

export function detectionDedupeKey(input: {
  organizationId: string;
  ruleVersionId: string;
  invoiceTransactionId: string;
  trackingTransactionId: string;
}): string {
  return createHash('sha256')
    .update(
      [
        input.organizationId,
        input.ruleVersionId,
        input.invoiceTransactionId,
        input.trackingTransactionId,
      ].join('|'),
      'utf8',
    )
    .digest('hex');
}

export interface RunDetectionInput {
  organizationId: string;
  repository: DetectionRepository;
  connectionId?: string | null;
  /** 评估基准时间（默认“现在”），用于规则生效期判断 */
  now?: () => Date;
}

export async function runFreightRateDetection(
  input: RunDetectionInput,
): Promise<DetectionRunResult> {
  const { organizationId, repository } = input;
  const now = input.now ?? (() => new Date());

  const [invoices, tracking, candidates] = await Promise.all([
    repository.listInvoices(organizationId, input.connectionId ?? null),
    repository.listTracking(organizationId, input.connectionId ?? null),
    repository.listFreightRateRuleCandidates(organizationId),
  ]);

  const trackingByNumber = new Map<string, TrackingRow>();
  for (const row of tracking) {
    if (row.externalId) trackingByNumber.set(row.externalId, row);
  }

  const result: DetectionRunResult = {
    engineVersion: DETECTION_ENGINE_VERSION,
    invoicesConsidered: invoices.length,
    evaluationsCreated: 0,
    opportunitiesCreated: 0,
    skippedExisting: 0,
    unmatchedTracking: 0,
    outcomes: [],
  };

  for (const invoice of invoices) {
    const trackingRow = invoice.trackingNumber
      ? trackingByNumber.get(invoice.trackingNumber) ?? null
      : null;

    if (!trackingRow) {
      result.unmatchedTracking += 1;
      result.outcomes.push({
        invoiceExternalId: invoice.externalId,
        trackingExternalId: invoice.trackingNumber,
        result: 'NEEDS_MORE_DATA',
        ruleTier: null,
        ruleVersionId: null,
        expected: null,
        actual: invoice.amount,
        recoverable: null,
        opportunityId: null,
        skippedReason: 'TRACKING_NOT_FOUND',
      });
      continue;
    }

    const applicableAt = invoice.occurredAt ?? now();
    const matching = candidates.filter(
      (candidate) =>
        candidate.definition.match.lane === trackingRow.lane &&
        candidate.definition.match.service === trackingRow.service,
    );
    const selected = selectRuleVersion(matching, applicableAt);

    if (!selected) {
      result.unmatchedTracking += 0;
      result.outcomes.push({
        invoiceExternalId: invoice.externalId,
        trackingExternalId: trackingRow.externalId,
        result: 'NEEDS_MORE_DATA',
        ruleTier: null,
        ruleVersionId: null,
        expected: null,
        actual: invoice.amount,
        recoverable: null,
        opportunityId: null,
        skippedReason: 'NO_APPLICABLE_RULE',
      });
      continue;
    }

    if (!invoice.amount || !trackingRow.weightKg) {
      result.outcomes.push({
        invoiceExternalId: invoice.externalId,
        trackingExternalId: trackingRow.externalId,
        result: 'NEEDS_MORE_DATA',
        ruleTier: selected.tier,
        ruleVersionId: selected.ruleVersionId,
        expected: null,
        actual: invoice.amount,
        recoverable: null,
        opportunityId: null,
        skippedReason: 'MISSING_AMOUNT_OR_WEIGHT',
      });
      continue;
    }

    // CHANGE #42：规则币种必须与账单币种一致，否则不得计算机会（避免把 USD 费率当 EUR 金额）
    if (invoice.currency !== selected.definition.pricing.currency) {
      result.outcomes.push({
        invoiceExternalId: invoice.externalId,
        trackingExternalId: trackingRow.externalId,
        result: 'NEEDS_MORE_DATA',
        ruleTier: selected.tier,
        ruleVersionId: selected.ruleVersionId,
        expected: null,
        actual: invoice.amount,
        recoverable: null,
        opportunityId: null,
        skippedReason: 'CURRENCY_MISMATCH',
      });
      continue;
    }

    const dedupeKey = detectionDedupeKey({
      organizationId,
      ruleVersionId: selected.ruleVersionId,
      invoiceTransactionId: invoice.sourceTransactionId,
      trackingTransactionId: trackingRow.sourceTransactionId,
    });

    const existing = await repository.findEvaluationByDedupeKey(dedupeKey);
    if (existing) {
      result.skippedExisting += 1;
      result.outcomes.push({
        invoiceExternalId: invoice.externalId,
        trackingExternalId: trackingRow.externalId,
        result: 'PASS',
        ruleTier: selected.tier,
        ruleVersionId: selected.ruleVersionId,
        expected: null,
        actual: invoice.amount,
        recoverable: null,
        opportunityId: existing.opportunityId,
        skippedReason: 'ALREADY_EVALUATED',
      });
      continue;
    }

    const evaluation = evaluateFreightRate({
      definition: selected.definition,
      weightKg: trackingRow.weightKg,
      actualCharge: invoice.amount,
    });
    // CHANGE #41：用 Decimal 数值判断（evaluator 返回 boolean），禁止字符串比较
    const hasOpportunity = evaluation.hasRecoverableAmount;

    const created = await repository.createEvaluation({
      organizationId,
      ruleVersionId: selected.ruleVersionId,
      sourceTransactionId: invoice.sourceTransactionId,
      result: hasOpportunity ? 'OPPORTUNITY' : 'PASS',
      computed: {
        engineVersion: DETECTION_ENGINE_VERSION,
        definitionHash: definitionHash(selected.definition),
        ruleVersionId: selected.ruleVersionId,
        ruleTier: selected.tier,
        currency: evaluation.intermediate.currency,
        inputRefs: {
          invoiceTransactionId: invoice.sourceTransactionId,
          trackingTransactionId: trackingRow.sourceTransactionId,
        },
        intermediate: evaluation.intermediate,
        rounding: evaluation.rounding,
      },
      message: hasOpportunity
        ? `合同运费超收：应收 ${evaluation.expected}，实收 ${evaluation.intermediate.actualAmount}`
        : '未发现超收',
      dedupeKey,
    });
    result.evaluationsCreated += 1;

    let opportunityId: string | null = null;
    if (hasOpportunity) {
      const opportunity = await repository.createOpportunity({
        organizationId,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        opportunityType: FREIGHT_RATE_OVERCHARGE,
        title: `合同运费超收 ${invoice.externalId ?? ''}`.trim(),
        description: `lane=${trackingRow.lane} service=${trackingRow.service} rule=${selected.version}`,
        amountExpected: evaluation.expected,
        amountActual: evaluation.intermediate.actualAmount,
        recoverableAmount: evaluation.recoverable,
        currency: invoice.currency,
      });
      opportunityId = opportunity.id;
      result.opportunitiesCreated += 1;
      await repository.linkEvaluationToOpportunity(created.id, opportunity.id);
    }

    result.outcomes.push({
      invoiceExternalId: invoice.externalId,
      trackingExternalId: trackingRow.externalId,
      result: hasOpportunity ? 'OPPORTUNITY' : 'PASS',
      ruleTier: selected.tier,
      ruleVersionId: selected.ruleVersionId,
      expected: evaluation.expected,
      actual: evaluation.intermediate.actualAmount,
      recoverable: evaluation.recoverable,
      opportunityId,
    });
  }

  return result;
}

/** 供测试/调试使用：把原始 definition 解析成候选（不做数据库访问） */
export function toRuleCandidate(input: {
  ruleVersionId: string;
  tier: RuleCandidate['tier'];
  version: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  isActive?: boolean;
  definition: unknown;
}): RuleCandidate {
  return {
    ruleVersionId: input.ruleVersionId,
    tier: input.tier,
    version: input.version,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    isActive: input.isActive ?? true,
    definition: parseFreightRateDefinition(input.definition),
  };
}
