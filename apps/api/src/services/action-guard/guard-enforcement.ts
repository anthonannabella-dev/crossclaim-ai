/**
 * ACTION GUARD — ENFORCEMENT WRAPPER（MSG-20260930-03 授权项 ②）
 * -------------------------------------------------------------------
 * 目的：给 service / route / job runner 提供一个**统一执行助手**，让受保护动作在同一个调用点完成
 * 「先过闸、再执行」。
 *
 * CHANGE B（MSG-20260930-12）：本模块**不声称**「唯一入口 / 已不可绕过」。
 * 类型系统无法禁止调用方绕过本助手直接调用业务函数；覆盖面由后续的业务接入清单与集成验收证明。
 *
 *   const result = await withActionGuard({ guard, input, work: async () => doTheThing() });
 *
 * 合同：
 *   1) 先 assertAllowed（DENY → 抛 ActionGuardDeniedError；缺审批 → 抛 ActionGuardApprovalRequiredError）；
 *   2) 只有 ALLOW 才执行 work；
 *   3) 被拒时 work **绝不执行**（零副作用），并由守卫写入审计；
 *   4) 本模块不读 env、不写库、不发请求。
 */

import type { ActionGuardInput, ActionGuardResult } from './action-guard';
import type { RuntimeActionGuard } from './runtime-guard';

export interface WithActionGuardOptions<T> {
  guard: RuntimeActionGuard;
  input: ActionGuardInput;
  /** 仅在 ALLOW 之后执行；被拒时不会被调用 */
  work: (decision: ActionGuardResult) => Promise<T> | T;
}

export async function withActionGuard<T>(options: WithActionGuardOptions<T>): Promise<T> {
  const { guard, input, work } = options ?? ({} as WithActionGuardOptions<T>);
  if (!guard?.assertAllowed) throw new Error('ACTION_GUARD_MISSING_RUNTIME_GUARD');
  if (typeof work !== 'function') throw new Error('ACTION_GUARD_MISSING_WORK_FUNCTION');

  const decision = await guard.assertAllowed(input);
  return work(decision);
}

/** 需要在 service/route/job 层显式过闸的动作（供**有限静态约定检查**与后续接入清单使用）。 */
export const GUARD_ENFORCED_ACTIONS = [
  'claim.submit',
  'appeal.submit',
  'platform.write',
  'commission.charge',
  'payment.capture',
  'secret.rotate',
] as const;
