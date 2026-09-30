/**
 * 支付域「已识别唯一约束」→ 稳定领域错误的**白名单映射**（MSG-20260930-33 CHANGE A）
 * ---------------------------------------------------------------------------
 * 原则：只映射**确属已识别约束**的 Prisma P2002；其余一律返回 null（调用方原样抛出）。
 *   · 成功 Payment 来源唯一约束：约束名 `PaymentProcessingAttempt_succeeded_payment_key`，
 *     或 P2002 目标组合同时包含 `paymentId` 与 `organizationId`（Payment 来源唯一）。
 *   · 同一事件进行中 attempt 约束：P2002 目标组合同时包含 `paymentEventId` 与 `organizationId`。
 * 不接受"仅字段子串猜测"，也不接受缺失 `meta.target` 的错误。
 */

export type PaymentConflictCode = 'PAYMENT_SOURCE_CONFLICT' | 'ATTEMPT_ALREADY_RUNNING';

export interface PaymentConflictMapping {
  code: PaymentConflictCode;
  message: string;
}

const SUCCEEDED_SOURCE_CONSTRAINT = 'PaymentProcessingAttempt_succeeded_payment_key';

function uniqueTargets(error: unknown): string[] {
  const meta = (error as { meta?: { target?: unknown } } | undefined)?.meta;
  const target = meta?.target;
  if (typeof target === 'string' && target.trim() !== '') return [target];
  if (Array.isArray(target)) return target.filter((item): item is string => typeof item === 'string');
  return [];
}

/**
 * 已识别约束 → 领域错误；未识别 / meta 不足 / 非 P2002 → null（原样抛出）。
 */
export function mapKnownPaymentUniqueConflict(error: unknown): PaymentConflictMapping | null {
  if ((error as { code?: string } | undefined)?.code !== 'P2002') return null;

  const targets = uniqueTargets(error);
  const targetText = targets.join(',');
  const message = String((error as { message?: string } | undefined)?.message ?? '');

  // 成功 Payment 来源约束：显式约束名，或「paymentId + organizationId」目标组合
  const looksLikeSucceededSource =
    message.includes(SUCCEEDED_SOURCE_CONSTRAINT) ||
    (targets.includes('paymentId') && targets.includes('organizationId'));
  if (looksLikeSucceededSource) {
    return {
      code: 'PAYMENT_SOURCE_CONFLICT',
      message: '该资金对象已有成功执行来源（并发恢复已收口为领域冲突）',
    };
  }

  // 同事件进行中 attempt 约束：「paymentEventId + organizationId」目标组合（或消息中的等价标识）
  const looksLikeRunningAttempt =
    (targets.includes('paymentEventId') && targets.includes('organizationId')) ||
    (targets.includes('paymentEventId') && /attempt/i.test(message));
  if (looksLikeRunningAttempt) {
    return {
      code: 'ATTEMPT_ALREADY_RUNNING',
      message: '该事件已有进行中的执行尝试',
    };
  }

  // 未识别（含 target 为空 / 未知组合）→ 原样抛出
  if (targetText === '' && !message.includes(SUCCEEDED_SOURCE_CONSTRAINT)) return null;
  return null;
}
