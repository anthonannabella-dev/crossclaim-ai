/**
 * RSI Runtime —— 总开关 / 分级开关 / Kill Switch 契约（纯函数，零 IO）
 * ---------------------------------------------------------------
 * 依据 OWNER 任务《RSI Runtime / Autonomous Maintenance Runtime》第六、七节：
 *   · 默认值必须精确等于规格（含 AUTO_PROMOTE_LOW_RISK = false）；
 *   · RSI_ENABLED=false 时：不创建新任务，但**不得影响 CrossClaim 主业务**；
 *   · Kill Switch（RSI_PAUSED）暂停新 incident/candidate/patch/promotion，但审计轨迹不删、
 *     生产 baseline 不受影响、主系统继续运行；
 *   · Kill Switch 本身**不得由 RSI 自己关闭或绕过**（与 rsi-lifecycle 的 OWNER gate 一致）。
 */

import { requiresOwnerApproval } from './rsi-lifecycle';

export const RSI_STAGES = [
  'OBSERVE',
  'AUTO_INCIDENT',
  'AUTO_PATCH',
  'AUTO_VALIDATE',
  'AUTO_JUDGE',
  'AUTO_PROMOTE_LOW_RISK',
] as const;
export type RsiStage = (typeof RSI_STAGES)[number];

export interface RsiFlags {
  enabled: boolean;
  paused: boolean;
  stages: Record<RsiStage, boolean>;
}

/** 规格默认值（不得随意改动；kills switch 默认未触发）。 */
export const RSI_DEFAULT_FLAGS: RsiFlags = {
  enabled: true,
  paused: false,
  stages: {
    OBSERVE: true,
    AUTO_INCIDENT: true,
    AUTO_PATCH: true,
    AUTO_VALIDATE: true,
    AUTO_JUDGE: true,
    AUTO_PROMOTE_LOW_RISK: false,
  },
};

export const RSI_HEALTH_STATES = ['STARTING', 'HEALTHY', 'DEGRADED', 'PAUSED', 'BLOCKED', 'FAILED'] as const;
export type RsiHealthState = (typeof RSI_HEALTH_STATES)[number];

const readBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
};

/** 从环境变量解析 flags：未设置项一律取规格默认值；Kill Switch 只认显式真值。 */
export function resolveRsiFlags(env: Record<string, string | undefined> = {}): RsiFlags {
  return {
    enabled: readBool(env.RSI_ENABLED, RSI_DEFAULT_FLAGS.enabled),
    paused: readBool(env.RSI_PAUSED, RSI_DEFAULT_FLAGS.paused),
    stages: {
      OBSERVE: readBool(env.RSI_OBSERVE_ENABLED, RSI_DEFAULT_FLAGS.stages.OBSERVE),
      AUTO_INCIDENT: readBool(env.RSI_AUTO_INCIDENT_ENABLED, RSI_DEFAULT_FLAGS.stages.AUTO_INCIDENT),
      AUTO_PATCH: readBool(env.RSI_AUTO_PATCH_ENABLED, RSI_DEFAULT_FLAGS.stages.AUTO_PATCH),
      AUTO_VALIDATE: readBool(env.RSI_AUTO_VALIDATE_ENABLED, RSI_DEFAULT_FLAGS.stages.AUTO_VALIDATE),
      AUTO_JUDGE: readBool(env.RSI_AUTO_JUDGE_ENABLED, RSI_DEFAULT_FLAGS.stages.AUTO_JUDGE),
      AUTO_PROMOTE_LOW_RISK: readBool(
        env.RSI_AUTO_PROMOTE_LOW_RISK_ENABLED,
        RSI_DEFAULT_FLAGS.stages.AUTO_PROMOTE_LOW_RISK,
      ),
    },
  };
}

/** 某个阶段当前是否可执行：总开关关 / Kill Switch 触发 / 该阶段关闭 / promote 未显式开启 → 均不可执行。 */
export function canRunStage(flags: RsiFlags, stage: RsiStage): boolean {
  if (!flags.enabled) return false;
  if (flags.paused) return false;
  const stageEnabled = flags.stages[stage];
  if (!stageEnabled) return false;
  if (stage === 'AUTO_PROMOTE_LOW_RISK') {
    // 即便总开关打开，自动 promote 也必须显式开启（默认 false）。
    return flags.stages.AUTO_PROMOTE_LOW_RISK === true;
  }
  return true;
}

/** 关闭 RSI 是否会影响主业务：规格要求「绝不影响」。 */
export function rsiAffectsMainBusiness(): false {
  return false;
}

/** Kill Switch 只能由 OWNER/Policy 关闭；RSI 自身不得关闭或绕过。 */
export function canRsiToggleKillSwitch(): false {
  return false;
}

export function killSwitchIsOwnerGated(): boolean {
  return requiresOwnerApproval('KILL_SWITCH_DISABLE');
}

/** 由 flags 推导健康态（供 Runtime 健康检查暴露）。 */
export function deriveHealthState(flags: RsiFlags, runtime: { crashed?: boolean; crashLoop?: boolean } = {}): RsiHealthState {
  if (runtime.crashLoop) return 'DEGRADED';
  if (runtime.crashed) return 'FAILED';
  if (!flags.enabled) return 'PAUSED';
  if (flags.paused) return 'PAUSED';
  return 'HEALTHY';
}
