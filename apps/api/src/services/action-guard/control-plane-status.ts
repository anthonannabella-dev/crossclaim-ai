/**
 * CONTROL PLANE STATUS PROJECTION v2（MSG-20260930-14 CHANGE A/D）
 * ----------------------------------------------------------------
 * - 针对**显式租户**读取**一次**规范化配置快照，再用同一快照生成每行判定（不逐行重读配置）；
 * - 纯评估：零审计写入；
 * - 只遍历动作目录自有键；
 * - 配置源降级时如实标注（不冒充单一一致快照）。
 *
 * 说明：投影中的 ALLOW 只是**策略预检**，不代表已授权执行或审计端口健康；真正执行仍必须走 runtime guard。
 */

import { ACTION_GUARD_CATALOG, type ActionGuardDecision, type ActionGuardInput, type ActionRiskClass } from './action-guard';
import type { ProductionControlPlane } from './control-plane';

export interface ControlPlaneStatusRow {
  action: string;
  risk: ActionRiskClass;
  decision: ActionGuardDecision;
  code: string;
  reasons: string[];
}

export interface ControlPlaneStatus {
  organizationId: string;
  mode: string;
  globalDisabled: boolean;
  productionGate: string;
  /** 配置源异常/缺失导致的降级（此时按 READ_ONLY 快照展示） */
  configDegraded: boolean;
  generatedAt: string;
  rows: ControlPlaneStatusRow[];
  summary: { allow: number; deny: number; requireApproval: number; total: number };
}

export interface ProjectControlPlaneStatusOptions {
  plane: ProductionControlPlane;
  organizationId: string;
  actorUserId?: string;
  /** 注入时钟（便于测试） */
  now?: () => string;
}

export async function projectControlPlaneStatus(options: ProjectControlPlaneStatusOptions): Promise<ControlPlaneStatus> {
  const { plane, organizationId } = options ?? ({} as ProjectControlPlaneStatusOptions);
  if (!plane?.evaluateWithoutAudit) throw new Error('CONTROL_PLANE_STATUS_MISSING_PLANE');
  if (!organizationId) throw new Error('CONTROL_PLANE_STATUS_MISSING_ORGANIZATION');

  const snapshot = await plane.snapshotFor(organizationId);
  const actions = Object.keys(ACTION_GUARD_CATALOG).sort();
  const rows: ControlPlaneStatusRow[] = [];

  for (const action of actions) {
    const input: ActionGuardInput = {
      action,
      actorUserId: options.actorUserId ?? 'control-plane-status',
      organizationId,
    };
    // CHANGE D：所有行使用同一份规范化配置快照
    const result = await plane.evaluateWithoutAudit(input, snapshot.config);
    rows.push({
      action,
      risk: result.risk === 'UNKNOWN' ? 'READ_ONLY' : result.risk,
      decision: result.decision,
      code: result.code,
      reasons: [...result.reasons],
    });
  }

  const summary = { allow: 0, deny: 0, requireApproval: 0, total: rows.length };
  for (const row of rows) {
    if (row.decision === 'ALLOW') summary.allow += 1;
    else if (row.decision === 'REQUIRE_APPROVAL') summary.requireApproval += 1;
    else summary.deny += 1;
  }

  return {
    organizationId,
    mode: snapshot.config.mode,
    globalDisabled: snapshot.config.globalDisabled,
    productionGate: snapshot.config.productionGate ?? 'NOT_SATISFIED',
    configDegraded: snapshot.degraded,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    rows,
    summary,
  };
}
