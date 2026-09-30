/**
 * ACTION GUARD v1（MSG-20260930-03 授权：从 DESIGN ONLY 进入工程实现）
 * -------------------------------------------------------------------
 * 纪律（fail closed）：
 *   - 未知动作 → DENY（不猜、不兜底放行）
 *   - 状态不可用（capability/flag 缺失）→ DENY
 *   - 高风险动作（外部写入 / 资金 / 密钥）默认全部 DENY，必须逐项满足闸门
 *   - 需要人工审批但缺 approvalId → REQUIRE_APPROVAL
 *   - **禁止任何真实外部写入**：写能力默认关闭（writeEnabled 缺省 false）
 * 本模块为纯函数，不读 env、不写库、不发外部请求。
 */

export const ACTION_GUARD_DECISIONS = ['ALLOW', 'DENY', 'REQUIRE_APPROVAL'] as const;
export type ActionGuardDecision = (typeof ACTION_GUARD_DECISIONS)[number];

export const ACTION_RISK_CLASSES = [
  'READ_ONLY',
  'INTERNAL_WRITE',
  'EXTERNAL_WRITE',
  'MONEY_MOVEMENT',
  'SECRET_ACCESS',
] as const;
export type ActionRiskClass = (typeof ACTION_RISK_CLASSES)[number];

type GateRequirement = 'humanApproval' | 'hostApproval' | 'platformEnablement' | 'productionGate';

export const ACTION_GUARD_CATALOG: Record<string, { risk: ActionRiskClass; requires: GateRequirement[] }> = {
  'evidence.read': { risk: 'READ_ONLY', requires: [] },
  'claim.prepare': { risk: 'INTERNAL_WRITE', requires: [] },
  'billing.draft': { risk: 'INTERNAL_WRITE', requires: [] },
  'claim.submit': { risk: 'EXTERNAL_WRITE', requires: ['humanApproval', 'platformEnablement', 'productionGate'] },
  'appeal.submit': { risk: 'EXTERNAL_WRITE', requires: ['humanApproval', 'platformEnablement', 'productionGate'] },
  'platform.write': { risk: 'EXTERNAL_WRITE', requires: ['humanApproval', 'platformEnablement', 'productionGate'] },
  'commission.charge': { risk: 'MONEY_MOVEMENT', requires: ['humanApproval', 'productionGate'] },
  'payment.capture': { risk: 'MONEY_MOVEMENT', requires: ['humanApproval', 'productionGate'] },
  // ② 第二批 replay：恢复重放是**独立的资金动作身份**，与 payment.capture 审批互不通用（MSG-20260930-22 §6(1)）
  'payment.replay': { risk: 'MONEY_MOVEMENT', requires: ['humanApproval', 'productionGate'] },
  // ② 第二批 retry-due：冻结清单批次审批的独立资金动作身份（与 capture/replay 互不通用）
  'payment.retry_due': { risk: 'MONEY_MOVEMENT', requires: ['humanApproval', 'productionGate'] },
  'secret.rotate': { risk: 'SECRET_ACCESS', requires: ['hostApproval'] },
};

/**
 * CHANGE A（MSG-20260930-12）：动作目录只接受**自有键**。
 * 普通对象索引会命中原型链（toString / constructor / __proto__ 等），
 * 使未知动作绕过 UNKNOWN_ACTION 分支并在后续字段访问时抛 TypeError。
 */
function catalogEntryFor(action: string) {
  return Object.prototype.hasOwnProperty.call(ACTION_GUARD_CATALOG, action) ? ACTION_GUARD_CATALOG[action] : undefined;
}

export interface ActionGuardInput {
  action: string;
  actorUserId: string;
  organizationId: string;
  /** 能力闸门快照；缺失视为不可用 → DENY（fail closed） */
  capabilities?: {
    featureEnabled?: Record<string, boolean>;
    platformEnablement?: Record<string, boolean>;
    tenantEnabled?: boolean;
    productionGate?: 'SATISFIED' | 'NOT_SATISFIED' | 'UNKNOWN';
    /** 写能力（外部写入 / 资金动作）默认关闭 */
    writeEnabled?: boolean;
    hostApprovalGranted?: boolean;
  };
  approvalId?: string;
  requestedBy?: string;
}

export interface ActionGuardResult {
  decision: ActionGuardDecision;
  code: string;
  action: string;
  risk: ActionRiskClass | 'UNKNOWN';
  reasons: string[];
  requiredGates: GateRequirement[];
}

/** 默认 deny / fail closed 的决策函数（纯函数，无副作用） */
export function evaluateActionGuard(input: ActionGuardInput): ActionGuardResult {
  const action = String(input?.action ?? '');
  const entry = catalogEntryFor(action);

  if (!entry) {
    return {
      decision: 'DENY',
      code: 'ACTION_GUARD_UNKNOWN_ACTION',
      action,
      risk: 'UNKNOWN',
      reasons: ['未知动作：不在 ACTION_GUARD_CATALOG 内，默认拒绝（不猜测、不放行）'],
      requiredGates: [],
    };
  }

  const caps = input?.capabilities;
  const base = {
    action,
    risk: entry.risk,
    requiredGates: entry.requires,
  };
  if (!caps) {
    return {
      ...base,
      decision: 'DENY',
      code: 'ACTION_GUARD_STATE_UNAVAILABLE',
      reasons: ['能力闸门状态不可用（fail closed）'],
    };
  }

  // 租户级开关：显式 false 才拒绝；未设置视为未启用（fail closed 对高风险动作）
  const tenantEnabled = caps.tenantEnabled === true;
  const featureEnabled = caps.featureEnabled?.[action] === true;
  const reasons: string[] = [];

  if (entry.risk !== 'READ_ONLY' && !tenantEnabled) {
    reasons.push('tenant-level enablement 未开启');
  }
  if (entry.risk !== 'READ_ONLY' && !featureEnabled) {
    reasons.push('feature flag 未开启');
  }

  const externalOrMoney = entry.risk === 'EXTERNAL_WRITE' || entry.risk === 'MONEY_MOVEMENT';
  if (externalOrMoney && caps.writeEnabled !== true) {
    reasons.push('writeEnabled=false（默认禁止外部写入与资金动作）');
  }
  if (entry.requires.includes('platformEnablement') && caps.platformEnablement?.[action] !== true) {
    reasons.push('platform-level enablement 未开启');
  }
  if (entry.requires.includes('productionGate') && caps.productionGate !== 'SATISFIED') {
    reasons.push(`production gate 未满足（${caps.productionGate ?? 'UNKNOWN'}）`);
  }
  if (entry.requires.includes('hostApproval') && caps.hostApprovalGranted !== true) {
    reasons.push('HOST APPROVAL 未授予');
  }
  if (reasons.length > 0) {
    return { ...base, decision: 'DENY', code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET', reasons };
  }

  if (entry.requires.includes('humanApproval') && !input.approvalId) {
    return {
      ...base,
      decision: 'REQUIRE_APPROVAL',
      code: 'ACTION_GUARD_HUMAN_APPROVAL_REQUIRED',
      reasons: ['AI Prepare → Human Approve → Submit：缺少 approvalId'],
    };
  }

  return { ...base, decision: 'ALLOW', code: 'ACTION_GUARD_ALLOWED', reasons: ['全部门闸满足'] };
}

/** 审计事件（白名单；构造期拒绝未知字段，避免敏感值外泄） */
export function buildActionGuardAuditEvent(result: ActionGuardResult, input: ActionGuardInput) {
  const event = {
    action: 'action_guard.evaluated',
    actionName: result.action,
    decision: result.decision,
    code: result.code,
    risk: result.risk,
    actorUserId: String(input.actorUserId ?? ''),
    organizationId: String(input.organizationId ?? ''),
    approvalId: input.approvalId ? String(input.approvalId) : null,
    reasonCodes: [...result.reasons],
  };
  const allowed = new Set([
    'action',
    'actionName',
    'decision',
    'code',
    'risk',
    'actorUserId',
    'organizationId',
    'approvalId',
    'reasonCodes',
  ]);
  for (const key of Object.keys(event)) {
    if (!allowed.has(key)) throw new Error('ACTION_GUARD_AUDIT_FIELD_REJECTED: ' + key);
  }
  return event;
}
