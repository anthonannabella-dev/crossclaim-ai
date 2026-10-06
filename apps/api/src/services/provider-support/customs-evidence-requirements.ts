// CUSTOMS / DUTY RECOVERY — slice B-S5 — 通用 Evidence Resolver 接入 Customs
// ---------------------------------------------------------------------------
// 把 A-S5 的通用证据解析器接到 Customs 场景：给出**需求目录**（Entry / EntryLine / Invoice / POD /
// Return / Export / Destruction / Carrier / Broker / DutyPayment）→ 逐项解析 → 汇总成**证据链状态**。
// 硬边界：
//   ① 只读解析既有证据资产：不创建证据、不写 Customs Truth、不判定 eligibility / 金额 / 佣金；
//   ② 证据链「完整」只代表材料齐备，**不等于**可申报、可退税、可收费；
//   ③ 冲突 / 歧义一律 fail-closed（不自动择优、不用 last-write-wins）；
//   ④ tenant / account 严格隔离（解析器在查询层与决策层双重过滤）。

import { digestOf } from '../config-execution-durability/digests';
import type { DocumentKind } from './document-types';
import {
  resolveRequiredEvidence,
  type EvidenceQueryKey,
  type EvidenceResolutionRequest,
  type EvidenceResolutionResult,
  type EvidenceScope,
  type EvidenceSourcePort,
} from './evidence-resolver';

export const CUSTOMS_EVIDENCE_REQUIREMENTS_VERSION = 'customs-evidence-requirements/v1';

export const CUSTOMS_EVIDENCE_REQUIREMENT_IDS = [
  'ENTRY_RECORD',
  'ENTRY_LINE',
  'COMMERCIAL_INVOICE',
  'POD',
  'RETURN_RECORD',
  'EXPORT_RECORD',
  'DESTRUCTION_RECORD',
  'CARRIER_PROOF',
  'BROKER_CASE',
  'DUTY_PAYMENT',
] as const;
export type CustomsEvidenceRequirementId = (typeof CUSTOMS_EVIDENCE_REQUIREMENT_IDS)[number];

/**
 * 证据链用途标签。仅用于**筛选需求集合**，不构成任何权利判定
 * （权利/期限/金额一律由 B-S7 rule pack 与人工确认决定）。
 */
export const CUSTOMS_EVIDENCE_TAGS = [
  'DUTY_RECOVERY',
  'DRAWBACK',
  'RETURN',
  'EXPORT',
  'DESTRUCTION',
  'CLASSIFICATION',
  'BROKER_HANDOFF',
] as const;
export type CustomsEvidenceTag = (typeof CUSTOMS_EVIDENCE_TAGS)[number];

export interface CustomsEvidenceRequirement {
  id: CustomsEvidenceRequirementId;
  label: string;
  /** 期望的文档种类（B-S2 分类结果的种类） */
  documentKinds: readonly DocumentKind[];
  /** 可接受的既有证据资产 kind（EvidenceKind 枚举值） */
  acceptableEvidenceKinds: readonly string[];
  /** 用于核对同一票货/同一 entry 的键 */
  requiredKeys: readonly EvidenceQueryKey[];
  appliesTo: readonly CustomsEvidenceTag[];
}

export const CUSTOMS_EVIDENCE_REQUIREMENTS: Record<CustomsEvidenceRequirementId, CustomsEvidenceRequirement> = {
  ENTRY_RECORD: {
    id: 'ENTRY_RECORD',
    label: 'Entry / 报关记录',
    documentKinds: ['CBP_7501', 'ACE_ENTRY_RECORD', 'BROKER_ENTRY_RECORD'],
    acceptableEvidenceKinds: ['CUSTOMS_DOC'],
    requiredKeys: ['entryNumber'],
    appliesTo: ['DUTY_RECOVERY', 'DRAWBACK', 'CLASSIFICATION', 'BROKER_HANDOFF'],
  },
  ENTRY_LINE: {
    id: 'ENTRY_LINE',
    label: 'Entry 行项目（HTS / 价值 / 税率）',
    documentKinds: ['CBP_7501', 'ACE_ENTRY_RECORD'],
    acceptableEvidenceKinds: ['CUSTOMS_DOC'],
    requiredKeys: ['entryNumber', 'hts'],
    appliesTo: ['DUTY_RECOVERY', 'CLASSIFICATION'],
  },
  COMMERCIAL_INVOICE: {
    id: 'COMMERCIAL_INVOICE',
    label: '商业/采购发票',
    documentKinds: ['COMMERCIAL_INVOICE', 'PURCHASE_INVOICE'],
    acceptableEvidenceKinds: ['INVOICE'],
    requiredKeys: ['invoiceNo'],
    appliesTo: ['DUTY_RECOVERY', 'DRAWBACK'],
  },
  POD: {
    id: 'POD',
    label: '签收证明（POD）',
    documentKinds: ['POD', 'TRACKING_CONFIRMATION'],
    // 每项需求对应**单一**证据 kind 槽位，避免同一份材料同时满足多项需求导致「多候选全匹配 → AMBIGUOUS」
    acceptableEvidenceKinds: ['POD'],
    requiredKeys: ['trackingNumber'],
    appliesTo: ['DUTY_RECOVERY', 'RETURN'],
  },
  RETURN_RECORD: {
    id: 'RETURN_RECORD',
    label: '退货记录 / RMA',
    documentKinds: ['RETURN_RECORD'],
    acceptableEvidenceKinds: ['CUSTOMS_DOC', 'EMAIL'],
    requiredKeys: ['trackingNumber'],
    appliesTo: ['RETURN'],
  },
  EXPORT_RECORD: {
    id: 'EXPORT_RECORD',
    label: '出口记录 / 出口申报',
    documentKinds: ['EXPORT_RECORD'],
    acceptableEvidenceKinds: ['CUSTOMS_DOC', 'TRACKING'],
    requiredKeys: ['trackingNumber'],
    appliesTo: ['EXPORT', 'DRAWBACK'],
  },
  DESTRUCTION_RECORD: {
    id: 'DESTRUCTION_RECORD',
    label: '销毁证明',
    documentKinds: ['DESTRUCTION_RECORD'],
    acceptableEvidenceKinds: ['CUSTOMS_DOC', 'EMAIL'],
    requiredKeys: ['trackingNumber'],
    appliesTo: ['DESTRUCTION', 'DRAWBACK'],
  },
  CARRIER_PROOF: {
    id: 'CARRIER_PROOF',
    label: '承运商凭证（递送/轨迹）',
    documentKinds: ['POD', 'TRACKING_CONFIRMATION'],
    acceptableEvidenceKinds: ['TRACKING'],
    requiredKeys: ['trackingNumber'],
    appliesTo: ['DUTY_RECOVERY', 'RETURN', 'EXPORT'],
  },
  BROKER_CASE: {
    id: 'BROKER_CASE',
    label: '报关行往来/案件记录',
    documentKinds: ['BROKER_ENTRY_RECORD', 'CBP_28', 'CBP_29'],
    acceptableEvidenceKinds: ['BROKER_CORRESPONDENCE'],
    requiredKeys: ['entryNumber'],
    appliesTo: ['BROKER_HANDOFF', 'CLASSIFICATION'],
  },
  DUTY_PAYMENT: {
    id: 'DUTY_PAYMENT',
    label: '已缴关税凭证',
    documentKinds: ['DUTY_PAYMENT_RECORD'],
    acceptableEvidenceKinds: ['CUSTOMS_DOC'],
    requiredKeys: ['entryNumber'],
    appliesTo: ['DUTY_RECOVERY', 'DRAWBACK'],
  },
};

export function requirementsForTag(tag: CustomsEvidenceTag): CustomsEvidenceRequirement[] {
  return CUSTOMS_EVIDENCE_REQUIREMENT_IDS.map((id) => CUSTOMS_EVIDENCE_REQUIREMENTS[id]).filter((requirement) =>
    requirement.appliesTo.includes(tag),
  );
}

/** 把需求 + 期望键值转成 A-S5 的解析请求（expected 只传调用方提供的键，不猜） */
export function requirementToRequest(
  id: CustomsEvidenceRequirementId,
  expected: Partial<Record<EvidenceQueryKey, string>>,
): EvidenceResolutionRequest {
  const requirement = CUSTOMS_EVIDENCE_REQUIREMENTS[id];
  return {
    requirement: {
      kind: requirement.id,
      acceptableKinds: requirement.acceptableEvidenceKinds,
      requiredKeys: requirement.requiredKeys,
    },
    expected,
  };
}

export const CUSTOMS_CHAIN_STATUSES = ['COMPLETE', 'PARTIAL', 'BLOCKED', 'INSUFFICIENT'] as const;
export type CustomsChainStatus = (typeof CUSTOMS_CHAIN_STATUSES)[number];

export interface CustomsRequirementOutcome {
  id: CustomsEvidenceRequirementId;
  label: string;
  status: EvidenceResolutionResult['status'];
  evidenceReferences: string[];
  missingKeys: string[];
  conflicts: EvidenceResolutionResult['conflicts'];
  confidenceBp: number;
  resultDigest: string;
}

export interface CustomsEvidenceChainResult {
  kind: 'CUSTOMS_EVIDENCE_CHAIN';
  version: string;
  organizationId: string;
  platformAccountId: string;
  tag: CustomsEvidenceTag | null;
  outcomes: CustomsRequirementOutcome[];
  chainStatus: CustomsChainStatus;
  found: CustomsEvidenceRequirementId[];
  partial: CustomsEvidenceRequirementId[];
  missing: CustomsEvidenceRequirementId[];
  lowConfidence: CustomsEvidenceRequirementId[];
  blockedBy: CustomsEvidenceRequirementId[];
  /** 仅表示材料齐备，**不代表**可申报 / 可退税 / 可收费 */
  mayProceedToClaimPreparation: boolean;
  evidenceCompleteDoesNotImplyEligibility: true;
  mutatesEvidence: false;
  decidesEligibility: false;
  requiresManualReview: boolean;
  reasons: string[];
  evaluatedAt: string | null;
  chainDigest: string;
}

export type CustomsEvidenceChainErrorCode =
  | 'CUSTOMS_EVIDENCE_SCOPE_MISMATCH'
  | 'CUSTOMS_EVIDENCE_CHAIN_CANNOT_AUTHORIZE';

export class CustomsEvidenceChainError extends Error {
  readonly code: CustomsEvidenceChainErrorCode;

  constructor(code: CustomsEvidenceChainErrorCode, message: string) {
    super(message);
    this.name = 'CustomsEvidenceChainError';
    this.code = code;
  }
}

/**
 * 解析 Customs 证据链（只读）。
 * 结果只描述「哪些材料已具备 / 缺失 / 冲突」，不产生任何权利结论。
 */
export async function resolveCustomsEvidenceChain(input: {
  scope: EvidenceScope;
  expected: Partial<Record<EvidenceQueryKey, string>>;
  source: EvidenceSourcePort;
  requirementIds?: readonly CustomsEvidenceRequirementId[];
  tag?: CustomsEvidenceTag | null;
  confidenceThresholdBp?: number;
  now?: Date;
}): Promise<CustomsEvidenceChainResult> {
  const ids = input.requirementIds ?? CUSTOMS_EVIDENCE_REQUIREMENT_IDS;
  const requests = ids.map((id) => requirementToRequest(id, input.expected));

  const results = await resolveRequiredEvidence({
    scope: input.scope,
    requirements: requests,
    source: input.source,
    ...(input.confidenceThresholdBp !== undefined
      ? { confidenceThresholdBp: input.confidenceThresholdBp }
      : {}),
  });

  const outcomes: CustomsRequirementOutcome[] = results.map((result, index) => {
    const id = ids[index];
    const requirement = CUSTOMS_EVIDENCE_REQUIREMENTS[id];
    if (
      result.scope.organizationId !== input.scope.organizationId ||
      result.scope.platformAccountId !== input.scope.platformAccountId
    ) {
      throw new CustomsEvidenceChainError(
        'CUSTOMS_EVIDENCE_SCOPE_MISMATCH',
        '解析结果范围与请求范围不一致，禁止跨 tenant / account 汇总。',
      );
    }
    return {
      id,
      label: requirement.label,
      status: result.status,
      evidenceReferences: [...result.evidenceReferences],
      missingKeys: result.missingEvidence.flatMap((entry) => [...entry.missingKeys]),
      conflicts: result.conflicts,
      confidenceBp: result.confidenceBp,
      resultDigest: result.resultDigest,
    };
  });

  const found = outcomes.filter((o) => o.status === 'FOUND').map((o) => o.id);
  const partial = outcomes.filter((o) => o.status === 'PARTIAL').map((o) => o.id);
  const missing = outcomes.filter((o) => o.status === 'MISSING').map((o) => o.id);
  const lowConfidence = outcomes.filter((o) => o.status === 'LOW_CONFIDENCE').map((o) => o.id);
  const blockedBy = outcomes
    .filter((o) => o.status === 'CONFLICT' || o.status === 'AMBIGUOUS')
    .map((o) => o.id);

  const reasons: string[] = [];
  if (blockedBy.length > 0) reasons.push('CONFLICT_OR_AMBIGUOUS:' + blockedBy.join(','));
  if (missing.length > 0) reasons.push('MISSING:' + missing.join(','));
  if (partial.length > 0) reasons.push('PARTIAL:' + partial.join(','));
  if (lowConfidence.length > 0) reasons.push('LOW_CONFIDENCE:' + lowConfidence.join(','));

  let chainStatus: CustomsChainStatus;
  if (blockedBy.length > 0) chainStatus = 'BLOCKED';
  else if (missing.length > 0) chainStatus = 'INSUFFICIENT';
  else if (partial.length > 0 || lowConfidence.length > 0) chainStatus = 'PARTIAL';
  else chainStatus = 'COMPLETE';

  const body = {
    version: CUSTOMS_EVIDENCE_REQUIREMENTS_VERSION,
    organizationId: input.scope.organizationId,
    platformAccountId: input.scope.platformAccountId,
    tag: input.tag ?? null,
    outcomes,
    chainStatus,
    found,
    partial,
    missing,
    lowConfidence,
    blockedBy,
    mayProceedToClaimPreparation: chainStatus === 'COMPLETE',
    evidenceCompleteDoesNotImplyEligibility: true as const,
    mutatesEvidence: false as const,
    decidesEligibility: false as const,
    requiresManualReview: chainStatus !== 'COMPLETE',
    reasons,
    evaluatedAt: input.now ? input.now.toISOString() : null,
  };

  return {
    kind: 'CUSTOMS_EVIDENCE_CHAIN',
    ...body,
    chainDigest: digestOf(body),
  };
}

export const CUSTOMS_EVIDENCE_BOUNDARY = {
  readOnly: true,
  mutatesEvidence: false,
  writesCustomsTruth: false,
  decidesEligibility: false,
  computesRecoverableAmount: false,
  determinesSuccessFeeEligibility: false,
  evidenceCompleteMeansEligible: false,
  crossTenantOrAccountForbidden: true,
  conflictNeverAutoResolved: true,
  forbidden: [
    'treating an evidence-complete chain as filing eligibility',
    'creating or mutating evidence while resolving',
    'resolving using another tenant or platform account',
    'auto-resolving conflicting evidence',
    'claiming a refund amount from evidence resolution',
  ],
} as const;

/** 边界断言：任何把证据链结论当成「可申报 / 可退税 / 可收费」的记录都必须被拒绝 */
export function assertChainDoesNotAuthorize(record: {
  chainStatus?: CustomsChainStatus;
  mayProceedToClaimPreparation?: boolean;
  decidesEligibility?: boolean;
}): void {
  if (record.decidesEligibility === true) {
    throw new CustomsEvidenceChainError(
      'CUSTOMS_EVIDENCE_CHAIN_CANNOT_AUTHORIZE',
      '证据链结论不能判定 eligibility，也不能授权申报或收费。',
    );
  }
  if (record.mayProceedToClaimPreparation === true && record.chainStatus !== undefined && record.chainStatus !== 'COMPLETE') {
    throw new CustomsEvidenceChainError(
      'CUSTOMS_EVIDENCE_CHAIN_CANNOT_AUTHORIZE',
      '只有证据链完整（COMPLETE）才允许进入材料准备环节。',
    );
  }
}
