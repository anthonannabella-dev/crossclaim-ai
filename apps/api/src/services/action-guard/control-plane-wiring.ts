/**
 * CONTROL PLANE WIRING v2（MSG-20260930-14 CHANGE A）
 * ---------------------------------------------------
 * 删除「上次租户」共享状态：所有配置读取都由 `createProductionControlPlane` 以**本次调用的 organizationId**
 * 显式发起；wiring 只负责把真实依赖（Kill Switch / 审计 / 只读配置端口）接上，不保存任何请求上下文。
 */

import {
  createProductionControlPlane,
  type ControlPlaneConfigPort,
  type ProductionControlPlane,
} from './control-plane';
import type { KillSwitchReadPort } from './capability-source';
import type { ActionGuardAuditPort } from './runtime-guard';

export interface ControlPlaneWiringDeps {
  /** 真实 Kill Switch 解析端口（services/operations/kill-switch-resolver 经 kill-switch-adapter 适配） */
  killSwitch: KillSwitchReadPort;
  /** 真实审计落地端口 */
  audit: ActionGuardAuditPort;
  /** 只读配置端口（服务端可信来源）；缺省即 READ_ONLY */
  config?: ControlPlaneConfigPort;
}

export type WiredControlPlane = ProductionControlPlane;

export function createWiredControlPlane(deps: ControlPlaneWiringDeps): WiredControlPlane {
  if (!deps?.killSwitch) throw new Error('CONTROL_PLANE_WIRING_MISSING_KILL_SWITCH');
  if (!deps?.audit) throw new Error('CONTROL_PLANE_WIRING_MISSING_AUDIT');
  return createProductionControlPlane({ killSwitch: deps.killSwitch, audit: deps.audit, config: deps.config });
}
