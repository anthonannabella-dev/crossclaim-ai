/** RSI Runtime 总开关 / Kill Switch 契约验收（OWNER 规格第六、七节）。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_DEFAULT_FLAGS,
  canRunStage,
  canRsiToggleKillSwitch,
  deriveHealthState,
  killSwitchIsOwnerGated,
  resolveRsiFlags,
  rsiAffectsMainBusiness,
} from '../services/autonomy/rsi-runtime-config';

describe('RSI Runtime 开关与 Kill Switch', () => {
  it('RSI_FLAGS_DEFAULT_MATCH_SPEC：默认值与规格逐项一致（含 AUTO_PROMOTE=false）', () => {
    const flags = resolveRsiFlags({});
    expect(flags.enabled).toBe(true);
    expect(flags.paused).toBe(false);
    expect(flags.stages).toEqual({
      OBSERVE: true,
      AUTO_INCIDENT: true,
      AUTO_PATCH: true,
      AUTO_VALIDATE: true,
      AUTO_JUDGE: true,
      AUTO_PROMOTE_LOW_RISK: false,
    });
    expect(RSI_DEFAULT_FLAGS.stages.AUTO_PROMOTE_LOW_RISK).toBe(false);
    // 所有阶段默认可用，唯独自动 promote 不可用
    expect(canRunStage(flags, 'OBSERVE')).toBe(true);
    expect(canRunStage(flags, 'AUTO_INCIDENT')).toBe(true);
    expect(canRunStage(flags, 'AUTO_PATCH')).toBe(true);
    expect(canRunStage(flags, 'AUTO_VALIDATE')).toBe(true);
    expect(canRunStage(flags, 'AUTO_JUDGE')).toBe(true);
    expect(canRunStage(flags, 'AUTO_PROMOTE_LOW_RISK')).toBe(false);
  });

  it('RSI_KILL_SWITCH_PAUSES_ALL_STAGES：Kill Switch 触发后所有阶段停止，但审计与主业务不受影响', () => {
    const flags = resolveRsiFlags({ RSI_PAUSED: '1' });
    expect(flags.paused).toBe(true);
    for (const stage of ['OBSERVE', 'AUTO_INCIDENT', 'AUTO_PATCH', 'AUTO_VALIDATE', 'AUTO_JUDGE'] as const) {
      expect(canRunStage(flags, stage)).toBe(false);
    }
    expect(deriveHealthState(flags)).toBe('PAUSED');
    // Kill Switch 不得由 RSI 自行关闭，且关闭动作永远属于 OWNER gate
    expect(canRsiToggleKillSwitch()).toBe(false);
    expect(killSwitchIsOwnerGated()).toBe(true);
    // 主业务不受 RSI 开关影响
    expect(rsiAffectsMainBusiness()).toBe(false);
  });

  it('RSI_DISABLED_BLOCKS_NEW_TASKS_BUT_NOT_MAIN_BUSINESS：RSI_ENABLED=false 只停 RSI', () => {
    const flags = resolveRsiFlags({ RSI_ENABLED: 'false' });
    expect(flags.enabled).toBe(false);
    for (const stage of ['OBSERVE', 'AUTO_INCIDENT', 'AUTO_PATCH', 'AUTO_VALIDATE', 'AUTO_JUDGE'] as const) {
      expect(canRunStage(flags, stage)).toBe(false);
    }
    expect(deriveHealthState(flags)).toBe('PAUSED');
    expect(rsiAffectsMainBusiness()).toBe(false);
  });

  it('RSI_AUTO_PROMOTE_REQUIRES_EXPLICIT_ENABLE：显式开启前不得自动 promote', () => {
    const off = resolveRsiFlags({});
    expect(canRunStage(off, 'AUTO_PROMOTE_LOW_RISK')).toBe(false);

    const on = resolveRsiFlags({ RSI_AUTO_PROMOTE_LOW_RISK_ENABLED: 'true' });
    expect(canRunStage(on, 'AUTO_PROMOTE_LOW_RISK')).toBe(true);

    // 但 Kill Switch 或总开关关闭时，即使配置打开也不得 promote
    expect(canRunStage(resolveRsiFlags({ RSI_AUTO_PROMOTE_LOW_RISK_ENABLED: 'true', RSI_PAUSED: '1' }), 'AUTO_PROMOTE_LOW_RISK')).toBe(false);
    expect(canRunStage(resolveRsiFlags({ RSI_AUTO_PROMOTE_LOW_RISK_ENABLED: 'true', RSI_ENABLED: 'false' }), 'AUTO_PROMOTE_LOW_RISK')).toBe(false);
  });

  it('RSI_HEALTH_STATES_FROM_RUNTIME：crash / crash-loop 分别映射 FAILED / DEGRADED', () => {
    const flags = resolveRsiFlags({});
    expect(deriveHealthState(flags)).toBe('HEALTHY');
    expect(deriveHealthState(flags, { crashed: true })).toBe('FAILED');
    expect(deriveHealthState(flags, { crashLoop: true })).toBe('DEGRADED');
  });
});
