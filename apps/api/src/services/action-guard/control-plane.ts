/**
 * PRODUCTION CONTROL PLANE（MSG-20260930-03 授权项 ③；MSG-20260930-12 §6 明确允许开工）
 * ---------------------------------------------------------------------------------
 * 目标：把「平台级运行模式」与「租户/平台 enablement」组合成 Action Guard 的能力快照，
 * 并**默认 read-only**：
 *
 *   READ_ONLY（默认） → 不做任何写入动作；EXTERNAL_WRITE / MONEY_MOVEMENT / INTERNAL_WRITE 一律被拒
 *   DRY_RUN           → 允许内部试算，但仍不写外部、不动资金
 *   MANUAL_REVIEW     → 允许内部写入并进入人工复核队列，仍不写外部、不动资金
 *   WRITE_ENABLED     → 唯一可能放行外部写入/资金的模式；仍需 Kill Switch 开启 + 平台/租户 enablement + 人工审批
 *
 * 另外：
 *   - `globalDisabled=true`（平台级熔断）优先于一切模式；
 *   - Kill Switch 仍然每个动作按 scope 单独检查（沿用 capability-source）；
 *   - 本模块不读 env、不写库、不发请求：配置与审计都通过注入端口提供。
 *   - 不改变既有 HOLD：即使进入 WRITE_ENABLED，真实外写仍需后续（另行授权的）启用阶段，
 *     本模块只负责「是否允许」的判定链路。
 */

import type { ActionRiskClass } from './action-guard';
import { ACTION_GUARD_CATALOG, type ActionGuardInput } from './action-guard';
import {
  createActionGuardCapabilitySource,
  type KillSwitchReadPort,
} from './capability-source';
import { createRuntimeActionGuard, type ActionGuardAuditPort, type RuntimeActionGuard } from './runtime-guard';

export const CONTROL_PLANE_MODES = ['READ_ONLY', 'DRY_RUN', 'MANUAL_REVIEW', 'WRITE_ENABLED'] as const;
export type ControlPlaneMode = (typeof CONTROL_PLANE_MODES)[number];

/** 默认 read-only（最小能力）。 */
export const CONTROL_PLANE_DEFAULT_MODE: ControlPlaneMode = 'READ_ONLY';

export interface ControlPlaneConfig {
  /** 平台级熔断：true 时任何模式都不放行 */
  globalDisabled: boolean;
  mode: ControlPlaneMode;
  /** 平台级 enablement（按动作）；缺省即未开启 */
  platformEnabled?: Record<string, boolean>;
  /** 租户级 enablement（按动作）；缺省即未开启 */
  tenantFeatureEnabled?: Record<string, boolean>;
  /** 平台级 HOST 审批状态；缺省即未授予 */
  hostApprovalGranted?: boolean;
}

export interface ControlPlaneDeps {
  killSwitch: KillSwitchReadPort;
  /** 只读配置端口：返回当前控制面配置（不得由请求体直接提供） */
  config: { read(): Promise<ControlPlaneConfig> | ControlPlaneConfig };
  audit?: ActionGuardAuditPort;
}

export interface ProductionControlPlane {
  guard: RuntimeActionGuard;
  capabilitySource: ReturnType<typeof createActionGuardCapabilitySource>;
  /** 只读快照，便于运营展示与测试 */
  snapshot(): Promise<ControlPlaneConfig>;
}

/** 内部写入动作（业务库写入；不触发外部/资金） */
const INTERNAL_RISKS: ActionRiskClass[] = ['INTERNAL_WRITE'];
/** 外部写入与资金动作：只有 WRITE_ENABLED 才可能放行 */
const EXTERNAL_RISKS: ActionRiskClass[] = ['EXTERNAL_WRITE', 'MONEY_MOVEMENT'];

export function createProductionControlPlane(deps: ControlPlaneDeps): ProductionControlPlane {
  if (!deps?.killSwitch) throw new Error('CONTROL_PLANE_MISSING_KILL_SWITCH_PORT');
  if (!deps?.config) throw new Error('CONTROL_PLANE_MISSING_CONFIG_PORT');

  const capabilitySource = createActionGuardCapabilitySource({
    killSwitch: deps.killSwitch,
    providers: {
      productionGate: () => 'NOT_SATISFIED', // 由 guard 包装层按模式覆盖（见下）
      writeEnabled: () => false,
      hostApprovalGranted: () => false,
    },
  });

  async function readConfig(): Promise<ControlPlaneConfig> {
    const config = await deps.config.read();
    return {
      globalDisabled: config?.globalDisabled === true,
      mode: (CONTROL_PLANE_MODES as readonly string[]).includes(config?.mode) ? config.mode : CONTROL_PLANE_DEFAULT_MODE,
      platformEnabled: config?.platformEnabled ?? {},
      tenantFeatureEnabled: config?.tenantFeatureEnabled ?? {},
      hostApprovalGranted: config?.hostApprovalGranted === true,
    };
  }

  /**
   * 能力解析：在 capability-source 之上按「模式 × 动作风险」二次收口。
   * 设计为独立函数以便测试直接断言（不依赖审计/端口实现细节）。
   */
  async function resolveWithMode(input: ActionGuardInput) {
    const config = await readConfig();
    const base = await capabilitySource.resolve({
      organizationId: String(input?.organizationId ?? ''),
      action: String(input?.action ?? ''),
    });
    const action = String(input?.action ?? '');
    const ownKey = Object.prototype.hasOwnProperty.call(ACTION_GUARD_CATALOG, action);
    const risk = ownKey ? ACTION_GUARD_CATALOG[action].risk : undefined;

    const mode = config.mode;
    const platformAllowed = ownKey && config.platformEnabled?.[action] === true;
    const tenantAllowed = ownKey && config.tenantFeatureEnabled?.[action] === true;
    const writeAllowed =
      mode === 'WRITE_ENABLED' && !config.globalDisabled && risk !== undefined && EXTERNAL_RISKS.includes(risk);
    const internalAllowed =
      (mode === 'MANUAL_REVIEW' || mode === 'WRITE_ENABLED') && !config.globalDisabled && risk !== undefined && INTERNAL_RISKS.includes(risk);

    return {
      tenantEnabled: config.globalDisabled ? false : (base?.tenantEnabled ?? false),
      writeEnabled: writeAllowed,
      hostApprovalGranted: config.hostApprovalGranted === true,
      productionGate: mode === 'WRITE_ENABLED' && !config.globalDisabled ? ('SATISFIED' as const) : ('NOT_SATISFIED' as const),
      featureEnabled: {
        ...(tenantAllowed ? { [action]: true } : {}),
        ...(internalAllowed ? { [action]: true } : {}),
      },
      platformEnablement: platformAllowed ? { [action]: true } : {},
    };
  }

  const guard = createRuntimeActionGuard({
    capabilities: { resolve: resolveWithMode },
    audit: deps.audit,
  });

  return { guard, capabilitySource, snapshot: readConfig };
}
