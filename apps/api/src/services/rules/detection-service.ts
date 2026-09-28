/**
 * Detection Spine 编排（C-0004 Checkpoint 1）
 * ---------------------------------------------------------------
 *   SourceTransaction(INVOICE/TRACKING, domain+channel 限定)
 *     → 规则选择（RuleSet/RuleVersion，tier 优先级 + 稳定 tie-break）
 *     → FREIGHT_RATE_V1 确定性评估（币种一致才计算）
 *     → 原子持久化：RuleEvaluation（+ RecoveryOpportunity）
 *
 * C-0004 复审要点（架构方 CHANGE #39 / #40）：
 *   - #39：Evaluation 与 Opportunity 必须在**一个事务**里落库；重跑/并发时返回数据库真实保存的
 *          result / computed / opportunityId（INV-1001 第二次仍必须是 OPPORTUNITY，不能变 PASS）。
 *   - #40：账单、轨迹、规则三类查询都必须显式限定 domain + channel，不依赖“目前只有 OTHER”。
 * 本层只做检测，不做 Case / Claim / Settlement（属于 Checkpoint 2）。
 */

import { createHash } from 'node:crypto';

import {
  definitionHash,
  evaluateFreightRate,
  parseFreightRateDefinition,
  selectRuleVersion,
  type RuleCandidate,
} from './freight-rate';

export const DETECTION_ENGINE_VERSION = 'FREIGHT_RATE_V1@1';
export const FREIGHT_RATE_OVERCHARGE = 'FREIGHT_RATE_OVERCHARGE';

/** C-0004 当前 slice 的作用域 */
export interface DetectionScope {
  domain: 'LOGISTICS';
  channel: 'OTHER';
}

export const DETECTION_SCOPE: DetectionScope = { domain: 'LOGISTICS', channel: 'OTHER' };

export interface InvoiceRow {
  sourceTransactionId: string;
  externalId: string | null;
  occurredAt: Date | null;
  amount: string | null;
  currency: string;
  /** 承运商账单原始行里的运单号，用于与轨迹配对 */
  trackingNumber: string | null;
}

export interface TrackingRow {
  sourceTransactionId: string;
  externalId: string | null;
  lane: string | null;
  service: string | null;
  weightKg: string | null;
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

/** 原子持久化输入：Evaluation（必选）+ Opportunity（可选，同一事务内完成） */
export interface DetectionPersistenceInput {
  organizationId: string;
  ruleVersionId: string;
  sourceTransactionId: string;
  result: 'PASS' | 'OPPORTUNITY';
  computed: unknown;
  message: string | null;
  dedupeKey: string;
  opportunity: OpportunityDraft | null;
}

export interface DetectionPersistenceResult {
  evaluationId: string;
  /** false = 该 dedupeKey 已存在（重跑或并发），返回的是数据库中真实保存的内容 */
  created: boolean;
  result: 'PASS' | 'OPPORTUNITY';
  computed: unknown;
  opportunityId: string | null;
}

/** 检测端口：实现可以是 Prisma，也可以是测试内存实现 */
export interface DetectionRepository {
  listInvoices(
    organizationId: string,
    scope: DetectionScope,
    connectionId?: string | null,
  ): Promise<InvoiceRow[]>;
  listTracking(
    organizationId: string,
    scope: DetectionScope,
    connectionId?: string | null,
  ): Promise<TrackingRow[]>;
  listFreightRateRuleCandidates(
    organizationId: string,
    scope: DetectionScope,
  ): Promise<RuleCandidate[]>;
  persistDetectionOutcome(input: DetectionPersistenceInput): Promise<DetectionPersistenceResult>;
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
  scope: DetectionScope;
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
  /** 默认 LOGISTICS / OTHER；调用方可显式传入以收紧作用域 */
  scope?: DetectionScope;
  connectionId?: string | null;
  /** 评估基准时间，用于规则生效期判断 */
  now?: () => Date;
}

const needsMoreData = (
  invoice: InvoiceRow,
  trackingExternalId: string | null,
  reason: string,
  extra: Partial<DetectionRowOutcome> = {},
): DetectionRowOutcome => ({
  invoiceExternalId: invoice.externalId,
  trackingExternalId,
  result: 'NEEDS_MORE_DATA',
  ruleTier: extra.ruleTier ?? null,
  ruleVersionId: extra.ruleVersionId ?? null,
  expected: null,
  actual: invoice.amount,
  recoverable: null,
  opportunityId: null,
  skippedReason: reason,
});

export async function runFreightRateDetection(
  input: RunDetectionInput,
): Promise<DetectionRunResult> {
  const { organizationId, repository } = input;
  const scope = input.scope ?? DETECTION_SCOPE;
  const now = input.now ?? (() => new Date());

  const [invoices, tracking, candidates] = await Promise.all([
    repository.listInvoices(organizationId, scope, input.connectionId ?? null),
    repository.listTracking(organizationId, scope, input.connectionId ?? null),
    repository.listFreightRateRuleCandidates(organizationId, scope),
  ]);

  const trackingByNumber = new Map<string, TrackingRow>();
  for (const row of tracking) {
    if (row.externalId) trackingByNumber.set(row.externalId, row);
  }

  const result: DetectionRunResult = {
    engineVersion: DETECTION_ENGINE_VERSION,
    scope,
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
      result.outcomes.push(needsMoreData(invoice, invoice.trackingNumber, 'TRACKING_NOT_FOUND'));
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
      result.outcomes.push(needsMoreData(invoice, trackingRow.externalId, 'NO_APPLICABLE_RULE'));
      continue;
    }

    if (!invoice.amount || !trackingRow.weightKg) {
      result.outcomes.push(
        needsMoreData(invoice, trackingRow.externalId, 'MISSING_AMOUNT_OR_WEIGHT', {
          ruleTier: selected.tier,
          ruleVersionId: selected.ruleVersionId,
        }),
      );
      continue;
    }

    // CHANGE #42：规则币种必须与账单币种一致，否则不得计算机会
    if (invoice.currency !== selected.definition.pricing.currency) {
      result.outcomes.push(
        needsMoreData(invoice, trackingRow.externalId, 'CURRENCY_MISMATCH', {
          ruleTier: selected.tier,
          ruleVersionId: selected.ruleVersionId,
        }),
      );
      continue;
    }

    const evaluation = evaluateFreightRate({
      definition: selected.definition,
      weightKg: trackingRow.weightKg,
      actualCharge: invoice.amount,
    });
    // CHANGE #41：用 Decimal 数值判断（boolean），禁止字符串比较金额是否为 0
    const hasOpportunity = evaluation.hasRecoverableAmount;

    const persisted = await repository.persistDetectionOutcome({
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
      dedupeKey: detectionDedupeKey({
        organizationId,
        ruleVersionId: selected.ruleVersionId,
        invoiceTransactionId: invoice.sourceTransactionId,
        trackingTransactionId: trackingRow.sourceTransactionId,
      }),
      opportunity: hasOpportunity
        ? {
            organizationId,
            domain: scope.domain,
            channel: scope.channel,
            opportunityType: FREIGHT_RATE_OVERCHARGE,
            title: `合同运费超收 ${invoice.externalId ?? ''}`.trim(),
            description: `lane=${trackingRow.lane} service=${trackingRow.service} rule=${selected.version}`,
            amountExpected: evaluation.expected,
            amountActual: evaluation.intermediate.actualAmount,
            recoverableAmount: evaluation.recoverable,
            currency: invoice.currency,
          }
        : null,
    });

    if (persisted.created) {
      result.evaluationsCreated += 1;
      if (persisted.opportunityId) result.opportunitiesCreated += 1;
    } else {
      result.skippedExisting += 1;
    }

    // 重跑必须返回数据库真实保存的结果（#39），金额取 saved computed 以保证一致
    const savedComputed = persisted.computed as
      | { intermediate?: Record<string, string> }
      | null
      | undefined;
    const saved = savedComputed?.intermediate ?? null;

    result.outcomes.push({
      invoiceExternalId: invoice.externalId,
      trackingExternalId: trackingRow.externalId,
      result: persisted.result,
      ruleTier: selected.tier,
      ruleVersionId: selected.ruleVersionId,
      expected: saved?.expectedAmount ?? evaluation.expected,
      actual: saved?.actualAmount ?? evaluation.intermediate.actualAmount,
      recoverable: saved?.recoverableAmount ?? evaluation.recoverable,
      opportunityId: persisted.opportunityId,
      ...(persisted.created ? {} : { skippedReason: 'ALREADY_EVALUATED' }),
    });
  }

  return result;
}

/** 供测试/调试：把原始 definition 解析成候选（不访问数据库） */
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
