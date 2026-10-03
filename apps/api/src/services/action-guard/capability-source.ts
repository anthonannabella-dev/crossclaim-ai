/**
 * ACTION GUARD — CAPABILITY SOURCE（MSG-20260930-03 授权项 ②「RUNTIME BUSINESS BLOCKING」）
 * -------------------------------------------------------------------------------------
 * 把「真实运行时能力源」组装成 Action Guard 的能力快照端口：
 *   - Kill Switch（services/operations/kill-switch-resolver.ts）→ tenant-level enablement；
 *   - Feature flag / platform enablement / production gate / write 能力 / HOST 审批
 *     → 由注入的提供方给出；**缺省全部按「未满足」处理（fail closed）**。
 *
 * 纪律：
 *   - 默认全部不可用：没有显式提供方时，任何需要闸门的动作都会被 Action Guard 拒绝；
 *   - Kill Switch 报 disabled 或 degraded（DB 不可用等）→ tenant 未启用 → 拒绝；
 *   - Kill Switch 解析抛异常 → 返回 undefined → Action Guard 判 STATE_UNAVAILABLE（拒绝）；
 *   - 本模块不读 env、不写库、不发外部请求；所有 IO 都通过注入端口完成。
 */

import type { ActionGuardCapabilityPort } from './runtime-guard';

export const ACTION_KILL_SWITCH_SCOPES = [
  'submission',
  'billing',
  'integration',
  'platform_connector',
  'workflow',
  'observability',
] as const;
export type ActionKillSwitchScope = (typeof ACTION_KILL_SWITCH_SCOPES)[number];

/**
 * 动作 → 必查的 Kill Switch scope。
 * 未列出的动作不做 Kill Switch 检查（例如只读动作、仅需 HOST 审批的密钥动作）。
 */
export const ACTION_SCOPE_MAP: Record<string, ActionKillSwitchScope[]> = {
  'claim.prepare': ['workflow'],
  'carrier.manual_submission.record': ['workflow'],
  'carrier.claim_response.record': ['workflow'],
  'customs.recovery.start': ['workflow'],
  'billing.draft': ['billing'],
  'claim.submit': ['submission'],
  'appeal.submit': ['submission'],
  'recovery.manual_submit': ['submission'],
  'recovery.manual_submit_reference_recorded': ['submission'],
  'platform.write': ['platform_connector'],
  'commission.charge': ['billing'],
  'payment.capture': ['billing'],
};

export interface KillSwitchReadPort {
  resolve(
    scope: string,
    organizationId: string,
  ): Promise<{ scope: string; value: 'enabled' | 'disabled'; degraded: boolean; stale?: boolean }>;
}

export interface ActionGuardRuntimeProviders {
  /** 生产闸门（默认 NOT_SATISFIED） */
  productionGate?: () => 'SATISFIED' | 'NOT_SATISFIED' | 'UNKNOWN';
  /** 写能力（默认 false；外部写入与资金动作必须显式为 true） */
  writeEnabled?: (query: { organizationId: string; action: string }) => boolean;
  /** HOST 审批（默认 false） */
  hostApprovalGranted?: (query: { organizationId: string; action: string }) => boolean;
  /** Feature flag（缺省视为未开启） */
  featureFlags?: (query: { organizationId: string; action: string }) => Record<string, boolean> | undefined;
  /** 平台级 enablement（缺省视为未开启） */
  platformEnablement?: (query: { organizationId: string; action: string }) => Record<string, boolean> | undefined;
}

export interface ActionGuardCapabilitySourceDeps {
  killSwitch: KillSwitchReadPort;
  providers?: ActionGuardRuntimeProviders;
}

/** 计算某动作需要检查的 Kill Switch scope（未配置则返回空数组）。 */
/**
 * CHANGE A（MSG-20260930-12）：scope 映射同样只接受自有键；
 * 未知动作（含 toString / constructor / __proto__ 等继承键）一律返回空数组，
 * 绝不返回原型链上的值，避免不可迭代的继承值进入守卫。
 */
export function scopesForAction(action: string): ActionKillSwitchScope[] {
  return Object.prototype.hasOwnProperty.call(ACTION_SCOPE_MAP, action) ? ACTION_SCOPE_MAP[action] : [];
}

export function createActionGuardCapabilitySource(deps: ActionGuardCapabilitySourceDeps): ActionGuardCapabilityPort {
  if (!deps?.killSwitch) throw new Error('ACTION_GUARD_MISSING_KILL_SWITCH_PORT');
  const providers = deps.providers ?? {};

  return {
    async resolve({ organizationId, action }) {
      const scopes = scopesForAction(action);
      let tenantEnabled = true;

      for (const scope of scopes) {
        // 抛异常 → 让 Action Guard 判 STATE_UNAVAILABLE（fail closed）
        const effective = await deps.killSwitch.resolve(scope, organizationId);
        if (!effective || effective.value !== 'enabled' || effective.degraded === true || effective.stale === true) {
          tenantEnabled = false;
          break;
        }
      }

      const query = { organizationId, action };
      return {
        tenantEnabled,
        writeEnabled: providers.writeEnabled?.(query) === true,
        hostApprovalGranted: providers.hostApprovalGranted?.(query) === true,
        productionGate: providers.productionGate?.() ?? 'NOT_SATISFIED',
        featureEnabled: providers.featureFlags?.(query) ?? {},
        platformEnablement: providers.platformEnablement?.(query) ?? {},
      };
    },
  };
}
