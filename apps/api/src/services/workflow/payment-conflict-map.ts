/**
 * 支付域「已识别唯一约束」→ 稳定领域错误的**严格结构化白名单**（MSG-20260930-34 CHANGE A）
 * ---------------------------------------------------------------------------
 * 只接受**结构化**证据；不做任何消息子串/关键字猜测，也**不做任何清洗**（不 trim、不过滤成员）：
 *   · 数组 `meta.target`：长度恰为 2、全部为非空字符串、无重复，
 *     且字段集合**精确等于**下列两种已识别组合之一（字段顺序可互换）：
 *       {organizationId, paymentId}      → PAYMENT_SOURCE_CONFLICT（成功 Payment 来源唯一约束）
 *       {organizationId, paymentEventId} → ATTEMPT_ALREADY_RUNNING（同一事件进行中 attempt 约束）
 *   · 字符串 `meta.target`：仅接受**精确相等**的完整已取证约束名：
 *       PaymentProcessingAttempt_succeeded_payment_key → PAYMENT_SOURCE_CONFLICT
 * 其余一切（缺失 / 畸形 / 未知 / 多字段 / 重复字段 / 混入非字符串 / 未知约束名 / 非 P2002）
 * 一律返回 null，由调用方原样抛出。
 */

export type PaymentConflictCode = 'PAYMENT_SOURCE_CONFLICT' | 'ATTEMPT_ALREADY_RUNNING';

export interface PaymentConflictMapping {
  code: PaymentConflictCode;
  message: string;
}

const MESSAGES: Record<PaymentConflictCode, string> = {
  PAYMENT_SOURCE_CONFLICT: '该资金对象已有成功执行来源（并发恢复已收口为领域冲突）',
  ATTEMPT_ALREADY_RUNNING: '该事件已有进行中的执行尝试',
};

const KNOWN_FIELD_COMBOS: ReadonlyArray<{ key: string; code: PaymentConflictCode }> = [
  { key: 'organizationId,paymentId', code: 'PAYMENT_SOURCE_CONFLICT' },
  { key: 'organizationId,paymentEventId', code: 'ATTEMPT_ALREADY_RUNNING' },
];

/** 已取证的完整约束名（精确相等才接受） */
const KNOWN_CONSTRAINT_NAMES: Readonly<Record<string, PaymentConflictCode>> = {
  PaymentProcessingAttempt_succeeded_payment_key: 'PAYMENT_SOURCE_CONFLICT',
};

export function mapKnownPaymentUniqueConflict(error: unknown): PaymentConflictMapping | null {
  if ((error as { code?: string } | undefined)?.code !== 'P2002') return null;

  const rawTarget = (error as { meta?: { target?: unknown } } | undefined)?.meta?.target;

  // 字符串形态：仅接受**精确相等**的完整约束名（不 trim，不做任何清洗）
  if (typeof rawTarget === 'string') {
    const code = Object.prototype.hasOwnProperty.call(KNOWN_CONSTRAINT_NAMES, rawTarget)
      ? KNOWN_CONSTRAINT_NAMES[rawTarget]
      : undefined;
    return code ? { code, message: MESSAGES[code] } : null;
  }

  // 数组形态：长度恰为 2、元素全为非空字符串、无重复、字段集合精确相等（不 trim）
  if (!Array.isArray(rawTarget)) return null;
  if (rawTarget.length !== 2) return null;
  if (!rawTarget.every((value): value is string => typeof value === 'string' && value !== '')) return null;

  const fields = rawTarget as string[];
  if (new Set(fields).size !== fields.length) return null;
  const key = [...fields].sort().join(',');
  const matched = KNOWN_FIELD_COMBOS.find((combo) => combo.key === key);
  return matched ? { code: matched.code, message: MESSAGES[matched.code] } : null;
}
