/**
 * KILL SWITCH → ACTION GUARD 适配器（授权项 ③ 真实依赖接线）
 * ------------------------------------------------------------------
 * 把 `services/operations/kill-switch-resolver.ts` 的 `EffectiveKillSwitchResolver`
 * 适配成 Action Guard 的 `KillSwitchReadPort`，并保持 fail-closed 语义：
 *
 *   - resolver 返回 disabled / degraded → 视为未启用（守卫拒绝）；
 *   - resolver 抛异常 → 适配器**不吞异常**，交由 capability-source 判 STATE_UNAVAILABLE（拒绝）；
 *   - 未知 scope（不在 KILL_SWITCH_SCOPES 内）→ 视为未启用（不猜测）。
 *   - 本模块不读 env、不建连接、不写库：resolver 由调用方注入。
 */

import { KILL_SWITCH_DEFAULTS, type KillSwitchScope } from '../operations/kill-switch';
import type { KillSwitchReadPort } from './capability-source';

export interface EffectiveKillSwitchLike {
  scope: string;
  value: 'enabled' | 'disabled';
  degraded: boolean;
  stale?: boolean;
}

function isKnownScope(scope: string): scope is KillSwitchScope {
  return Object.prototype.hasOwnProperty.call(KILL_SWITCH_DEFAULTS, scope);
}

/** 只依赖 resolve 的结构化端口；真实 `EffectiveKillSwitchResolver` 天然满足（返回值含更多字段）。 */
export interface KillSwitchResolverLike {
  resolve(scope: string, organizationId: string): Promise<EffectiveKillSwitchLike>;
}

export function createKillSwitchReadPort(
  resolver: KillSwitchResolverLike,
): KillSwitchReadPort {
  if (!resolver?.resolve) throw new Error('KILL_SWITCH_ADAPTER_MISSING_RESOLVER');

  return {
    async resolve(scope: string, organizationId: string) {
      if (!isKnownScope(scope)) {
        // 未知 scope：不猜测、不放行（fail closed）
        return { scope, value: 'disabled' as const, degraded: true, stale: false };
      }
      const effective = (await resolver.resolve(scope, organizationId)) as EffectiveKillSwitchLike;
      return {
        scope,
        value: effective?.value === 'enabled' ? ('enabled' as const) : ('disabled' as const),
        degraded: effective?.degraded === true,
        stale: effective?.stale === true,
      };
    },
  };
}
