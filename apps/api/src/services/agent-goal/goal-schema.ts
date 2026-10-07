// AGENT EXPERIENCE LAYER / P1 — Goal 严格 schema（allowlist + 未知字段拒绝）
// ---------------------------------------------------------------------------
// 自然语言**不得直接执行**：结构化 goal 必须先过这一层「形状 + 白名单」校验，
// 任何未知字段、越权字段（tenant / 权限 / 动作 / 工具 / 服务）都在这里被拒绝。
//
// 设计取舍：仓库未引入 zod 等 schema 库（依赖需过许可证闸门），因此这里用**手写严格校验**：
//   ① 每层只允许显式列出的键；
//   ② 越权类键（tenant / 权限 / action / service / tool …）单独识别并给出精确 reason；
//   ③ 递归深度固定（只有 root / timeRange / approvalThreshold 三层），不做任意深度遍历。

import { AGENT_GOAL_VERSION } from './goal-contract';

export const GOAL_SCHEMA_VERSION = 'agent-goal-schema/v1';

/** 每层允许的键（除此之外一律 GOAL_UNKNOWN_FIELD） */
export const GOAL_DRAFT_ALLOWED_KEYS = {
  root: [
    'goalType',
    'domains',
    'timeRange',
    'executionMode',
    'approvalThreshold',
    'matchedSignals',
  ],
  timeRange: ['kind', 'months'],
  approvalThreshold: ['currency', 'amount'],
} as const;

/**
 * 禁止出现在 goal 里的字段类别（越权 / 注入）。
 * 任一命中 → 精确 reason（tenant 伪造 / 动作注入 / 服务注入）。
 */
export const GOAL_FORBIDDEN_TENANT_KEYS = [
  'organizationId',
  'organization',
  'orgId',
  'tenantId',
  'tenant',
  'accountId',
  'platformAccountId',
  'provider',
  'providerId',
  'userId',
  'actorUserId',
  'role',
  'roles',
  'membership',
  'permission',
  'permissions',
  'capability',
  'capabilities',
  'authorization',
  'authorizationId',
  'standingAuthorization',
  'scopeDigest',
  'consentEvidenceRef',
] as const;

export const GOAL_FORBIDDEN_ACTION_KEYS = [
  'action',
  'actions',
  'actionType',
  'actionTypes',
  'allowedActionTypes',
  'guardAction',
  'approvalId',
  'task',
  'tasks',
  'dedupeKey',
  'taskNamespace',
] as const;

export const GOAL_FORBIDDEN_SERVICE_KEYS = [
  'service',
  'services',
  'tool',
  'tools',
  'toolName',
  'function',
  'functions',
  'method',
  'endpoint',
  'url',
  'uri',
  'http',
  'sql',
  'query',
  'mutation',
  'script',
  'filePath',
  'require',
  'import',
  'eval',
  'model',
  'modelRoute',
  'prompt',
] as const;

const ALL_FORBIDDEN = new Map<string, GoalShapeReason>();
for (const key of GOAL_FORBIDDEN_TENANT_KEYS) ALL_FORBIDDEN.set(key, 'TENANT_FORGED');
for (const key of GOAL_FORBIDDEN_ACTION_KEYS) ALL_FORBIDDEN.set(key, 'ACTION_INJECTION');
for (const key of GOAL_FORBIDDEN_SERVICE_KEYS) ALL_FORBIDDEN.set(key, 'SERVICE_INJECTION');

export type GoalShapeReason =
  | 'NOT_AN_OBJECT'
  | 'UNKNOWN_FIELD'
  | 'TENANT_FORGED'
  | 'ACTION_INJECTION'
  | 'SERVICE_INJECTION'
  | 'MISSING_FIELD'
  | 'WRONG_TYPE';

export type GoalShapeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: GoalShapeReason; readonly detail: string };

const fail = (reason: GoalShapeReason, detail: string): GoalShapeCheck => ({ ok: false, reason, detail });
const OK: GoalShapeCheck = { ok: true };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 逐层检查键：先判越权类别，再判是否在白名单内 */
function checkKeys(value: Record<string, unknown>, level: 'root' | 'timeRange' | 'approvalThreshold'): GoalShapeCheck {
  const allowed = new Set<string>(GOAL_DRAFT_ALLOWED_KEYS[level]);
  for (const key of Object.keys(value)) {
    const forbidden = ALL_FORBIDDEN.get(key);
    if (forbidden !== undefined) return fail(forbidden, `${level}.${key}`);
    if (!allowed.has(key)) return fail('UNKNOWN_FIELD', `${level}.${key}`);
  }
  return OK;
}

function checkStringArray(value: unknown, detail: string): GoalShapeCheck {
  if (!Array.isArray(value)) return fail('WRONG_TYPE', detail);
  for (const item of value) {
    if (typeof item !== 'string') return fail('WRONG_TYPE', detail);
  }
  return OK;
}

/**
 * 严格形状校验（不做语义判断：goal type / domain 取值合法性由 `goal-validator.ts` 决定）。
 * 任何对象层出现越权键 → 立即失败（fail-closed）。
 */
export function checkGoalDraftShape(draft: unknown): GoalShapeCheck {
  if (!isPlainObject(draft)) return fail('NOT_AN_OBJECT', 'goal draft 必须是对象');

  const rootKeys = checkKeys(draft, 'root');
  if (!rootKeys.ok) return rootKeys;

  if (!('goalType' in draft)) return fail('MISSING_FIELD', 'goalType');
  if (typeof draft.goalType !== 'string') return fail('WRONG_TYPE', 'goalType');
  if (!('domains' in draft)) return fail('MISSING_FIELD', 'domains');
  const domains = checkStringArray(draft.domains, 'domains');
  if (!domains.ok) return domains;
  if (!('timeRange' in draft)) return fail('MISSING_FIELD', 'timeRange');
  if (!('executionMode' in draft)) return fail('MISSING_FIELD', 'executionMode');
  if (typeof draft.executionMode !== 'string') return fail('WRONG_TYPE', 'executionMode');

  if (!isPlainObject(draft.timeRange)) return fail('WRONG_TYPE', 'timeRange');
  const timeKeys = checkKeys(draft.timeRange, 'timeRange');
  if (!timeKeys.ok) return timeKeys;
  if (typeof draft.timeRange.kind !== 'string') return fail('WRONG_TYPE', 'timeRange.kind');
  if (draft.timeRange.months !== undefined && typeof draft.timeRange.months !== 'number') {
    return fail('WRONG_TYPE', 'timeRange.months');
  }

  if (draft.approvalThreshold !== undefined && draft.approvalThreshold !== null) {
    if (!isPlainObject(draft.approvalThreshold)) return fail('WRONG_TYPE', 'approvalThreshold');
    const thresholdKeys = checkKeys(draft.approvalThreshold, 'approvalThreshold');
    if (!thresholdKeys.ok) return thresholdKeys;
    if (typeof draft.approvalThreshold.currency !== 'string') {
      return fail('WRONG_TYPE', 'approvalThreshold.currency');
    }
    if (typeof draft.approvalThreshold.amount !== 'number') {
      return fail('WRONG_TYPE', 'approvalThreshold.amount');
    }
  }

  if (draft.matchedSignals !== undefined) {
    const signals = checkStringArray(draft.matchedSignals, 'matchedSignals');
    if (!signals.ok) return signals;
  }

  return OK;
}

export const GOAL_SCHEMA_BOUNDARY = {
  version: GOAL_SCHEMA_VERSION,
  strictAllowlist: true,
  unknownFieldRejected: true,
  forbiddenClasses: ['TENANT_FORGED', 'ACTION_INJECTION', 'SERVICE_INJECTION'],
  maxDepth: 3,
  usesSchemaLibrary: false,
  referencesAgentGoalVersion: AGENT_GOAL_VERSION,
} as const;
