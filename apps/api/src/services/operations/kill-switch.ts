/**
 * KILL SWITCH — 全局/租户级熔断（按 KILL-SWITCH-DESIGN R1 实现）
 * ------------------------------------------------------------------
 * 纪律（MSG-20260929-52 / -53）：
 *   - Scope 六项：submission / billing / integration / platform_connector / workflow / observability
 *   - fail-closed：未知、缺失、解析失败 → disabled（observability 例外：默认 enabled）
 *   - 解析优先级：tenant > global > environment default，逐层**取更严格者**
 *   - 开启需双人确认（OWNER 发起 + 另一 OWNER/ADMIN 确认，≤15 分钟，禁止同一 actor 闭环）
 *   - 关闭 OWNER 单人即可；审计复用 AuditLog（action=killswitch.changed）
 *   - 不改变历史事实：本模块只做状态解析与审计写入，绝不触碰 Claim/Settlement/Billing/AuditLog 既有记录
 */

import type { PrismaClient } from '@prisma/client';

import { WorkflowError } from '../workflow/opportunity-review';

export const KILL_SWITCH_SCOPES = [
  'submission',
  'billing',
  'integration',
  'platform_connector',
  'workflow',
  'observability',
] as const;
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

export type KillSwitchValue = 'enabled' | 'disabled';

/** 缺配置时保护系统：默认熔断；唯一例外是 observability（关闭监控会降低安全性）。 */
export const KILL_SWITCH_DEFAULTS: Record<KillSwitchScope, KillSwitchValue> = {
  submission: 'disabled',
  billing: 'disabled',
  integration: 'disabled',
  platform_connector: 'disabled',
  workflow: 'disabled',
  observability: 'enabled',
};

export const KILL_SWITCH_REASON_CODES = [
  'SECURITY_INCIDENT',
  'PLATFORM_FAILURE',
  'MAINTENANCE',
  'TESTING',
  'OTHER',
] as const;
export type KillSwitchReasonCode = (typeof KILL_SWITCH_REASON_CODES)[number];

/** 双人确认窗口（毫秒）。 */
export const KILL_SWITCH_CONFIRM_WINDOW_MS = 15 * 60 * 1000;

export interface KillSwitchActor {
  organizationId: string;
  actorUserId: string;
  role: string | null | undefined;
}

export interface KillSwitchConfig {
  /** global 层（例如来自运行时配置/环境变量解析结果） */
  global?: Partial<Record<KillSwitchScope, unknown>>;
  /** tenant 层（按 organizationId 索引） */
  tenant?: Record<string, Partial<Record<KillSwitchScope, unknown>>>;
}

/** 只接受显式白名单；其他一律视作无效（→ 更严格层）。 */
function parseValue(raw: unknown): KillSwitchValue | null {
  if (raw === 'enabled') return 'enabled';
  if (raw === 'disabled') return 'disabled';
  return null;
}

/** 更严格者优先：disabled 胜过 enabled。 */
function strictest(a: KillSwitchValue, b: KillSwitchValue): KillSwitchValue {
  return a === 'disabled' || b === 'disabled' ? 'disabled' : 'enabled';
}

/** tenant > global > environment default，逐层取更严格者；非法值按 fail-closed 处理。 */
export function resolveKillSwitch(
  config: KillSwitchConfig | undefined,
  scope: KillSwitchScope,
  organizationId: string,
): { value: KillSwitchValue; source: 'tenant' | 'global' | 'default' } {
  const tenantRaw = config?.tenant?.[organizationId]?.[scope];
  const globalRaw = config?.global?.[scope];

  const tenantValue = parseValue(tenantRaw);
  const globalValue = parseValue(globalRaw);
  const defaultValue = KILL_SWITCH_DEFAULTS[scope];

  // 非法但已配置 → 视为 disabled（fail-closed）
  const tenantEffective: KillSwitchValue | null =
    tenantRaw === undefined ? null : (tenantValue ?? 'disabled');
  const globalEffective: KillSwitchValue | null =
    globalRaw === undefined ? null : (globalValue ?? 'disabled');

  if (tenantEffective !== null) {
    const value = globalEffective === null ? tenantEffective : strictest(tenantEffective, globalEffective);
    return { value, source: 'tenant' };
  }
  if (globalEffective !== null) return { value: globalEffective, source: 'global' };
  return { value: defaultValue, source: 'default' };
}

/** 仅这三个角色可发起变更；OPS/FINANCE/VIEWER 不可。 */
export function canChangeKillSwitch(role: string | null | undefined): boolean {
  return role === 'OWNER';
}

/** 确认人允许 OWNER / ADMIN，且必须是不同的 actor。 */
export function canConfirmKillSwitch(role: string | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** 可见性（最小暴露）：OWNER/ADMIN 全量；OPS 仅开关取值；FINANCE/VIEWER 403。 */
export function assertKillSwitchVisibility(role: string | null | undefined): 'full' | 'summary' {
  if (role === 'OWNER' || role === 'ADMIN') return 'full';
  if (role === 'OPS') return 'summary';
  throw new WorkflowError('FORBIDDEN', '当前角色无权查看 Kill Switch 状态');
}

export interface KillSwitchStatusView {
  visibility: 'full' | 'summary';
  switches: Array<{
    scope: KillSwitchScope;
    value: KillSwitchValue;
    source: string;
    updatedAt?: string;
    actorUserId?: string | null;
  }>;
}

export async function getKillSwitchStatus(
  deps: { prisma: PrismaClient; config?: KillSwitchConfig },
  actor: Pick<KillSwitchActor, 'organizationId' | 'role'>,
): Promise<KillSwitchStatusView> {
  const visibility = assertKillSwitchVisibility(actor.role);
  const switches = KILL_SWITCH_SCOPES.map((scope) => {
    const resolved = resolveKillSwitch(deps.config, scope, actor.organizationId);
    return { scope, value: resolved.value, source: resolved.source };
  });

  if (visibility === 'summary') return { visibility, switches };

  // full：附最近一次变更（来自既有 AuditLog，只读）
  const logs = await deps.prisma.auditLog.findMany({
    where: { organizationId: actor.organizationId, action: 'killswitch.changed' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { createdAt: true, actorUserId: true, changes: true },
  });
  const lastByScope = new Map<string, { updatedAt: string; actorUserId: string | null }>();
  for (const log of logs) {
    const changes = (log.changes ?? {}) as Record<string, unknown>;
    const scope = typeof changes.scope === 'string' ? changes.scope : '';
    if (scope && !lastByScope.has(scope)) {
      lastByScope.set(scope, {
        updatedAt: log.createdAt.toISOString(),
        actorUserId: log.actorUserId ?? null,
      });
    }
  }

  return {
    visibility,
    switches: switches.map((item) => ({
      ...item,
      ...(lastByScope.get(item.scope) ?? {}),
    })),
  };
}

interface PendingConfirmation {
  scope: KillSwitchScope;
  target: KillSwitchValue;
  requestedBy: string;
  organizationId: string;
  reasonCode: KillSwitchReasonCode;
  note?: string;
  requestedAt: number;
}

/** v1：进程内待确认队列（不建表）；生产实现若需持久化 → 走 Schema Delta。 */
const pending = new Map<string, PendingConfirmation>();

function pendingKey(organizationId: string, scope: KillSwitchScope): string {
  return `${organizationId}:${scope}`;
}

function assertReason(reasonCode: unknown, note: unknown): KillSwitchReasonCode {
  if (typeof reasonCode !== 'string' || !(KILL_SWITCH_REASON_CODES as readonly string[]).includes(reasonCode)) {
    throw new WorkflowError('INVALID_INPUT', 'reasonCode 不在白名单内');
  }
  if (note !== undefined && typeof note !== 'string') {
    throw new WorkflowError('INVALID_INPUT', 'note 必须是字符串');
  }
  return reasonCode as KillSwitchReasonCode;
}

export interface KillSwitchChangeInput {
  scope: KillSwitchScope;
  target: KillSwitchValue;
  reasonCode: unknown;
  note?: unknown;
  now?: () => number;
}

export interface KillSwitchChangeResult {
  status: 'applied' | 'awaiting_confirmation';
  scope: KillSwitchScope;
  value: KillSwitchValue;
  confirmationBy?: string;
}

/**
 * 变更 Kill Switch：
 *   - target=disabled（拉闸）：OWNER 单人立即执行；
 *   - target=enabled（解除）：OWNER 发起 → 记录待确认；另一 OWNER/ADMIN 在 ≤15 分钟内确认后生效；
 *     同一 actor 不能完成闭环（confirmationBy !== requestedBy）。
 */
export async function changeKillSwitch(
  deps: { prisma: PrismaClient; config?: KillSwitchConfig },
  actor: KillSwitchActor,
  input: KillSwitchChangeInput,
): Promise<KillSwitchChangeResult> {
  const now = (input.now ?? (() => Date.now()))();

  // 1) 确认路径优先：存在待确认的「开启」请求且未超窗。
  const key = pendingKey(actor.organizationId, input.scope);
  const request = pending.get(key);
  const withinWindow = request ? now - request.requestedAt <= KILL_SWITCH_CONFIRM_WINDOW_MS : false;
  if (input.target === 'enabled' && request && request.target === 'enabled' && withinWindow) {
    if (!canConfirmKillSwitch(actor.role)) {
      throw new WorkflowError('FORBIDDEN', '当前角色无权确认 Kill Switch 变更');
    }
    if (request.requestedBy === actor.actorUserId) {
      throw new WorkflowError('FORBIDDEN', '同一用户不得完成双人确认闭环');
    }
    pending.delete(key);
    await writeAudit(deps, actor, {
      scope: input.scope,
      oldValue: 'disabled',
      newValue: 'enabled',
      reasonCode: request.reasonCode,
      note: request.note,
      confirmationBy: actor.actorUserId,
    });
    return { status: 'applied', scope: input.scope, value: 'enabled', confirmationBy: actor.actorUserId };
  }

  // 2) 新请求路径：仅 OWNER
  if (!canChangeKillSwitch(actor.role)) {
    throw new WorkflowError('FORBIDDEN', '当前角色无权变更 Kill Switch');
  }

  const reasonCode = assertReason(input.reasonCode, input.note);
  const note = typeof input.note === 'string' ? input.note : undefined;
  const current = resolveKillSwitch(deps.config, input.scope, actor.organizationId).value;

  if (input.target === 'disabled') {
    pending.delete(pendingKey(actor.organizationId, input.scope));
    await writeAudit(deps, actor, {
      scope: input.scope,
      oldValue: current,
      newValue: 'disabled',
      reasonCode,
      note,
    });
    return { status: 'applied', scope: input.scope, value: 'disabled' };
  }

  pending.set(pendingKey(actor.organizationId, input.scope), {
    scope: input.scope,
    target: 'enabled',
    requestedBy: actor.actorUserId,
    organizationId: actor.organizationId,
    reasonCode,
    ...(note ? { note } : {}),
    requestedAt: now,
  });
  return { status: 'awaiting_confirmation', scope: input.scope, value: 'disabled' };
}

async function writeAudit(
  deps: { prisma: PrismaClient },
  actor: KillSwitchActor,
  changes: {
    scope: KillSwitchScope;
    oldValue: KillSwitchValue;
    newValue: KillSwitchValue;
    reasonCode: KillSwitchReasonCode;
    note?: string;
    confirmationBy?: string;
  },
): Promise<void> {
  await deps.prisma.auditLog.create({
    data: {
      organizationId: actor.organizationId,
      actorType: 'USER',
      actorUserId: actor.actorUserId,
      action: 'killswitch.changed',
      entityType: 'KillSwitch',
      entityId: `${changes.scope}`,
      changes: {
        scope: changes.scope,
        oldValue: changes.oldValue,
        newValue: changes.newValue,
        reasonCode: changes.reasonCode,
        ...(changes.note ? { note: changes.note } : {}),
        ...(changes.confirmationBy ? { confirmationBy: changes.confirmationBy } : {}),
      },
    },
  });
}

/** 测试辅助：清空进程内待确认队列。 */
export function __resetKillSwitchPending(): void {
  pending.clear();
}


/** 环境层配置：KILLSWITCH_GLOBAL_<SCOPE> = enabled|disabled（非法值由解析层 fail-closed）。 */
export function killSwitchConfigFromEnv(env: NodeJS.ProcessEnv = process.env): KillSwitchConfig {
  const global: Record<string, unknown> = {};
  for (const scope of KILL_SWITCH_SCOPES) {
    const raw = env['KILLSWITCH_GLOBAL_' + scope.toUpperCase()];
    if (raw !== undefined) global[scope] = raw;
  }
  return { global };
}
