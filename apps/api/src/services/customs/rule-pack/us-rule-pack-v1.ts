// CUSTOMS / DUTY RECOVERY — slice B-S7 — US Jurisdiction Rule Pack v1
// ---------------------------------------------------------------------------
// 定位（对齐 docs/releases/CUSTOMS-MULTI-JURISDICTION-RECOVERY-DIRECTIVE.md §4「Jurisdiction Rule Pack」）：
//   把国家差异收敛到一个**版本化只读规则包**，由 resolveJurisdictionRulePack(jurisdiction) 解析；
//   不在业务代码里硬编码国家逻辑。
//
// 复用（不新建重复词表 / 不新建重复引擎）：
//   * remedy 路由复用既有 provider-neutral 词表 `CUSTOMS_REMEDY_ROUTES`
//     （DRAWBACK / PROTEST / POST_SUMMARY_CORRECTION / EXCLUSION_REFUND / CLASSIFICATION_CORRECTION /
//      DUPLICATE_DUTY / OTHER）；
//   * 期限计算复用既有 `evaluateRemedyDeadline`（policy-driven；无「全球统一 3–5 年」硬编码）。
//
// 硬边界：
//   ① 规则包**只描述规则**：不判 eligibility、不算可退金额、不判 successFeeEligible；
//   ② v1 的所有期限政策都是 **UNVERIFIED**（未经法务核验）→ 一律返回 INDETERMINATE，
//      绝不把未核验的期限当成法律事实，也绝不自动申报；
//   ③ 9801 / 9802 是特别条款，**不是** drawback（DRAWBACK_CANDIDATE 不得以其为依据）；
//   ④ 未知 jurisdiction → 无规则包 → INDETERMINATE（fail-closed）。

import { digestOf } from '../../config-execution-durability/digests';
import {
  evaluateRemedyDeadline,
  type CustomsRemedyDeadlinePolicy,
  type CustomsRemedyRoute,
} from '../enterprise-ior/remedy-deadline';
import type { CustomsEvidenceRequirementId } from '../../provider-support/customs-evidence-requirements';

export const US_RULE_PACK_ID = 'customs-us';
export const US_RULE_PACK_VERSION = 'v1';

/** 恢复候选类型（HOST B-S7 词表）→ 映射到既有 provider-neutral remedy 路由 */
export const CUSTOMS_RECOVERY_CANDIDATE_KINDS = [
  'DUPLICATE_DUTY',
  'RATE_OVERPAYMENT',
  'MISSED_EXCLUSION',
  'DRAWBACK_CANDIDATE',
  'PSC',
  'PROTEST',
  'CLASSIFICATION_CORRECTION',
  'BROKER_REVIEW',
] as const;
export type CustomsRecoveryCandidateKind = (typeof CUSTOMS_RECOVERY_CANDIDATE_KINDS)[number];

export const RULE_PACK_SUBMISSION_MODES = [
  'AUTHORITY_FILING',
  'BROKER_FILED',
  'SELF_FILED',
  'BROKER_HANDOFF',
] as const;
export type RulePackSubmissionMode = (typeof RULE_PACK_SUBMISSION_MODES)[number];

export const RULE_PACK_VERIFICATION_STATUSES = ['UNVERIFIED', 'LEGAL_VERIFIED'] as const;
export type RulePackVerificationStatus = (typeof RULE_PACK_VERIFICATION_STATUSES)[number];

export interface RulePackLegalBasisRef {
  /** opaque 引用（不得是裸 URL；由既有 isOpaqueRecoveryRef 约束） */
  id: string;
  label: string;
}

export interface RulePackDeadlinePolicy {
  policyId: string;
  policyVersion: string;
  anchorField: CustomsRemedyDeadlinePolicy['anchorField'];
  daysFromAnchor: number;
  sourceReferenceId: string;
  /** v1 全为 UNVERIFIED：未经法务核验的期限不得作为结论 */
  verification: RulePackVerificationStatus;
}

export interface RulePackRouting {
  submissionMode: RulePackSubmissionMode;
  requiresBroker: boolean;
  requiresFilingAuthorization: boolean;
  /** 恒为 false：本规则包不授权任何自动申报 */
  autoFilingAllowed: false;
}

export interface RulePackRemedy {
  candidate: CustomsRecoveryCandidateKind;
  /** 映射到既有 remedy 路由词表 */
  route: CustomsRemedyRoute;
  title: string;
  description: string;
  requiredEvidence: readonly CustomsEvidenceRequirementId[];
  optionalEvidence: readonly CustomsEvidenceRequirementId[];
  deadlinePolicy: RulePackDeadlinePolicy;
  routing: RulePackRouting;
  limitations: readonly string[];
  exclusionClauses: readonly string[];
}

export interface UsRulePackV1 {
  ruleSetId: string;
  ruleSetVersion: string;
  jurisdiction: 'US';
  jurisdictionScope: 'COUNTRY';
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
  /** 未经法务核验时为 null（不得伪称已核验） */
  lastVerified: string | null;
  legalBasis: readonly RulePackLegalBasisRef[];
  remedies: Readonly<Record<CustomsRecoveryCandidateKind, RulePackRemedy>>;
  exclusionRules: {
    /** 9801（de minimis 等特别条款）不是 drawback */
    hts9801IsNotDrawback: true;
    /** 9802（美国货物复进口等特别条款）不是 drawback */
    hts9802IsNotDrawback: true;
    /** 未核验的期限政策不得作为结论 */
    unverifiedDeadlineIsIndeterminate: true;
    /** 缺 jurisdiction / rule pack → INDETERMINATE */
    missingRulePackIsIndeterminate: true;
  };
}

const LEGAL_BASIS: readonly RulePackLegalBasisRef[] = [
  { id: 'US:CUSTOMS:ENTRY_SUMMARY_CORRECTION', label: 'Entry summary correction / post-summary correction framework' },
  { id: 'US:CUSTOMS:PROTEST', label: 'Administrative protest framework' },
  { id: 'US:CUSTOMS:DRAWBACK', label: 'Duty drawback framework' },
  { id: 'US:CUSTOMS:EXCLUSION_REFUND', label: 'Trade remedy exclusion refund framework' },
  { id: 'US:CUSTOMS:DUPLICATE_DUTY', label: 'Duplicate duty payment resolution framework' },
  { id: 'US:CUSTOMS:SPECIAL_PROVISIONS_9801_9802', label: 'Special classification provisions 9801 / 9802' },
];

const INTERNAL_SOURCE = 'rules/customs/us/us-rule-pack-v1';

interface RemedySeed {
  candidate: CustomsRecoveryCandidateKind;
  route: CustomsRemedyRoute;
  title: string;
  description: string;
  requiredEvidence: readonly CustomsEvidenceRequirementId[];
  optionalEvidence: readonly CustomsEvidenceRequirementId[];
  anchorField: CustomsRemedyDeadlinePolicy['anchorField'];
  daysFromAnchor: number;
  submissionMode: RulePackSubmissionMode;
  requiresBroker: boolean;
  requiresFilingAuthorization: boolean;
  limitations: readonly string[];
  exclusionClauses: readonly string[];
}

const REMEDY_SEEDS: readonly RemedySeed[] = [
  {
    candidate: 'DUPLICATE_DUTY',
    route: 'DUPLICATE_DUTY',
    title: '同一票货被重复征收关税',
    description: '同一 entry / 同一行项目在多个缴纳凭证中被重复征收，需要退还多缴部分。',
    requiredEvidence: ['ENTRY_RECORD', 'DUTY_PAYMENT'],
    optionalEvidence: ['ENTRY_LINE', 'COMMERCIAL_INVOICE'],
    anchorField: 'entryDate',
    daysFromAnchor: 180,
    submissionMode: 'BROKER_FILED',
    requiresBroker: true,
    requiresFilingAuthorization: true,
    limitations: ['必须能证明是同一票货（同一 entry/行项目）的重复缴纳'],
    exclusionClauses: ['重复缴纳但币种不同且无法折算时 → 人工复核'],
  },
  {
    candidate: 'RATE_OVERPAYMENT',
    route: 'POST_SUMMARY_CORRECTION',
    title: '税率适用错误导致多缴',
    description: '实际适用税率高于应适用税率，差额部分可通过更正程序主张。',
    requiredEvidence: ['ENTRY_RECORD', 'ENTRY_LINE', 'DUTY_PAYMENT'],
    optionalEvidence: ['COMMERCIAL_INVOICE', 'BROKER_CASE'],
    anchorField: 'liquidationDate',
    daysFromAnchor: 90,
    submissionMode: 'BROKER_FILED',
    requiresBroker: true,
    requiresFilingAuthorization: true,
    limitations: ['应有税率必须来自可核验的税率来源，不得由客户或 LLM 直接给出'],
    exclusionClauses: ['税率来源不可核验 → INDETERMINATE'],
  },
  {
    candidate: 'MISSED_EXCLUSION',
    route: 'EXCLUSION_REFUND',
    title: '未申报适用排除条款',
    description: '报关时漏报可适用的排除（exclusion），导致多缴关税。',
    requiredEvidence: ['ENTRY_RECORD', 'ENTRY_LINE'],
    optionalEvidence: ['COMMERCIAL_INVOICE', 'DUTY_PAYMENT'],
    anchorField: 'exclusionEffectiveDate',
    daysFromAnchor: 120,
    submissionMode: 'BROKER_FILED',
    requiresBroker: true,
    requiresFilingAuthorization: true,
    limitations: ['排除条款必须与 HTS / 产品描述可对应；不得仅凭关键词推断'],
    exclusionClauses: ['排除条款适用范围不明确 → INDETERMINATE'],
  },
  {
    candidate: 'DRAWBACK_CANDIDATE',
    route: 'DRAWBACK',
    title: '可能符合退税（drawback）条件',
    description: '已缴关税的货物后续出口 / 销毁 / 退货，可能符合退税条件。',
    requiredEvidence: ['ENTRY_RECORD', 'DUTY_PAYMENT'],
    optionalEvidence: ['EXPORT_RECORD', 'DESTRUCTION_RECORD', 'RETURN_RECORD'],
    anchorField: 'exportDate',
    daysFromAnchor: 1_825,
    submissionMode: 'BROKER_FILED',
    requiresBroker: true,
    requiresFilingAuthorization: true,
    limitations: [
      '必须存在出口 / 销毁 / 退货事实证据，且与进口 entry 可匹配',
      'HTS 9801 / 9802 属于特别条款，**不是** drawback 依据',
    ],
    exclusionClauses: [
      'HTS 9801 → 不得作为 drawback 依据',
      'HTS 9802 → 不得作为 drawback 依据',
      '缺少出口/销毁/退货证据 → INDETERMINATE',
    ],
  },
  {
    candidate: 'PSC',
    route: 'POST_SUMMARY_CORRECTION',
    title: '汇总后更正（PSC）',
    description: '在允许窗口内对已提交的 entry summary 做更正。',
    requiredEvidence: ['ENTRY_RECORD'],
    optionalEvidence: ['ENTRY_LINE', 'COMMERCIAL_INVOICE', 'BROKER_CASE'],
    anchorField: 'liquidationDate',
    daysFromAnchor: 21,
    submissionMode: 'BROKER_FILED',
    requiresBroker: true,
    requiresFilingAuthorization: true,
    limitations: ['必须在更正窗口内；窗口状态由期限政策给出（v1 未核验 → INDETERMINATE）'],
    exclusionClauses: ['已 liquidation 且窗口关闭 → NOT_ELIGIBLE_BY_RULE（需人工确认）'],
  },
  {
    candidate: 'PROTEST',
    route: 'PROTEST',
    title: '行政异议（protest）',
    description: '对海关裁定（含税率/归类/排除适用）提出行政异议。',
    requiredEvidence: ['ENTRY_RECORD', 'DUTY_PAYMENT'],
    optionalEvidence: ['BROKER_CASE', 'ENTRY_LINE'],
    anchorField: 'liquidationDate',
    daysFromAnchor: 180,
    submissionMode: 'BROKER_FILED',
    requiresBroker: true,
    requiresFilingAuthorization: true,
    limitations: ['必须存在可分派的裁定对象（liquidation / decision）'],
    exclusionClauses: ['缺少裁定对象 → INDETERMINATE'],
  },
  {
    candidate: 'CLASSIFICATION_CORRECTION',
    route: 'CLASSIFICATION_CORRECTION',
    title: '归类更正',
    description: 'HTS 归类错误导致的多缴，可通过更正或异议主张。',
    requiredEvidence: ['ENTRY_RECORD', 'ENTRY_LINE'],
    optionalEvidence: ['COMMERCIAL_INVOICE', 'BROKER_CASE'],
    anchorField: 'liquidationDate',
    daysFromAnchor: 180,
    submissionMode: 'BROKER_FILED',
    requiresBroker: true,
    requiresFilingAuthorization: true,
    limitations: ['正确归类必须有可核验依据（ruling / 官方归类资料），不得由 LLM 判定'],
    exclusionClauses: ['归类依据不可核验 → INDETERMINATE'],
  },
  {
    candidate: 'BROKER_REVIEW',
    route: 'OTHER',
    title: '需要报关行人工复核',
    description: '事实不足以路由到具体 remedy，先交报关行人工复核。',
    requiredEvidence: ['ENTRY_RECORD'],
    optionalEvidence: ['BROKER_CASE', 'ENTRY_LINE', 'DUTY_PAYMENT'],
    anchorField: 'entryDate',
    daysFromAnchor: 365,
    submissionMode: 'BROKER_HANDOFF',
    requiresBroker: true,
    requiresFilingAuthorization: false,
    limitations: ['仅安排人工复核，不构成任何 remedy 结论'],
    exclusionClauses: ['证据链不完整 → 保持 BROKER_HANDOFF'],
  },
];

function buildRemedy(seed: RemedySeed): RulePackRemedy {
  return {
    candidate: seed.candidate,
    route: seed.route,
    title: seed.title,
    description: seed.description,
    requiredEvidence: seed.requiredEvidence,
    optionalEvidence: seed.optionalEvidence,
    deadlinePolicy: {
      policyId: `${US_RULE_PACK_ID}:${seed.candidate.toLowerCase()}:deadline`,
      policyVersion: US_RULE_PACK_VERSION,
      anchorField: seed.anchorField,
      daysFromAnchor: seed.daysFromAnchor,
      sourceReferenceId: 'US:CUSTOMS:' + seed.route,
      verification: 'UNVERIFIED',
    },
    routing: {
      submissionMode: seed.submissionMode,
      requiresBroker: seed.requiresBroker,
      requiresFilingAuthorization: seed.requiresFilingAuthorization,
      autoFilingAllowed: false,
    },
    limitations: seed.limitations,
    exclusionClauses: seed.exclusionClauses,
  };
}

function buildRemedyFor(candidate: CustomsRecoveryCandidateKind): RulePackRemedy {
  const seed = REMEDY_SEEDS.find((entry) => entry.candidate === candidate);
  if (!seed) throw new Error('US rule pack remedy seed 缺失：' + candidate);
  return buildRemedy(seed);
}

export const US_RULE_PACK_V1: UsRulePackV1 = {
  ruleSetId: US_RULE_PACK_ID,
  ruleSetVersion: US_RULE_PACK_VERSION,
  jurisdiction: 'US',
  jurisdictionScope: 'COUNTRY',
  effectiveFrom: '2026-10-06',
  effectiveTo: null,
  source: INTERNAL_SOURCE,
  lastVerified: null,
  legalBasis: LEGAL_BASIS,
  remedies: {
    DUPLICATE_DUTY: buildRemedyFor('DUPLICATE_DUTY'),
    RATE_OVERPAYMENT: buildRemedyFor('RATE_OVERPAYMENT'),
    MISSED_EXCLUSION: buildRemedyFor('MISSED_EXCLUSION'),
    DRAWBACK_CANDIDATE: buildRemedyFor('DRAWBACK_CANDIDATE'),
    PSC: buildRemedyFor('PSC'),
    PROTEST: buildRemedyFor('PROTEST'),
    CLASSIFICATION_CORRECTION: buildRemedyFor('CLASSIFICATION_CORRECTION'),
    BROKER_REVIEW: buildRemedyFor('BROKER_REVIEW'),
  },
  exclusionRules: {
    hts9801IsNotDrawback: true,
    hts9802IsNotDrawback: true,
    unverifiedDeadlineIsIndeterminate: true,
    missingRulePackIsIndeterminate: true,
  },
};

/** 规则的 opaque digest（用于与 DB rule version / 审计对账） */
export const US_RULE_PACK_V1_DIGEST = digestOf(US_RULE_PACK_V1);

/**
 * 解析 jurisdiction 规则包（directive §4：`resolveJurisdictionRulePack(jurisdiction)`）。
 * 未知 jurisdiction → null（fail-closed，调用方必须转 INDETERMINATE）。
 */
export function resolveJurisdictionRulePack(jurisdiction: string | null | undefined): UsRulePackV1 | null {
  const normalized = (jurisdiction ?? '').trim().toUpperCase();
  if (normalized === 'US' || normalized === 'USA' || normalized === 'UNITED_STATES') return US_RULE_PACK_V1;
  return null;
}

export const US_DEADLINE_STATUSES = ['ELIGIBLE_WINDOW', 'INDETERMINATE', 'EXPIRED'] as const;

export interface UsRemedyDeadlineAssessment {
  candidate: CustomsRecoveryCandidateKind;
  route: CustomsRemedyRoute;
  policyId: string | null;
  policyVersion: string | null;
  verification: RulePackVerificationStatus | null;
  /** nominal 计算（仅供人工参考；未核验政策不得作为结论） */
  nominalDeadline: string | null;
  nominalStatus: (typeof US_DEADLINE_STATUSES)[number] | null;
  /** 对外状态：未核验政策一律 INDETERMINATE */
  status: (typeof US_DEADLINE_STATUSES)[number];
  anchorUsed: string | null;
  reasonCodes: string[];
  autoFilingAllowed: false;
  requiresLegalReview: boolean;
}

/**
 * 评估某 remedy 的期限窗口。
 * v1 政策全部 UNVERIFIED → 对外状态恒为 INDETERMINATE（fail-closed），
 * 同时给出 nominal 计算（anchor + days）供人工/法务核验，绝不自动申报。
 */
export function evaluateUsRemedyDeadline(input: {
  jurisdiction: string | null | undefined;
  candidate: string;
  entryDate?: string | null;
  liquidationDate?: string | null;
  exportDate?: string | null;
  destructionDate?: string | null;
  exclusionEffectiveDate?: string | null;
  now: string;
}): UsRemedyDeadlineAssessment {
  const pack = resolveJurisdictionRulePack(input.jurisdiction);
  const normalizedCandidate = String(input.candidate ?? '').toUpperCase();
  const remedy = pack
    ? (pack.remedies[normalizedCandidate as CustomsRecoveryCandidateKind] ?? null)
    : null;

  if (!pack || !remedy) {
    return {
      candidate: normalizedCandidate as CustomsRecoveryCandidateKind,
      route: 'OTHER',
      policyId: null,
      policyVersion: null,
      verification: null,
      nominalDeadline: null,
      nominalStatus: null,
      status: 'INDETERMINATE',
      anchorUsed: null,
      reasonCodes: [pack === null ? 'NO_RULE_PACK_FOR_JURISDICTION' : 'UNKNOWN_REMEDY_CANDIDATE'],
      autoFilingAllowed: false,
      requiresLegalReview: true,
    };
  }

  const policy = remedy.deadlinePolicy;
  const engineResult = evaluateRemedyDeadline(
    {
      jurisdiction: 'US',
      remedy: remedy.route,
      entryDate: input.entryDate ?? null,
      liquidationDate: input.liquidationDate ?? null,
      exportDate: input.exportDate ?? null,
      destructionDate: input.destructionDate ?? null,
      exclusionEffectiveDate: input.exclusionEffectiveDate ?? null,
    },
    [
      {
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        jurisdiction: 'US',
        remedy: remedy.route,
        anchorField: policy.anchorField,
        daysFromAnchor: policy.daysFromAnchor,
      } satisfies CustomsRemedyDeadlinePolicy,
    ],
    input.now,
  );

  const reasonCodes = [...engineResult.reasonCodes];
  if (policy.verification !== 'LEGAL_VERIFIED') reasonCodes.push('DEADLINE_POLICY_UNVERIFIED');

  return {
    candidate: remedy.candidate,
    route: remedy.route,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    verification: policy.verification,
    nominalDeadline: engineResult.deadline,
    nominalStatus: engineResult.status,
    status: policy.verification === 'LEGAL_VERIFIED' ? engineResult.status : 'INDETERMINATE',
    anchorUsed: engineResult.anchorUsed,
    reasonCodes,
    autoFilingAllowed: false,
    requiresLegalReview: policy.verification !== 'LEGAL_VERIFIED',
  };
}

export const US_RULE_PACK_BOUNDARY = {
  readOnly: true,
  decisionOnlyNoExecution: true,
  decidesEligibility: false,
  computesRecoverableAmount: false,
  determinesSuccessFeeEligibility: false,
  autoFilingAllowed: false,
  llmCannotDecideEligibility: true,
  unverifiedDeadlineIsIndeterminate: true,
  specialProvisions9801And9802AreNotDrawback: true,
  missingRulePackIsIndeterminate: true,
  forbidden: [
    'filing or transmitting anything to an authority or broker',
    'deciding eligibility or recoverable amount from the rule pack',
    'treating an unverified deadline policy as a legal conclusion',
    'treating HTS 9801 / 9802 as drawback basis',
    'hard-coding jurisdiction logic in business code outside the rule pack',
    'letting an LLM override the rule pack',
  ],
} as const;

export type UsRulePackErrorCode = 'US_RULE_PACK_CANNOT_DECIDE_OR_FILE';

export class UsRulePackError extends Error {
  readonly code: UsRulePackErrorCode;

  constructor(code: UsRulePackErrorCode, message: string) {
    super(message);
    this.name = 'UsRulePackError';
    this.code = code;
  }
}

/** 边界断言：任何把规则包当成「可自动申报 / 已判 eligibility / 已算金额」的记录都必须被拒绝 */
export function assertRulePackDoesNotDecideOrFile(record: {
  autoFilingAllowed?: boolean;
  decidesEligibility?: boolean;
  computesRecoverableAmount?: boolean;
}): void {
  if (
    record.autoFilingAllowed === true ||
    record.decidesEligibility === true ||
    record.computesRecoverableAmount === true
  ) {
    throw new UsRulePackError(
      'US_RULE_PACK_CANNOT_DECIDE_OR_FILE',
      '规则包只描述规则：不得自动申报、不得判定 eligibility、不得计算可退金额。',
    );
  }
}

/** DRAWBACK 专用：9801 / 9802 不得作为 drawback 依据 */
export function assertNotDrawbackHeading(hts: string | null | undefined): void {
  const digits = (hts ?? '').replace(/[^0-9]/g, '');
  if (digits.startsWith('9801') || digits.startsWith('9802')) {
    throw new UsRulePackError(
      'US_RULE_PACK_CANNOT_DECIDE_OR_FILE',
      'HTS 9801 / 9802 是特别条款，不能作为 drawback 依据。',
    );
  }
}
