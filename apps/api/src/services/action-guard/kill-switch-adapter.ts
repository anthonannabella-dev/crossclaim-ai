/**
 * KILL SWITCH → ACTION GUARD 适配器 v2（MSG-20260930-14 CHANGE D）
 * ---------------------------------------------------------------
 * 严格化：
 *   - 返回 scope 必须与请求 scope 一致，否则视为结构异常 → 拒绝（不猜测）；
 *   - `degraded` 必须是显式布尔；缺失/类型不对 → 结构异常 → 拒绝；
 *   - `value` 只接受 'enabled' / 'disabled'，其它值 → 拒绝；
 *   - `stale` 若存在**必须是布尔**（缺省按 false 处理）；字符串/数字/null/对象等非法类型 → 结构异常 → 拒绝
 *     （CHANGE D1，MSG-20260930-15：不得把已提供的非法值静默转成健康状态）；
 *   - resolver 抛异常**不吞**（交由上层判 STATE_UNAVAILABLE）；
 *   - 未知 scope 直接按拒绝（不查 resolver）。
 * 健康标记（degraded/stale）在此如实透传，由 capability-source 决定是否放行。
 */

import { KILL_SWITCH_DEFAULTS, type KillSwitchScope } from '../operations/kill-switch';
import type { KillSwitchReadPort } from './capability-source';

export interface EffectiveKillSwitchLike {
  scope?: unknown;
  value?: unknown;
  degraded?: unknown;
  stale?: unknown;
}

export interface KillSwitchResolverLike {
  resolve(scope: string, organizationId: string): Promise<EffectiveKillSwitchLike>;
}

function isKnownScope(scope: string): scope is KillSwitchScope {
  return Object.prototype.hasOwnProperty.call(KILL_SWITCH_DEFAULTS, scope);
}

export function createKillSwitchReadPort(resolver: KillSwitchResolverLike): KillSwitchReadPort {
  if (!resolver?.resolve) throw new Error('KILL_SWITCH_ADAPTER_MISSING_RESOLVER');

  return {
    async resolve(scope: string, organizationId: string) {
      if (!isKnownScope(scope)) {
        return { scope, value: 'disabled' as const, degraded: true, stale: false };
      }

      const effective = await resolver.resolve(scope, organizationId);
      const shapeValid =
        !!effective &&
        typeof effective === 'object' &&
        effective.scope === scope &&
        (effective.value === 'enabled' || effective.value === 'disabled') &&
        typeof effective.degraded === 'boolean' &&
        (effective.stale === undefined || typeof effective.stale === 'boolean');

      if (!shapeValid) {
        // 结构异常：严格拒绝，并标注不健康
        return { scope, value: 'disabled' as const, degraded: true, stale: true };
      }

      return {
        scope,
        value: effective.value as 'enabled' | 'disabled',
        degraded: effective.degraded as boolean,
        stale: effective.stale === true,
      };
    },
  };
}
