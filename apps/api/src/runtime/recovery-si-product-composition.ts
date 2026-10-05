/**
 * STEP 3 FINAL-5（MSG-20261005-44 CHANGE C）—— Recovery SI 的**唯一 product 组装点**
 * ---------------------------------------------------------------
 * 裁决要求：`RuntimeActionGuard` 是结构化 interface，调用方可手写
 * `{ evaluate: async () => ALLOW, assertAllowed: ... }` 冒充 shared guard。
 * 因此 product 组装点**只接受 `AppActionGuardDeps`**，内部唯一调用 `createAppActionGuard()` —— 
 * 这是仓库唯一 Shared Action Guard / Control Plane / Kill Switch 组装路径，
 * 从而真正满足 `SECOND_GUARD_IMPLEMENTATION = FORBIDDEN`。
 */

import type { RsiFlags } from '../services/autonomy/rsi-runtime-config';
import type { AppActionGuardDeps } from '../services/action-guard/runtime-guard-composition';
import type { RecoveryReadPorts } from '../services/intelligence/recovery-read-tools';
import type { RsiDomainCapabilityPack } from './rsi-domain-pack';
import { createSharedRecoveryGuardAdapterFromAppGuard } from './recovery-guard-adapter';
import { createRecoverySiPack, type RecoverySiPackDependencies } from './recovery-si-pack';

export const RECOVERY_SI_PRODUCT_COMPOSITION_BOUNDARY = {
  uniqueAssemblyPoint: true,
  guardWiring: 'createSharedRecoveryGuardAdapterFromAppGuard（内部唯一调用 createAppActionGuard）',
  accepts: ['AppActionGuardDeps（共享构造依赖）'],
  guardInstanceInjection: 'FORBIDDEN（结构化 RuntimeActionGuard 可被手写冒充；不接受实例）',
  callerSuppliedGuardPort: 'FORBIDDEN（产品路径不得注入自定义 RsiRecoveryGuardPort）',
  secondGuardImplementation: 'FORBIDDEN',
  controlPlaneOwner: 'services/action-guard/control-plane.ts',
  killSwitchOwner: 'services/action-guard/kill-switch-adapter.ts',
} as const;

export interface RsiProductRecoverySiPack extends RsiDomainCapabilityPack {
  readonly guardWiring: 'SHARED_ACTION_GUARD_ADAPTER';
}

export function createProductRecoverySiPack(input: {
  /** 共享 guard 的构造依赖（唯一入口；不接受 guard 实例 / 自定义 guard port） */
  appActionGuardDeps: AppActionGuardDeps;
  readPorts: RecoveryReadPorts;
  bind: RecoverySiPackDependencies['bind'];
  flags?: RsiFlags;
}): RsiProductRecoverySiPack {
  if (!input.appActionGuardDeps) throw new Error('RECOVERY_SI_PRODUCT_GUARD_REQUIRED');
  const guard = createSharedRecoveryGuardAdapterFromAppGuard(input.appActionGuardDeps);
  const pack = createRecoverySiPack({
    readPorts: input.readPorts,
    bind: input.bind,
    guard,
    ...(input.flags === undefined ? {} : { flags: input.flags }),
  });
  return { ...pack, guardWiring: 'SHARED_ACTION_GUARD_ADAPTER' };
}
