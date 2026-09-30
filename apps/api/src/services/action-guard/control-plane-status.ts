/**
 * CONTROL PLANE STATUS PROJECTION（授权项 ③；MSG-20260930-12 §5 口径修正）
 * ----------------------------------------------------------------------
 * 只读状态投影：给定控制面与租户，输出**全部目录动作**的判定结果，供运营面板/预检使用。
 *
 * 关键纪律：
 *   - **纯评估**：调用 \`plane.evaluateWithoutAudit\`，不写审计、不改变任何状态；
 *     架构方明确指出 \`runtime.evaluate\` 会尝试写审计，展示场景不得沿用它；
 *   - 只遍历**动作目录自有键**（不遍历原型链、不接受调用方传入的动作列表）；
 *   - 不读 env、不写库、不发请求。
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

  const config = await plane.snapshot();
  const actions = Object.keys(ACTION_GUARD_CATALOG).sort();
  const rows: ControlPlaneStatusRow[] = [];

  for (const action of actions) {
    const input: ActionGuardInput = {
      action,
      actorUserId: options.actorUserId ?? 'control-plane-status',
      organizationId,
      // 审批与 capabilities 都不由调用方提供：能力一律来自控制面组合逻辑
    };
    const result = await plane.evaluateWithoutAudit(input);
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
    mode: config.mode,
    globalDisabled: config.globalDisabled,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    rows,
    summary,
  };
}
