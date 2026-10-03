/**
 * R45 S3 —— deterministic projector（**纯计算层**，无 IO）
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261002-48（R45 S2 = PASS → S2 CLOSED → 批准进入 S3）。
 * 范围冻结：immutable facts + effective basis + effective tolerance policy + 已存在的合法 override inputs
 *   → deterministic computation →（由 projector.ts 持久化为 Projection + ProjectionFact membership）。
 * **不得**把旧 Projection 当业务计算输入（旧 Projection 只用于 CAS/version coordination）。
 *
 * 状态口径（v1，确定性）：
 *   - AMBIGUOUS：存在 currency mismatch（不自动换汇）/ conflicting evidence / 超过容差的过度回收；
 *   - UNMATCHED：无可用（未被 override 排除的）已匹配事实，或不存在可比较金额；
 *   - MATCHED：已有匹配事实，但**没有** effective expected basis（无法判定完整性，绝不宣称 recovered）；
 *   - PARTIALLY_RECONCILED：net < expected 且超出容差；
 *   - FULLY_RECONCILED：|net − expected| ≤ max(absoluteTolerance, expected × relativeTolerance)。
 *
 * 金额一律用 4 位定点 BigInt 运算（禁浮点），容差策略来自 effective policy（v1 默认 exact 0/0）。
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '../platform-write/snapshot';

export const PROJECTION_STATUSES = [
  'UNMATCHED',
  'AMBIGUOUS',
  'MATCHED',
  'PARTIALLY_RECONCILED',
  'FULLY_RECONCILED',
] as const;

export type ProjectionStatus = (typeof PROJECTION_STATUSES)[number];

/** 投影算法版本：参与 inputDigest（CHANGE B：algorithm/version 变化必须产生新 digest） */
export const PROJECTION_ALGORITHM_VERSION = 'reconciliation-projection/v1';

/**
 * 状态语义（MSG-20261002-49 ② 冻结）：**MATCHED 不是 recovered**。
 * UI / API / audit 一律不得把 MATCHED 描述为 recovered / fully recovered / reimbursement complete / billable。
 */
export const PROJECTION_STATUS_MEANINGS: Record<ProjectionStatus, string> = {
  UNMATCHED: '无计入事实（net = 0）',
  MATCHED: '事实已唯一关联到该 Claim，但缺少有效 ExpectedRecoveryBasis —— 无法判断 PARTIAL/FULL，**不代表 recovered / fully recovered / reimbursement complete / billable**',
  PARTIALLY_RECONCILED: 'net < expected 且超出容差（部分对账）',
  FULLY_RECONCILED: '在容差内达到 expected（仅表示对账完成，不代表已可计费）',
  AMBIGUOUS: 'fail-closed 异常态：匹配歧义（多候选 / conflicting evidence / currency mismatch）或金额异常（AMOUNT_EXCEEDS_EXPECTED）',
};

const SCALE = 4;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

export class ProjectionComputeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(code + ': ' + message);
    this.name = 'ProjectionComputeError';
    this.code = code;
  }
}

/** 十进制 → 4 位定点 BigInt（不接受科学计数法 / 非有限值）。 */
export function toScaled(value: string): bigint {
  const text = String(value ?? '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new ProjectionComputeError('DECIMAL_INVALID', '非十进制字面量: ' + text);
  }
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [intPart, fracPart = ''] = body.split('.');
  const frac = (fracPart + '0'.repeat(SCALE)).slice(0, SCALE);
  const scaled = BigInt(intPart) * SCALE_FACTOR + BigInt(frac.length > 0 ? frac : '0');
  return negative ? -scaled : scaled;
}

/** 4 位定点 BigInt → 十进制字符串（恒定 4 位小数，便于逐字节比较）。 */
export function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const intPart = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(SCALE, '0');
  return (negative ? '-' : '') + intPart.toString() + '.' + frac;
}

export interface ProjectionFactInput {
  id: string;
  /** 已观察金额（> 0），十进制字符串 */
  amount: string;
  currency: string;
  providerEventId: string | null;
  providerCaseRefCanonical: string | null;
  occurredAt: string;
}

export interface ProjectionBasisInput {
  id: string;
  expectedRecoveryAmount: string;
  currency: string;
  basisVersion: string;
}

export interface ProjectionPolicyInput {
  id: string;
  policyVersion: string;
  absoluteTolerance: string;
  relativeTolerance: string;
}

export interface ProjectionOverrideInput {
  reimbursementFactId: string;
  decisionKind: 'MATCHED' | 'UNMATCHED';
}

export interface ProjectionComputationInput {
  claimItemId: string;
  /** **有效**（未被冲正）的 OBSERVED 事实；由调用方在锁内固定 */
  facts: ProjectionFactInput[];
  basis: ProjectionBasisInput | null;
  policy: ProjectionPolicyInput;
  overrides: ProjectionOverrideInput[];
}

export interface ProjectionComputation {
  status: ProjectionStatus;
  basisId: string | null;
  expectedAmount: string | null;
  currency: string | null;
  netMatchedObservedAmount: string;
  /** 计入 net 的事实（摘要缓存；一致性以 ProjectionFact 关系表为准） */
  matchedFactIds: string[];
  /** 本次 materialization 的成员关系（同一 generation） */
  memberFactIds: string[];
  tolerancePolicyId: string;
  policyVersion: string;
  inputDigest: string;
  ambiguityReasons: string[];
}

function assertPolicy(policy: ProjectionPolicyInput): void {
  if (!policy?.id || !policy.policyVersion) {
    throw new ProjectionComputeError('POLICY_REQUIRED', 'effective tolerance policy 必填（不得代码隐式 fallback）');
  }
  const absolute = toScaled(policy.absoluteTolerance);
  const relative = toScaled(policy.relativeTolerance);
  // relativeTolerance 是比率（≤ 1）；与 expected 同尺度定点相乘后除以 SCALE_FACTOR
  if (absolute < 0n || relative < 0n || relative > SCALE_FACTOR) {
    throw new ProjectionComputeError('POLICY_INVALID', '容差必须非负且 relativeTolerance ≤ 1');
  }
}

/**
 * 纯函数：同一输入 → 同一输出（含同一 inputDigest）。
 */
export function computeProjection(input: ProjectionComputationInput): ProjectionComputation {
  assertPolicy(input.policy);

  const facts = [...input.facts].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const overrides = [...input.overrides].sort((left, right) =>
    left.reimbursementFactId < right.reimbursementFactId ? -1 : left.reimbursementFactId > right.reimbursementFactId ? 1 : 0,
  );
  const overrideByFact = new Map(overrides.map((entry) => [entry.reimbursementFactId, entry.decisionKind]));

  const ambiguityReasons: string[] = [];

  // (1) currency：basis 存在时逐笔对齐 basis.currency；无 basis 时同一投影内不得出现多币种
  const currencies = new Set(facts.map((fact) => fact.currency));
  if (input.basis) {
    if (facts.some((fact) => fact.currency !== input.basis?.currency)) ambiguityReasons.push('CURRENCY_MISMATCH');
  } else if (currencies.size > 1) {
    ambiguityReasons.push('CURRENCY_MISMATCH');
  }

  // (2) conflicting evidence：同一 providerEventId 出现不同金额
  const byEventId = new Map<string, Set<string>>();
  for (const fact of facts) {
    if (!fact.providerEventId) continue;
    const amounts = byEventId.get(fact.providerEventId) ?? new Set<string>();
    amounts.add(fromScaled(toScaled(fact.amount)));
    byEventId.set(fact.providerEventId, amounts);
  }
  const conflictingEventIds = new Set(
    [...byEventId.entries()].filter(([, amounts]) => amounts.size > 1).map(([eventId]) => eventId),
  );
  if (conflictingEventIds.size > 0) ambiguityReasons.push('CONFLICTING_EVIDENCE');

  // (3) 归属：override UNMATCHED 排除；currency 不一致 / 冲突证据不计入
  const included: ProjectionFactInput[] = [];
  for (const fact of facts) {
    const decision = overrideByFact.get(fact.id);
    if (decision === 'UNMATCHED') continue;
    if (input.basis && fact.currency !== input.basis.currency) continue;
    if (!input.basis && currencies.size > 1) continue;
    if (fact.providerEventId && conflictingEventIds.has(fact.providerEventId)) continue;
    included.push(fact);
  }

  let net = 0n;
  for (const fact of included) net += toScaled(fact.amount);

  const expected = input.basis ? toScaled(input.basis.expectedRecoveryAmount) : null;
  const absoluteTolerance = toScaled(input.policy.absoluteTolerance);
  const relativeTolerance = toScaled(input.policy.relativeTolerance);

  let status: ProjectionStatus;
  if (ambiguityReasons.length > 0) {
    status = 'AMBIGUOUS';
  } else if (net === 0n) {
    status = 'UNMATCHED';
  } else if (expected === null) {
    // 有匹配事实但无 effective basis：无法判定完整性（绝不宣称 recovered）
    status = 'MATCHED';
  } else {
    const relativePortion = (expected * relativeTolerance) / SCALE_FACTOR;
    const tolerance = relativePortion > absoluteTolerance ? relativePortion : absoluteTolerance;
    const diff = net - expected;
    if (diff <= tolerance && diff >= -tolerance) {
      status = 'FULLY_RECONCILED';
    } else if (diff < 0n) {
      status = 'PARTIALLY_RECONCILED';
    } else {
      // 超出容差的过度回收（金额异常，而非匹配歧义）：不得自动宣称已完全追回
      // MSG-20261002-49 ②：必须记录结构化异常 AMOUNT_EXCEEDS_EXPECTED（v1 暂以 status=AMBIGUOUS + 明确 reason 表达）
      ambiguityReasons.push('AMOUNT_EXCEEDS_EXPECTED');
      status = 'AMBIGUOUS';
    }
  }

  const memberFactIds = included.map((fact) => fact.id);
  const digestInput = {
    algorithmVersion: PROJECTION_ALGORITHM_VERSION,
    claimItemId: input.claimItemId,
    basis: input.basis
      ? {
          id: input.basis.id,
          expectedRecoveryAmount: fromScaled(toScaled(input.basis.expectedRecoveryAmount)),
          currency: input.basis.currency,
          basisVersion: input.basis.basisVersion,
        }
      : null,
    policy: {
      id: input.policy.id,
      policyVersion: input.policy.policyVersion,
      absoluteTolerance: fromScaled(absoluteTolerance),
      relativeTolerance: fromScaled(relativeTolerance),
    },
    facts: facts.map((fact) => ({
      id: fact.id,
      amount: fromScaled(toScaled(fact.amount)),
      currency: fact.currency,
      providerEventId: fact.providerEventId,
      providerCaseRefCanonical: fact.providerCaseRefCanonical,
      occurredAt: fact.occurredAt,
    })),
    overrides: overrides.map((entry) => ({
      reimbursementFactId: entry.reimbursementFactId,
      decisionKind: entry.decisionKind,
    })),
  };
  const inputDigest = createHash('sha256').update(canonicalJson(digestInput), 'utf8').digest('hex');

  return {
    status,
    basisId: input.basis?.id ?? null,
    expectedAmount: expected === null ? null : fromScaled(expected),
    currency: input.basis?.currency ?? (currencies.size === 1 ? [...currencies][0] : null),
    netMatchedObservedAmount: fromScaled(net),
    matchedFactIds: memberFactIds,
    memberFactIds,
    tolerancePolicyId: input.policy.id,
    policyVersion: input.policy.policyVersion,
    inputDigest,
    ambiguityReasons,
  };
}
