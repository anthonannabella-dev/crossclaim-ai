/**
 * STEP 3 FINAL-4（MSG-20261005-43）—— Recovery SI 的**唯一 product 组装点**
 * ---------------------------------------------------------------
 * 裁决要求：产品路径不得靠调用方注入任意 guard port 绕过 Shared Guard。
 * 因此本文件是唯一允许把 Recovery SI pack 组装进产品 runtime 的入口：
 *   product composition
 *     → createSharedRecoveryGuardAdapter(AppGuard)   （唯一 shared Action Guard / Control Plane）
 *     → createRecoverySiPack（guard 已固定为 shared adapter）
 *
 * 硬约束：
 *   - 只接受 **shared guard 类型**：`RuntimeActionGuard` 实例或 `AppActionGuardDeps`（共享构造依赖）；
 *   - **不**接受 `RsiRecoveryGuardPort`（调用方自定义 guard port = FORBIDDEN：那是绕过 Shared Guard 的旁路）；
 *   - 返回的 pack 带 `guardWiring = 'SHARED_ACTION_GUARD_ADAPTER'` 标记，供架构回归断言。
 */

import type { RsiFlags } from '../services/autonomy/rsi-runtime-config';
import type { RuntimeActionGuard } from '../services/action-guard/runtime-guard';
import type { AppActionGuardDeps } from '../services/action-guard/runtime-guard-composition';
import type { RecoveryReadPorts } from '../services/intelligence/recovery-read-tools';
import type { RsiDomainCapabilityPack } from './rsi-domain-pack';
import {
  createSharedRecoveryGuardAdapter,
  createSharedRecoveryGuardAdapterFromAppGuard,
} from './recovery-guard-adapter';
import {
  createRecoverySiPack,
  type RecoverySiPackDependencies,
  type RecoverySiTaskBinding,
} from './recovery-si-pack';

export const RECOVERY_SI_PRODUCT_COMPOSITION_BOUNDARY = {
  uniqueAssemblyPoint: true,
  guardWiring: 'createSharedRecoveryGuardAdapter(FromAppGuard)',
  accepts: ['RuntimeActionGuard（shared 类型实例）', 'AppActionGuardDeps（共享构造依赖）'],
  callerSuppliedGuardPort: 'FORBIDDEN（产品路径不得注入自定义 RsiRecoveryGuardPort）',
  secondGuardImplementation: 'FORBIDDEN',
  controlPlaneOwner: 'services/action-guard/control-plane.ts',
  killSwitchOwner: 'services/action-guard/kill-switch-adapter.ts',
} as const;

export interface RsiProductRecoverySiPack extends RsiDomainCapabilityPack {
  readonly guardWiring: 'SHARED_ACTION_GUARD_ADAPTER';
}

export function createProductRecoverySiPack(input: {
  /** 共享 guard 实例（唯一 shared Action Guard） */
  guard?: RuntimeActionGuard;
  /** 或共享 guard 的构造依赖（内部调用 createAppActionGuard） */
  appActionGuardDeps?: AppActionGuardDeps;
  readPorts: RecoveryReadPorts;
  bind: (task: RecoverySiPackDependencies['bind'] extends (t: infer T) => unknown ? T : never) => RecoverySiTaskBinding | null;
  flags?: RsiFlags;
}): RsiProductRecoverySiPack {
  if ((input.guard === undefined) === (input.appActionGuardDeps === undefined)) {
    throw new Error('RECOVERY_SI_PRODUCT_GUARD_REQUIRED');
  }
  const guard =
    input.guard !== undefined
      ? createSharedRecoveryGuardAdapter({ guard: input.guard })
      : createSharedRecoveryGuardAdapterFromAppGuard(input.appActionGuardDeps as AppActionGuardDeps);
  const pack = createRecoverySiPack({
    readPorts: input.readPorts,
    bind: input.bind as RecoverySiPackDependencies['bind'],
    guard,
    ...(input.flags === undefined ? {} : { flags: input.flags }),
  });
  return { ...pack, guardWiring: 'SHARED_ACTION_GUARD_ADAPTER' };
}
