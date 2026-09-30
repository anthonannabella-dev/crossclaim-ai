/**
 * PRODUCTION CONTROL PLANE v2（授权项 ③；MSG-20260930-14 CHANGE A/B/C）
 * ---------------------------------------------------------------------
 * 相对 v1 的合同修正：
 *   A) **租户上下文逐调用显式传递**：不再持有「上次租户」；配置读取、快照、无审计评估一律使用本次调用的 organizationId。
 *   B) **模式只限制、不授权**：模式许可与显式 tenant feature 许可取**交集**；
 *      缺失或显式 false 不得被模式覆盖；READ_ONLY/DRY_RUN 下持久业务写入一律拒绝。
 *   C) **Production Gate 独立**：由服务端可信配置提供（缺失/UNKNOWN/NOT_SATISFIED 一律拒绝外写与资金动作）；
 *      `WRITE_ENABLED` 只是必要条件，不能自行把 Gate 变成 SATISFIED。
 *      并明确 SECRET_ACCESS（密钥类）的模式许可；globalDisabled 压制所有**非只读**动作。
 *
 * 仍然保持：默认 READ_ONLY；能力缺失/异常 fail closed；审计不可写则放行降级为拒绝（runtime-guard 负责）。
 */

import {
  ACTION_GUARD_CATALOG,
  evaluateActionGuard,
  type ActionGuardInput,
  type ActionGuardResult,
  type ActionRiskClass,
} from './action-guard';
import { createActionGuardCapabilitySource, type KillSwitchReadPort } from './capability-source';
import { createRuntimeActionGuard, type ActionGuardAuditPort, type RuntimeActionGuard } from './runtime-guard';

export const CONTROL_PLANE_MODES = ['READ_ONLY', 'DRY_RUN', 'MANUAL_REVIEW', 'WRITE_ENABLED'] as const;
export type ControlPlaneMode = (typeof CONTROL_PLANE_MODES)[number];
export const CONTROL_PLANE_DEFAULT_MODE: ControlPlaneMode = 'READ_ONLY';

export const PRODUCTION_GATE_STATES = ['SATISFIED', 'NOT_SATISFIED', 'UNKNOWN'] as const;
export type ProductionGateState = (typeof PRODUCTION_GATE_STATES)[number];
export const PRODUCTION_GATE_DEFAULT: ProductionGateState = 'NOT_SATISFIED';

export interface ControlPlaneConfig {
  /** 平台级熔断：true 时压制所有**非只读**动作（只读读取不受影响） */
  globalDisabled: boolean;
  mode: ControlPlaneMode;
  /** 独立生产验收闸门：来自服务端可信来源；缺省 = NOT_SATISFIED */
  productionGate?: ProductionGateState;
  /** 平台级 enablement（按动作）；缺省即未开启 */
  platformEnabled?: Record<string, boolean>;
  /** 租户级 feature（按动作）；缺省即未开启，显式 false 不得被模式覆盖 */
  tenantFeatureEnabled?: Record<string, boolean>;
  /** HOST 审批状态；缺省即未授予 */
  hostApprovalGranted?: boolean;
}

/** 只读配置端口：必须以本次调用的租户为输入（CHANGE A） */
export interface ControlPlaneConfigPort {
  read(query: { organizationId: string }): Promise<ControlPlaneConfig | undefined> | ControlPlaneConfig | undefined;
}

export interface ControlPlaneDeps {
  killSwitch: KillSwitchReadPort;
  config?: ControlPlaneConfigPort;
  audit?: ActionGuardAuditPort;
}

export interface ControlPlaneSnapshot {
  config: ControlPlaneConfig;
  /** 配置源异常/缺失时为 true（此时回落 READ_ONLY） */
  degraded: boolean;
}

export interface ProductionControlPlane {
  guard: RuntimeActionGuard;
  capabilitySource: ReturnType<typeof createActionGuardCapabilitySource>;
  /** 指定租户的规范化配置快照（CHANGE A：显式租户；不缓存、不继承） */
  snapshotFor(organizationId: string): Promise<ControlPlaneSnapshot>;
  /**
   * 纯评估（不写审计、不改变状态）。可传入已规范化配置以保证**同一快照**内的一致性（CHANGE D）。
   */
  evaluateWithoutAudit(input: ActionGuardInput, config?: ControlPlaneConfig): Promise<ActionGuardResult>;
}

const READ_ONLY_FALLBACK: ControlPlaneConfig = {
  globalDisabled: false,
  mode: CONTROL_PLANE_DEFAULT_MODE,
  productionGate: PRODUCTION_GATE_DEFAULT,
  platformEnabled: {},
  tenantFeatureEnabled: {},
  hostApprovalGranted: false,
};

export function normalizeControlPlaneConfig(raw: ControlPlaneConfig | undefined): ControlPlaneConfig {
  if (!raw) return { ...READ_ONLY_FALLBACK };
  return {
    globalDisabled: raw.globalDisabled === true,
    mode: (CONTROL_PLANE_MODES as readonly string[]).includes(raw.mode) ? raw.mode : CONTROL_PLANE_DEFAULT_MODE,
    productionGate: (PRODUCTION_GATE_STATES as readonly string[]).includes(raw.productionGate as string)
      ? (raw.productionGate as ProductionGateState)
      : PRODUCTION_GATE_DEFAULT,
    platformEnabled: raw.platformEnabled ?? {},
    tenantFeatureEnabled: raw.tenantFeatureEnabled ?? {},
    hostApprovalGranted: raw.hostApprovalGranted === true,
  };
}

/** CHANGE B：模式对风险的许可（只做限制；READ_ONLY/DRY_RUN 不允许持久写入） */
export function modeAllowsRisk(risk: ActionRiskClass, mode: ControlPlaneMode): boolean {
  switch (risk) {
    case 'READ_ONLY':
      return true;
    case 'INTERNAL_WRITE':
      return mode === 'MANUAL_REVIEW' || mode === 'WRITE_ENABLED';
    case 'EXTERNAL_WRITE':
    case 'MONEY_MOVEMENT':
      return mode === 'WRITE_ENABLED';
    case 'SECRET_ACCESS':
      // CHANGE C：密钥操作在只读与干跑下一律拒绝
      return mode === 'MANUAL_REVIEW' || mode === 'WRITE_ENABLED';
    default:
      return false;
  }
}

export function createProductionControlPlane(deps: ControlPlaneDeps): ProductionControlPlane {
  if (!deps?.killSwitch) throw new Error('CONTROL_PLANE_MISSING_KILL_SWITCH_PORT');

  const capabilitySource = createActionGuardCapabilitySource({ killSwitch: deps.killSwitch });

  async function snapshotFor(organizationId: string): Promise<ControlPlaneSnapshot> {
    if (!deps.config) return { config: { ...READ_ONLY_FALLBACK }, degraded: false };
    try {
      const raw = await deps.config.read({ organizationId });
      if (!raw) return { config: { ...READ_ONLY_FALLBACK }, degraded: false };
      return { config: normalizeControlPlaneConfig(raw), degraded: false };
    } catch {
      // CHANGE A/C：配置异常 → 回落 READ_ONLY（不继承旧配置），并标记 degraded
      return { config: { ...READ_ONLY_FALLBACK }, degraded: true };
    }
  }

  function ownRisk(action: string): ActionRiskClass | undefined {
    return Object.prototype.hasOwnProperty.call(ACTION_GUARD_CATALOG, action)
      ? ACTION_GUARD_CATALOG[action].risk
      : undefined;
  }

  /** 组合能力快照：模式只限权；feature 与模式取交集；Gate 独立 */
  async function resolveCapabilities(input: ActionGuardInput, config: ControlPlaneConfig) {
    const action = String(input?.action ?? '');
    const organizationId = String(input?.organizationId ?? '');
    const base = await capabilitySource.resolve({ organizationId, action });

    const risk = ownRisk(action);
    const gate = config.productionGate ?? PRODUCTION_GATE_DEFAULT;
    if (risk === undefined || config.globalDisabled === true) {
      return {
        tenantEnabled: false,
        writeEnabled: false,
        hostApprovalGranted: false,
        productionGate: PRODUCTION_GATE_DEFAULT as ProductionGateState,
        featureEnabled: {},
        platformEnablement: {},
      };
    }

    const allowedByMode = modeAllowsRisk(risk, config.mode);
    const explicitFeature = config.tenantFeatureEnabled?.[action] === true;
    const platformAllowed = config.platformEnabled?.[action] === true;
    const externalOrMoney = risk === 'EXTERNAL_WRITE' || risk === 'MONEY_MOVEMENT';

    return {
      tenantEnabled: base?.tenantEnabled ?? false,
      featureEnabled: explicitFeature && allowedByMode ? { [action]: true } : {},
      platformEnablement: platformAllowed ? { [action]: true } : {},
      // CHANGE C：WRITE_ENABLED 是必要条件，Gate 必须独立满足
      writeEnabled: externalOrMoney && config.mode === 'WRITE_ENABLED' && gate === 'SATISFIED',
      productionGate: gate,
      hostApprovalGranted: config.hostApprovalGranted === true,
    };
  }

  async function evaluateWith(input: ActionGuardInput, config: ControlPlaneConfig): Promise<ActionGuardResult> {
    const capabilities = await resolveCapabilities(input, config);
    return evaluateActionGuard({ ...input, capabilities });
  }

  async function evaluateWithoutAudit(input: ActionGuardInput, config?: ControlPlaneConfig): Promise<ActionGuardResult> {
    const effective = config ?? (await snapshotFor(String(input?.organizationId ?? ''))).config;
    return evaluateWith(input, effective);
  }

  const guard = createRuntimeActionGuard({
    capabilities: {
      resolve: async (query) => {
        const snapshot = await snapshotFor(query.organizationId);
        return resolveCapabilities({ action: query.action, actorUserId: '', organizationId: query.organizationId }, snapshot.config);
      },
    },
    audit: deps.audit,
  });

  return { guard, capabilitySource, snapshotFor, evaluateWithoutAudit };
}
