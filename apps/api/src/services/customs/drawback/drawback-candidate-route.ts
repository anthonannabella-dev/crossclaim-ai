// CUSTOMS / DUTY RECOVERY — slice B-S8 — Drawback 专门路径（fail-closed，最高只到 CLAIM_READY）
// ---------------------------------------------------------------------------
// 定位：把「进口 entry + 证据链 + 出口/销毁/退货匹配 + 规则包 + 期限」收敛成一个**候选路由结论**，
//   四态：NOT_CANDIDATE / NEEDS_EVIDENCE / NEEDS_MANUAL_REVIEW / CLAIM_READY。
// 硬边界（HOST B-P9 / 硬边界）：
//   ① **最高只到 CLAIM_READY**：本模块没有 FILED / SUBMITTED / 自动申报出口；试图超越一律 fail-closed；
//   ② HTS 9801 / 9802 是特别条款，**不是** drawback → 直接 NOT_CANDIDATE；
//   ③ 期限政策未核验（v1 全部 UNVERIFIED）→ 不得达到 CLAIM_READY（只能到 NEEDS_MANUAL_REVIEW）；
//      只有调用方提供**经法务核验**（LEGAL_VERIFIED）的期限政策时才可能放行；
//   ④ 不计算可退金额（amountComputation=NOT_PERFORMED、estimatedRecoverableAmountUsd=null）、
//      不判 successFeeEligible、不扣佣：estimateOnly=true / billable=false / filingPerformed=false；
//   ⑤ 证据链非 COMPLETE、匹配非 EXACT、或存在 AMBIGUOUS/冲突 → 一律不上到 CLAIM_READY。

import { digestOf } from '../../config-execution-durability/digests';
import { assertNotDrawbackHeading, resolveJurisdictionRulePack, evaluateUsRemedyDeadline } from '../rule-pack/us-rule-pack-v1';
import { evaluateRemedyDeadline } from '../enterprise-ior/remedy-deadline';
import type { CustomsEvidenceChainResult } from '../../provider-support/customs-evidence-requirements';
import type { CustomsMatchResult } from '../../provider-support/customs-import-export-matching';

export const DRAWBACK_ROUTE_VERSION = 'drawback-candidate-route/v1';

export const DRAWBACK_DISPOSITIONS = [
  'NOT_CANDIDATE',
  'NEEDS_EVIDENCE',
  'NEEDS_MANUAL_REVIEW',
  'CLAIM_READY',
] as const;
export type DrawbackDisposition = (typeof DRAWBACK_DISPOSITIONS)[number];

export interface DrawbackDeadlinePolicyOverride {
  policyId: string;
  policyVersion: string;
  anchorField: 'entryDate' | 'liquidationDate' | 'exportDate' | 'destructionDate' | 'exclusionEffectiveDate';
  daysFromAnchor: number;
  /** 只有经法务核验（LEGAL_VERIFIED）的政策才能放行到 CLAIM_READY */
  verification: 'LEGAL_VERIFIED';
  verifiedBy?: string;
  verifiedAt?: string;
}

export interface DrawbackCandidateRouteInput {
  scope: { organizationId: string; platformAccountId: string };
  entryNumber: string;
  hts?: string | null;
  jurisdiction?: string | null;
  entryDate?: string | null;
  liquidationDate?: string | null;
  exportDate?: string | null;
  destructionDate?: string | null;
  /** B-S5 证据链结果（只读） */
  evidenceChain?: CustomsEvidenceChainResult | null;
  /** B-S6 匹配结果（出口 / 销毁 / 退货任一） */
  counterpartMatch?: CustomsMatchResult | null;
  /** 经法务核验的期限政策（可选输入；缺失则沿用未核验政策 → 不可能 CLAIM_READY） */
  verifiedDeadlinePolicy?: DrawbackDeadlinePolicyOverride | null;
  /** 任何试图直接申报/超越 CLAIM_READY 的调用必须 fail-closed */
  requestFiling?: boolean;
  now: Date;
}

export interface DrawbackGateResult {
  gate: string;
  passed: boolean;
  detail: string;
}

export interface DrawbackCandidateRoute {
  kind: 'DRAWBACK_CANDIDATE_ROUTE';
  version: string;
  organizationId: string;
  platformAccountId: string;
  entryNumber: string;
  jurisdiction: string | null;
  ruleSetId: string | null;
  ruleSetVersion: string | null;
  disposition: DrawbackDisposition;
  /** 恒为 CLAIM_READY：本模块不产生任何更进一步的执行态 */
  maxDisposition: 'CLAIM_READY';
  gates: DrawbackGateResult[];
  requiredEvidenceMissing: string[];
  blockingReasons: string[];
  deadline: {
    status: string;
    nominalDeadline: string | null;
    verification: string | null;
    reasonCodes: string[];
  };
  counterpart: {
    matchStatus: string | null;
    matchedRecordId: string | null;
  };
  amount: {
    estimatedRecoverableAmountUsd: null;
    amountComputation: 'NOT_PERFORMED';
  };
  estimateOnly: true;
  billable: false;
  filingPerformed: false;
  brokerFilingHandoffRequired: true;
  autoFilingAllowed: false;
  llmDecided: false;
  reasonCodes: string[];
  evaluatedAt: string | null;
  routeDigest: string;
}

export type DrawbackRouteErrorCode =
  | 'DRAWBACK_ROUTE_CANNOT_EXCEED_CLAIM_READY'
  | 'DRAWBACK_ROUTE_SPECIAL_PROVISION_IS_NOT_DRAWBACK';

export class DrawbackRouteError extends Error {
  readonly code: DrawbackRouteErrorCode;

  constructor(code: DrawbackRouteErrorCode, message: string) {
    super(message);
    this.name = 'DrawbackRouteError';
    this.code = code;
  }
}

/**
 * 评估 drawback 候选路由（纯函数，fail-closed）。
 * 只输出候选结论，最高 CLAIM_READY；不申报、不算金额、不收费。
 */
export function evaluateDrawbackCandidateRoute(input: DrawbackCandidateRouteInput): DrawbackCandidateRoute {
  if (input.requestFiling === true) {
    throw new DrawbackRouteError(
      'DRAWBACK_ROUTE_CANNOT_EXCEED_CLAIM_READY',
      'Drawback 路径最高只到 CLAIM_READY：不得申报、不得自动提交。',
    );
  }

  const jurisdictionInput = input.jurisdiction ?? 'US';
  const pack = resolveJurisdictionRulePack(jurisdictionInput);
  const gates: DrawbackGateResult[] = [];
  const blockingReasons: string[] = [];
  const reasonCodes: string[] = [];

  // ① 规则包
  const packGate = pack !== null;
  gates.push({
    gate: 'RULE_PACK_PRESENT',
    passed: packGate,
    detail: packGate ? `${pack?.ruleSetId}@${pack?.ruleSetVersion}` : 'NO_RULE_PACK_FOR_JURISDICTION',
  });
  if (!packGate) {
    reasonCodes.push('NO_RULE_PACK_FOR_JURISDICTION');
    blockingReasons.push('NO_RULE_PACK');
  }

  // ② 特别条款（9801 / 9802 不是 drawback）
  const digits = (input.hts ?? '').replace(/[^0-9]/g, '');
  const isSpecialProvision = digits.startsWith('9801') || digits.startsWith('9802');
  gates.push({
    gate: 'HTS_NOT_SPECIAL_PROVISION_9801_9802',
    passed: !isSpecialProvision,
    detail: isSpecialProvision ? `SPECIAL_PROVISION_${digits.slice(0, 4)}_IS_NOT_DRAWBACK` : 'OK',
  });
  if (isSpecialProvision) {
    reasonCodes.push('SPECIAL_PROVISION_IS_NOT_DRAWBACK');
    blockingReasons.push('SPECIAL_PROVISION_IS_NOT_DRAWBACK');
  }

  // ③ 证据链
  const chain = input.evidenceChain ?? null;
  const chainStatus = chain?.chainStatus ?? null;
  const evidenceGate = chainStatus === 'COMPLETE';
  gates.push({
    gate: 'EVIDENCE_CHAIN_COMPLETE',
    passed: evidenceGate,
    detail: chainStatus ?? 'NO_EVIDENCE_CHAIN',
  });
  if (!evidenceGate) {
    reasonCodes.push(chainStatus === null ? 'EVIDENCE_CHAIN_MISSING' : `EVIDENCE_CHAIN_${chainStatus}`);
    blockingReasons.push('EVIDENCE_NOT_COMPLETE');
  }

  // ④ 出口 / 销毁 / 退货匹配必须 EXACT 且唯一
  const match = input.counterpartMatch ?? null;
  const matchStatus = match?.status ?? null;
  const matchIsExact = matchStatus === 'EXACT';
  gates.push({
    gate: 'COUNTERPART_MATCH_EXACT',
    passed: matchIsExact,
    detail: matchStatus ?? 'NO_COUNTERPART_MATCH',
  });
  if (!matchIsExact) {
    reasonCodes.push(matchStatus === null ? 'COUNTERPART_MATCH_MISSING' : `COUNTERPART_MATCH_${matchStatus}`);
    blockingReasons.push('NO_EXACT_COUNTERPART_MATCH');
  }

  // ⑤ 期限（未核验政策 → INDETERMINATE，永远上不到 CLAIM_READY）
  const deadline = evaluateUsRemedyDeadline({
    jurisdiction: jurisdictionInput,
    candidate: 'DRAWBACK_CANDIDATE',
    entryDate: input.entryDate ?? null,
    liquidationDate: input.liquidationDate ?? null,
    exportDate: input.exportDate ?? null,
    destructionDate: input.destructionDate ?? null,
    now: input.now.toISOString(),
  });

  const override = input.verifiedDeadlinePolicy ?? null;
  let deadlineStatus = deadline.status;
  let deadlineVerification: string | null = deadline.verification;
  const deadlineReasonCodes = [...deadline.reasonCodes];
  let nominalDeadline = deadline.nominalDeadline;

  if (override && override.verification === 'LEGAL_VERIFIED' && override.daysFromAnchor > 0) {
    // 法务核验过的政策：交给同一既有期限引擎计算（不新写计算逻辑）
    const engineResult = evaluateRemedyDeadline(
      {
        jurisdiction: 'US',
        remedy: 'DRAWBACK',
        entryDate: input.entryDate ?? null,
        liquidationDate: input.liquidationDate ?? null,
        exportDate: input.exportDate ?? null,
        destructionDate: input.destructionDate ?? null,
        exclusionEffectiveDate: null,
      },
      [
        {
          policyId: override.policyId,
          policyVersion: override.policyVersion,
          jurisdiction: 'US',
          remedy: 'DRAWBACK',
          anchorField: override.anchorField,
          daysFromAnchor: override.daysFromAnchor,
        },
      ],
      input.now.toISOString(),
    );
    deadlineStatus = engineResult.status;
    nominalDeadline = engineResult.deadline;
    deadlineReasonCodes.push(...engineResult.reasonCodes, 'LEGAL_VERIFIED_POLICY_APPLIED');
    deadlineVerification = 'LEGAL_VERIFIED';
  }

  const deadlineGate = deadlineStatus === 'ELIGIBLE_WINDOW';
  gates.push({
    gate: 'DEADLINE_WINDOW_ELIGIBLE',
    passed: deadlineGate,
    detail: deadlineStatus,
  });
  if (!deadlineGate) {
    reasonCodes.push(`DEADLINE_${deadlineStatus}`);
    blockingReasons.push('DEADLINE_NOT_ELIGIBLE_WINDOW');
  }

  // 综合判定（fail-closed 顺序：特别条款 > 证据 > 期限/匹配冲突 > CLAIM_READY）
  let disposition: DrawbackDisposition;
  if (isSpecialProvision) {
    disposition = 'NOT_CANDIDATE';
  } else if (chainStatus === 'BLOCKED' || matchStatus === 'AMBIGUOUS') {
    disposition = 'NEEDS_MANUAL_REVIEW';
    reasonCodes.push('HUMAN_REVIEW_REQUIRED_FOR_CONFLICT_OR_AMBIGUITY');
  } else if (!packGate) {
    disposition = 'NEEDS_MANUAL_REVIEW';
  } else if (!evidenceGate || !matchIsExact) {
    // 证据缺口是**可执行**的下一步：先要材料，再谈期限
    disposition = 'NEEDS_EVIDENCE';
  } else if (!deadlineGate) {
    // 证据齐备但期限未核验/过期 → 属政策与法务问题，交人工
    disposition = 'NEEDS_MANUAL_REVIEW';
  } else {
    disposition = 'CLAIM_READY';
  }

  const requiredEvidenceMissing =
    chain === null
      ? ['*']
      : [...chain.missing, ...chain.partial, ...chain.lowConfidence].map((id) => String(id));

  const body = {
    version: DRAWBACK_ROUTE_VERSION,
    organizationId: input.scope.organizationId,
    platformAccountId: input.scope.platformAccountId,
    entryNumber: input.entryNumber,
    jurisdiction: pack ? pack.jurisdiction : null,
    ruleSetId: pack ? pack.ruleSetId : null,
    ruleSetVersion: pack ? pack.ruleSetVersion : null,
    disposition,
    maxDisposition: 'CLAIM_READY' as const,
    gates,
    requiredEvidenceMissing,
    blockingReasons: [...new Set(blockingReasons)].sort(),
    deadline: {
      status: deadlineStatus,
      nominalDeadline,
      verification: deadlineVerification,
      reasonCodes: [...new Set(deadlineReasonCodes)],
    },
    counterpart: {
      matchStatus,
      matchedRecordId: match?.bestMatch?.recordId ?? null,
    },
    amount: {
      estimatedRecoverableAmountUsd: null as null,
      amountComputation: 'NOT_PERFORMED' as const,
    },
    estimateOnly: true as const,
    billable: false as const,
    filingPerformed: false as const,
    brokerFilingHandoffRequired: true as const,
    autoFilingAllowed: false as const,
    llmDecided: false as const,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    evaluatedAt: input.now.toISOString(),
  };

  return {
    kind: 'DRAWBACK_CANDIDATE_ROUTE',
    ...body,
    routeDigest: digestOf(body),
  };
}

export const DRAWBACK_ROUTE_BOUNDARY = {
  maxDisposition: 'CLAIM_READY',
  autoFilingAllowed: false,
  filingPerformed: false,
  billable: false,
  estimateOnly: true,
  computesRecoverableAmount: false,
  determinesSuccessFeeEligibility: false,
  llmDecides: false,
  specialProvisions9801And9802AreNotDrawback: true,
  unverifiedDeadlineBlocksClaimReady: true,
  brokerFilingHandoffRequired: true,
  forbidden: [
    'filing or transmitting a drawback claim',
    'exceeding CLAIM_READY in any status field',
    'computing a recoverable duty amount',
    'charging a success fee on an estimate',
    'treating HTS 9801 / 9802 as drawback basis',
    'reaching CLAIM_READY with an unverified deadline policy',
  ],
} as const;

/** 边界断言：任何超越 CLAIM_READY / 已申报 / 已计费 / 已算金额的记录都必须被拒绝 */
export function assertDrawbackRouteIsFailClosed(record: {
  disposition?: DrawbackDisposition;
  autoFilingAllowed?: boolean;
  filingPerformed?: boolean;
  billable?: boolean;
  amountComputation?: string;
}): void {
  if (
    record.autoFilingAllowed === true ||
    record.filingPerformed === true ||
    record.billable === true ||
    (record.amountComputation !== undefined && record.amountComputation !== 'NOT_PERFORMED') ||
    (record.disposition !== undefined && !DRAWBACK_DISPOSITIONS.includes(record.disposition))
  ) {
    throw new DrawbackRouteError(
      'DRAWBACK_ROUTE_CANNOT_EXCEED_CLAIM_READY',
      'Drawback 路径最高只到 CLAIM_READY：不得申报、不得计费、不得计算金额。',
    );
  }
}

/** 便捷包装：HTS 为 9801/9802 时直接抛错（与规则包保持同一口径） */
export function assertDrawbackHtsNotSpecialProvision(hts: string | null | undefined): void {
  try {
    assertNotDrawbackHeading(hts);
  } catch {
    throw new DrawbackRouteError(
      'DRAWBACK_ROUTE_SPECIAL_PROVISION_IS_NOT_DRAWBACK',
      'HTS 9801 / 9802 是特别条款，不能作为 drawback 依据。',
    );
  }
}
