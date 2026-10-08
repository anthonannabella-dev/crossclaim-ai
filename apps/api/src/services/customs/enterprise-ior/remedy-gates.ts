// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 5 —— Customs remedy-specific 双 gate 模型（纯函数）
// ---------------------------------------------------------------------------
// HOST 要求：**不得**把 drawack / protest / PSC / exclusion refund 等统一成「5 年」。
// 每个 remedy 至少拆成两个彼此独立的 gate：
//   1) CLAIM_FILING_DEADLINE              —— 申报/主张本身的期限
//   2) EXPORT_OR_DESTRUCTION_QUALIFYING_WINDOW —— 使货物「符合退税条件」的事实窗口
// 并且：
//   * policy 必须 versioned；
//   * 未 LEGAL_VERIFIED → INDETERMINATE，**不得** CLAIM_READY、不得 filing；
//   * 缺 anchor / 缺 qualifying fact → INDETERMINATE（不猜测、不用统一年限兜底）；
//   * 本模块是纯函数：不调用 provider、不写库、不触发 filing。

import {
  CUSTOMS_REMEDY_ROUTES,
  type CustomsRemedyRoute,
} from './remedy-deadline';

export const REMEDY_GATE_VERIFICATION = ['UNVERIFIED', 'LEGAL_VERIFIED'] as const;
export type RemedyGateVerification = (typeof REMEDY_GATE_VERIFICATION)[number];

export const REMEDY_GATE_STATUSES = [
  'CLAIM_READY',
  'ELIGIBLE_WINDOW',
  'INDETERMINATE',
  'EXPIRED',
  'NOT_CANDIDATE',
] as const;
export type RemedyGateStatus = (typeof REMEDY_GATE_STATUSES)[number];

export type RemedyAnchorField =
  | 'entryDate'
  | 'liquidationDate'
  | 'exportDate'
  | 'destructionDate'
  | 'returnDate'
  | 'exclusionEffectiveDate';

export interface RemedyGateWindow {
  readonly anchorField: RemedyAnchorField;
  readonly daysFromAnchor: number;
}

export interface RemedyGatePolicy {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly jurisdiction: string;
  readonly remedy: CustomsRemedyRoute;
  readonly verification: RemedyGateVerification;
  /** 申报/主张期限（可为 null = 该 remedy 未建模该 gate → INDETERMINATE，不兜底） */
  readonly claimFilingDeadline: RemedyGateWindow | null;
  /** 出口/销毁/退货合格窗口（drawback 类 remedy 必需） */
  readonly qualifyingWindow: RemedyGateWindow | null;
  readonly legalBasisRef?: string;
}

export type RemedyFacts = Partial<Record<RemedyAnchorField, string | null>>;

export interface RemedyGateEvaluation {
  readonly status: RemedyGateStatus;
  readonly claimReadyAllowed: boolean;
  readonly requiresManualReview: boolean;
  readonly filingGate: { status: 'PASS' | 'EXPIRED' | 'INDETERMINATE'; deadline: string | null; reason: string };
  readonly qualifyingGate: { status: 'PASS' | 'EXPIRED' | 'INDETERMINATE'; deadline: string | null; reason: string };
  readonly reasonCodes: readonly string[];
  readonly policyId: string | null;
  readonly policyVersion: string | null;
  readonly verification: RemedyGateVerification | null;
  /** 边界：本模块永远不产生外部动作 */
  readonly autoFilingAllowed: false;
  readonly callsExpensiveProvider: false;
}

const MS_PER_DAY = 86_400_000;

function evaluateGate(
  window: RemedyGateWindow | null,
  facts: RemedyFacts,
  nowMs: number,
  codePrefix: string,
): { status: 'PASS' | 'EXPIRED' | 'INDETERMINATE'; deadline: string | null; reason: string } {
  if (!window) {
    return { status: 'INDETERMINATE', deadline: null, reason: codePrefix + '_GATE_NOT_MODELED' };
  }
  const anchor = facts[window.anchorField] ?? null;
  if (!anchor) {
    return { status: 'INDETERMINATE', deadline: null, reason: 'MISSING_ANCHOR:' + window.anchorField };
  }
  const anchorMs = Date.parse(anchor);
  if (Number.isNaN(anchorMs)) {
    return { status: 'INDETERMINATE', deadline: null, reason: 'INVALID_ANCHOR:' + window.anchorField };
  }
  const deadlineMs = anchorMs + window.daysFromAnchor * MS_PER_DAY;
  const deadline = new Date(deadlineMs).toISOString().slice(0, 10);
  if (deadlineMs < nowMs) {
    return { status: 'EXPIRED', deadline, reason: 'DEADLINE_PASSED:' + window.anchorField };
  }
  return { status: 'PASS', deadline, reason: 'OK' };
}

/**
 * 评估某 remedy 的两个 gate。**只有两个 gate 都 PASS 且 policy LEGAL_VERIFIED 才允许 CLAIM_READY。**
 */
export function evaluateRemedyGates(input: {
  readonly jurisdiction: string;
  readonly remedy: string;
  readonly facts: RemedyFacts;
  readonly now: string;
  readonly policies: readonly RemedyGatePolicy[];
}): RemedyGateEvaluation {
  const remedy = String(input.remedy ?? '').toUpperCase();
  const nowMs = Date.parse(input.now);
  const policy = input.policies.find(
    (candidate) => candidate.jurisdiction === input.jurisdiction && candidate.remedy === remedy,
  );

  if (!policy) {
    return {
      status: 'INDETERMINATE',
      claimReadyAllowed: false,
      requiresManualReview: true,
      filingGate: { status: 'INDETERMINATE', deadline: null, reason: 'NO_POLICY_FOR_JURISDICTION_REMEDY' },
      qualifyingGate: { status: 'INDETERMINATE', deadline: null, reason: 'NO_POLICY_FOR_JURISDICTION_REMEDY' },
      reasonCodes: ['NO_POLICY_FOR_JURISDICTION_REMEDY'],
      policyId: null,
      policyVersion: null,
      verification: null,
      autoFilingAllowed: false,
      callsExpensiveProvider: false,
    };
  }

  const filingGate = evaluateGate(policy.claimFilingDeadline, input.facts, nowMs, 'FILING');
  const qualifyingGate = evaluateGate(policy.qualifyingWindow, input.facts, nowMs, 'QUALIFYING');
  const reasons: string[] = [];

  const unverified = policy.verification !== 'LEGAL_VERIFIED';
  if (unverified) reasons.push('RULE_UNVERIFIED');

  const anyIndeterminate = filingGate.status === 'INDETERMINATE' || qualifyingGate.status === 'INDETERMINATE';
  const anyExpired = filingGate.status === 'EXPIRED' || qualifyingGate.status === 'EXPIRED';

  if (anyIndeterminate) {
    reasons.push('GATE_INDETERMINATE');
    for (const gate of [filingGate, qualifyingGate]) {
      if (gate.status === 'INDETERMINATE') reasons.push(gate.reason);
    }
  }
  if (anyExpired) reasons.push('GATE_EXPIRED');

  let status: RemedyGateStatus;
  if (unverified || anyIndeterminate) status = 'INDETERMINATE';
  else if (anyExpired) status = 'EXPIRED';
  else status = 'CLAIM_READY';

  // 未核验政策一律不得进入 CLAIM_READY（也不得触发 filing）
  const claimReadyAllowed = status === 'CLAIM_READY' && policy.verification === 'LEGAL_VERIFIED';

  return {
    status: claimReadyAllowed ? 'CLAIM_READY' : status,
    claimReadyAllowed,
    requiresManualReview: status === 'INDETERMINATE',
    filingGate,
    qualifyingGate,
    reasonCodes: reasons.length > 0 ? reasons : ['OK'],
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    verification: policy.verification,
    autoFilingAllowed: false,
    callsExpensiveProvider: false,
  };
}

export const REMEDY_GATE_BOUNDARY = {
  /** 明确声明：不得存在「全球统一 3–5 年」规则 */
  globalUniformYearRule: false,
  /** 未 LEGAL_VERIFIED → 不得 CLAIM_READY */
  unverifiedBlocksClaimReady: true,
  twoIndependentGatesRequired: true,
  autoFilingAllowed: false,
  callsExpensiveProvider: false,
  supportedRemedyRoutes: CUSTOMS_REMEDY_ROUTES,
} as const;
