/**
 * CONTROL PLANE WIRING（MSG-20260930-03 授权项 ③；MSG-20260930-13 NEXT 批准继续）
 * ---------------------------------------------------------------------------
 * 把控制面接到**真实运行时依赖**上，并提供安全缺省：
 *
 *   kill-switch resolver（真实三层解析） → capability source → 控制面闸门 → runtime guard
 *   audit writer（真实审计落地）        → runtime guard 的审计端口
 *
 * 纪律（与 §5 接入验收条件一致）：
 *   - 配置只能来自**只读配置端口**，绝不接受请求体传入的 capabilities / hostApprovalGranted；
 *   - 配置读取失败 → 一律按 **READ_ONLY** 处理（fail closed），不继承上次配置；
 *   - 默认模式 READ_ONLY：任何写入动作（内部/外部/资金）都不会被放行；
 *   - 审计端口缺失或写入失败：运行时会拒绝 ALLOW（沿用 runtime-guard 的降级规则）。
 *   - 本模块不读 env、不直接建 DB 连接；Prisma / resolver / audit 全部注入。
 */

import { createProductionControlPlane, CONTROL_PLANE_DEFAULT_MODE, type ControlPlaneConfig, type ProductionControlPlane } from './control-plane';
import type { KillSwitchReadPort } from './capability-source';
import type { ActionGuardAuditPort } from './runtime-guard';

export interface ControlPlaneConfigPort {
  /** 只读配置读取；抛异常或返回 undefined 时按 READ_ONLY 处理 */
  read(organizationId: string): Promise<ControlPlaneConfig | undefined> | ControlPlaneConfig | undefined;
}

export interface ControlPlaneWiringDeps {
  /** 真实 Kill Switch 解析器（services/operations/kill-switch-resolver.ts 的 resolve 端口） */
  killSwitch: KillSwitchReadPort;
  /** 真实审计落地端口 */
  audit: ActionGuardAuditPort;
  /** 只读配置端口（平台/租户配置源）；缺省即 READ_ONLY */
  config?: ControlPlaneConfigPort;
}

export interface WiredControlPlane extends ProductionControlPlane {
  /** 当前生效配置（只读快照；读取失败时返回 READ_ONLY 缺省） */
  currentConfig(): Promise<ControlPlaneConfig>;
}

const READ_ONLY_FALLBACK: ControlPlaneConfig = {
  globalDisabled: false,
  mode: CONTROL_PLANE_DEFAULT_MODE,
  platformEnabled: {},
  tenantFeatureEnabled: {},
  hostApprovalGranted: false,
};

export function createWiredControlPlane(deps: ControlPlaneWiringDeps): WiredControlPlane {
  if (!deps?.killSwitch) throw new Error('CONTROL_PLANE_WIRING_MISSING_KILL_SWITCH');
  if (!deps?.audit) throw new Error('CONTROL_PLANE_WIRING_MISSING_AUDIT');

  let lastOrganizationId = '';

  async function readConfigFor(organizationId: string): Promise<ControlPlaneConfig> {
    if (!deps.config) return { ...READ_ONLY_FALLBACK };
    try {
      const config = await deps.config.read(organizationId);
      if (!config) return { ...READ_ONLY_FALLBACK };
      return {
        globalDisabled: config.globalDisabled === true,
        mode: config.mode ?? CONTROL_PLANE_DEFAULT_MODE,
        platformEnabled: config.platformEnabled ?? {},
        tenantFeatureEnabled: config.tenantFeatureEnabled ?? {},
        hostApprovalGranted: config.hostApprovalGranted === true,
      };
    } catch {
      return { ...READ_ONLY_FALLBACK };
    }
  }

  const plane = createProductionControlPlane({
    killSwitch: deps.killSwitch,
    config: { read: () => readConfigFor(lastOrganizationId) },
    audit: deps.audit,
  });

  return {
    ...plane,
    async currentConfig() {
      return readConfigFor(lastOrganizationId);
    },
    guard: {
      evaluate: async (input) => {
        lastOrganizationId = String(input?.organizationId ?? '');
        return plane.guard.evaluate(input);
      },
      assertAllowed: async (input) => {
        lastOrganizationId = String(input?.organizationId ?? '');
        return plane.guard.assertAllowed(input);
      },
    },
  };
}
