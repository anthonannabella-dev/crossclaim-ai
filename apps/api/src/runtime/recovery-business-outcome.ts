/**
 * PHASE 2 / P2-CHANGE3 —— 业务完成状态真实性（复审 CHANGE 3）
 * ---------------------------------------------------------------
 * 问题：内部任务终态 `PROMOTED` 只表示「runner 提议成功 / 链路走完」，
 * **不等于客户追回成功**。复审要求区分：
 *   进入业务链 → 形成有效追回机会 → 已准备索赔 → 已提交索赔 → Provider 已确认 → 已收到回款
 * 并且 `BLOCK` / `WAITING_ON_PROVIDER` / `WAITING_ON_CUSTOMER` **不得**被误映射为业务完成。
 *
 * 本模块是**纯函数**词表与推导：只依据持久化事实（是否派发、pack 状态、阻断码）推导业务结果，
 * 绝不因为「dispatch 成功」就产出任何完成级结果。
 */

/** 业务结果（有序：越靠后越接近真实回款；HOLD 档在本地不可达） */
export const RECOVERY_BUSINESS_OUTCOMES = [
  'NOT_DISPATCHED', // 未被 dispatch（未进入业务链）
  'DISPATCHED', // 已进入业务链（**仅此而已，不代表任何成功**）
  'WAITING_ON_PROVIDER', // 等待 Provider（非完成）
  'WAITING_ON_CUSTOMER', // 等待客户补证（非完成）
  'BLOCKED', // 阻断（非完成）
  'OPPORTUNITY_IDENTIFIED', // 已形成有效追回机会
  'CLAIM_PREPARED', // 已准备索赔
  'CLAIM_SUBMITTED', // 已提交索赔（HOLD：需真实外写授权）
  'PROVIDER_CONFIRMED', // Provider 已确认（HOLD）
  'SETTLEMENT_RECEIVED', // 已收到回款（HOLD）
] as const;

export type RecoveryBusinessOutcome = (typeof RECOVERY_BUSINESS_OUTCOMES)[number];

/** 本地环境可达的最高档（不含需要真实外写/回款的档位） */
export const LOCALLY_REACHABLE_MAX_OUTCOME: RecoveryBusinessOutcome = 'CLAIM_PREPARED';

/** 需要真实外部执行（当前全部 HOLD）才可能达到的结果 */
export const HOLD_BUSINESS_OUTCOMES: readonly RecoveryBusinessOutcome[] = [
  'CLAIM_SUBMITTED',
  'PROVIDER_CONFIRMED',
  'SETTLEMENT_RECEIVED',
];

/** 只有这两个才算「业务上有结果」——可用于映射内部成功终态 */
const TERMINAL_COMPLETION: readonly RecoveryBusinessOutcome[] = ['PROVIDER_CONFIRMED', 'SETTLEMENT_RECEIVED'];

/** 是否属于真实业务完成（可映射内部成功终态）；「已准备索赔」**不算**完成 */
export const isTerminalBusinessCompletion = (outcome: RecoveryBusinessOutcome): boolean =>
  TERMINAL_COMPLETION.includes(outcome);

/** 是否属于非完成状态（阻断/等待），不得被当成完成 */
export const isNonCompletionOutcome = (outcome: RecoveryBusinessOutcome): boolean =>
  outcome === 'NOT_DISPATCHED' || outcome === 'DISPATCHED' || outcome === 'BLOCKED' ||
  outcome === 'WAITING_ON_PROVIDER' || outcome === 'WAITING_ON_CUSTOMER';

export interface RecoveryBusinessOutcomeInput {
  /** 是否真的进入了 recovery-si 业务链（dispatch 记录存在） */
  dispatched: boolean;
  /** pack 报告的阻断码（有阻断 ⇒ BLOCKED/Waiting，优先于其它推断） */
  blockCodes?: readonly string[];
  /** 是否形成了有效追回机会（来自读端口/计划的事实） */
  opportunityIdentified?: boolean;
  /** 是否已准备索赔（本地可达到的最高档） */
  claimPrepared?: boolean;
  /** 是否已提交索赔（需真实外写证据；本地恒 false） */
  claimSubmitted?: boolean;
  providerConfirmed?: boolean;
  settlementReceived?: boolean;
}

/**
 * 纯推导：**dispatch 本身只得到 `DISPATCHED`**，绝不产出完成级结果。
 * 更高档位必须各有独立事实证据，否则不得推断。
 */
export function deriveRecoveryBusinessOutcome(input: RecoveryBusinessOutcomeInput): RecoveryBusinessOutcome {
  if (!input.dispatched) return 'NOT_DISPATCHED';
  if (input.settlementReceived === true) return 'SETTLEMENT_RECEIVED';
  if (input.providerConfirmed === true) return 'PROVIDER_CONFIRMED';
  if (input.claimSubmitted === true) return 'CLAIM_SUBMITTED';
  if (input.claimPrepared === true) return 'CLAIM_PREPARED';
  if (input.opportunityIdentified === true) return 'OPPORTUNITY_IDENTIFIED';
  const blocks = input.blockCodes ?? [];
  if (blocks.some((code) => /CUSTOMER|EVIDENCE/i.test(code))) return 'WAITING_ON_CUSTOMER';
  if (blocks.some((code) => /PROVIDER|AUTH/i.test(code))) return 'WAITING_ON_PROVIDER';
  if (blocks.length > 0) return 'BLOCKED';
  return 'DISPATCHED';
}

/** 内部任务终态映射：只有真实完成档位才允许 → PROMOTED；其余一律不得标记为业务成功 */
export function internalTaskStatusForBusinessOutcome(
  outcome: RecoveryBusinessOutcome,
): 'PROMOTED' | 'BLOCKED' | 'READY' {
  if (isTerminalBusinessCompletion(outcome)) return 'PROMOTED';
  if (outcome === 'NOT_DISPATCHED' || outcome === 'DISPATCHED') return 'READY';
  return 'BLOCKED';
}

export const RECOVERY_BUSINESS_OUTCOME_BOUNDARY = {
  dispatchImpliesBusinessSuccess: false,
  claimPreparedCountsAsCompletion: false,
  holdOutcomesUnreachableLocally: HOLD_BUSINESS_OUTCOMES,
  locallyReachableMax: LOCALLY_REACHABLE_MAX_OUTCOME,
  promotesOnlyOnTerminalCompletion: true,
  externalWrite: false,
  payment: false,
  customsFiling: false,
} as const;
