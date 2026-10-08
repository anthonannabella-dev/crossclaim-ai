// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 8 —— Customs 历史管线（**复用**既有链）
// ---------------------------------------------------------------------------
// 约束（HOST）：
//   * 不得新建第二套 Customs truth / Eligibility / Evidence / Deadline engine；
//   * 本模块只是**组合层**：把历史扫描放行出来的 entry 交给既有
//     `evaluateDrawbackCandidateRoute()`（其内部已复用 evidence chain / match / deadline / rule pack）；
//   * 结果只允许四种：CLAIM_READY / NEEDS_EVIDENCE / NEEDS_MANUAL_REVIEW / NOT_CANDIDATE；
//   * 任一记录若出现 filing / billable / autoFiling 为真 → 整批 fail-closed（边界回归保护）；
//   * LLM 不参与法律期限判定（本模块不调用任何模型）。

import {
  evaluateDrawbackCandidateRoute,
  type DrawbackCandidateRoute,
  type DrawbackCandidateRouteInput,
} from '../customs/drawback/drawback-candidate-route';

/**
 * AUDIT-1 / CHANGE 1（MSG-20261008-01）：
 * PHASE 8 **必须消费** PHASE 4 的 `blocksClaimReady`，而不是让既有 drawback route
 * 用 `jurisdiction ?? 'US'` 的默认值把「缺 jurisdiction」悄悄变成 US 规则。
 * 同时缺 jurisdiction 本身也一律不得进入 CLAIM_READY（双保险，不新建第二套规则）。
 */
export interface CustomsHistoricalWindowGate {
  readonly blocksClaimReady: boolean;
  readonly reasonCodes: readonly string[];
}

export type CustomsHistoricalCandidateInput = DrawbackCandidateRouteInput & {
  readonly historicalWindow?: CustomsHistoricalWindowGate | null;
};

export const CUSTOMS_HISTORICAL_OUTCOMES = [
  'CLAIM_READY',
  'NEEDS_EVIDENCE',
  'NEEDS_MANUAL_REVIEW',
  'NOT_CANDIDATE',
] as const;
export type CustomsHistoricalOutcome = (typeof CUSTOMS_HISTORICAL_OUTCOMES)[number];

export interface CustomsHistoricalCandidateResult {
  readonly entryNumber: string;
  readonly outcome: CustomsHistoricalOutcome;
  readonly route: DrawbackCandidateRoute;
  readonly reasonCodes: readonly string[];
  /** 恒定边界（由既有 drawback route 保证，这里复核后固化） */
  readonly filingPerformed: false;
  readonly billable: false;
  readonly paymentPerformed: false;
  readonly externalWritePerformed: false;
  readonly autoFilingAllowed: false;
  readonly llmDecided: false;
}

export class CustomsHistoricalBoundaryError extends Error {
  readonly code = 'CUSTOMS_HISTORICAL_BOUNDARY_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'CustomsHistoricalBoundaryError';
  }
}

/** 单条历史 entry：复用既有 drawback 路径，并把 disposition 映射为四种历史结果之一。 */
export function evaluateCustomsHistoricalCandidate(
  input: CustomsHistoricalCandidateInput,
): CustomsHistoricalCandidateResult {
  if (input.requestFiling === true) {
    // 历史扫描永远不申报；显式拒绝而不是静默忽略
    throw new CustomsHistoricalBoundaryError('CUSTOMS_HISTORICAL_CANNOT_REQUEST_FILING');
  }
  const { historicalWindow, ...routeInput } = input;
  const route = evaluateDrawbackCandidateRoute({ ...routeInput, requestFiling: false });

  if (route.filingPerformed !== false || route.billable !== false || route.autoFilingAllowed !== false) {
    throw new CustomsHistoricalBoundaryError('CUSTOMS_HISTORICAL_ROUTE_NOT_FAIL_CLOSED');
  }
  if (!(CUSTOMS_HISTORICAL_OUTCOMES as readonly string[]).includes(route.disposition)) {
    throw new CustomsHistoricalBoundaryError('CUSTOMS_HISTORICAL_UNKNOWN_DISPOSITION:' + route.disposition);
  }

  // AUDIT-1 / CHANGE 1：consumption of the historical window gate（缺 jurisdiction / blocksClaimReady → 降级）
  const jurisdictionMissing = input.jurisdiction === null || input.jurisdiction === undefined || String(input.jurisdiction).trim() === '';
  const gateBlocks = historicalWindow?.blocksClaimReady === true;
  const gateReasonCodes = [
    ...(jurisdictionMissing ? ['MISSING_JURISDICTION'] : []),
    ...(gateBlocks ? ['HISTORICAL_WINDOW_BLOCKS_CLAIM_READY'] : []),
    ...(historicalWindow?.reasonCodes ?? []),
  ];
  const disposition = route.disposition;
  const outcome: CustomsHistoricalOutcome =
    (jurisdictionMissing || gateBlocks) && disposition === 'CLAIM_READY'
      ? 'NEEDS_MANUAL_REVIEW'
      : (disposition as CustomsHistoricalOutcome);

  return {
    entryNumber: route.entryNumber,
    outcome,
    route,
    reasonCodes: [...new Set([...route.reasonCodes, ...gateReasonCodes])],
    filingPerformed: false,
    billable: false,
    paymentPerformed: false,
    externalWritePerformed: false,
    autoFilingAllowed: false,
    llmDecided: false,
  };
}

export interface CustomsHistoricalBatchSummary {
  readonly scanned: number;
  readonly claimReady: number;
  readonly needsEvidence: number;
  readonly needsManualReview: number;
  readonly notCandidate: number;
  readonly expired: number;
  /** 可进入「机会 / 有效窗口」计数（CLAIM_READY + NEEDS_EVIDENCE + NEEDS_MANUAL_REVIEW） */
  readonly opportunitiesSurfaced: number;
  readonly boundaryVerified: true;
  readonly filingPerformed: false;
  readonly billable: false;
  readonly paymentPerformed: false;
  readonly externalWritePerformed: false;
}

export interface CustomsHistoricalBatchResult {
  readonly results: readonly CustomsHistoricalCandidateResult[];
  readonly summary: CustomsHistoricalBatchSummary;
}

const EXPIRED_REASON_CODES: readonly string[] = ['DEADLINE_PASSED', 'EXPIRED', 'DEADLINE_EXPIRED', 'WINDOW_EXPIRED'];

function isExpired(route: DrawbackCandidateRoute): boolean {
  return route.reasonCodes.some((code) => EXPIRED_REASON_CODES.some((token) => code.includes(token)));
}

/**
 * 批量评估（历史分片内的一批 entry）。任一记录触发边界回归 → **整批 fail-closed**（不产出部分结果）。
 */
export function evaluateCustomsHistoricalBatch(
  candidates: readonly CustomsHistoricalCandidateInput[],
): CustomsHistoricalBatchResult {
  const results: CustomsHistoricalCandidateResult[] = [];
  for (const candidate of candidates) {
    results.push(evaluateCustomsHistoricalCandidate(candidate));
  }

  const count = (outcome: CustomsHistoricalOutcome) => results.filter((row) => row.outcome === outcome).length;
  const summary: CustomsHistoricalBatchSummary = {
    scanned: results.length,
    claimReady: count('CLAIM_READY'),
    needsEvidence: count('NEEDS_EVIDENCE'),
    needsManualReview: count('NEEDS_MANUAL_REVIEW'),
    notCandidate: count('NOT_CANDIDATE'),
    expired: results.filter((row) => isExpired(row.route)).length,
    opportunitiesSurfaced: results.filter((row) => row.outcome !== 'NOT_CANDIDATE').length,
    boundaryVerified: true,
    filingPerformed: false,
    billable: false,
    paymentPerformed: false,
    externalWritePerformed: false,
  };
  return { results, summary };
}

export const CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY = {
  reusesExistingChain: true,
  secondCustomsTruth: false,
  secondEligibilityEngine: false,
  secondEvidenceEngine: false,
  secondDeadlineEngine: false,
  maxDisposition: 'CLAIM_READY',
  autoFilingAllowed: false,
  filingPerformed: false,
  billable: false,
  paymentPerformed: false,
  llmDecidesDeadlines: false,
} as const;
