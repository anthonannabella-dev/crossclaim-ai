/**
 * KILL SWITCH — 全局/租户级熔断（读层 + 变更入口）
 * ------------------------------------------------------------------
 * 纪律（MSG-20260929-52 / -53 / -55 / -57 / -60）：
 *   - Scope 六项：submission / billing / integration / platform_connector / workflow / observability
 *   - fail-closed：未知、缺失、解析失败 → disabled（observability 例外：默认 enabled）
 *   - 解析优先级：tenant > global > environment default，逐层**取更严格者**
 *   - 开启需双人确认（OWNER 发起 + 另一 OWNER/ADMIN 确认，≤15 分钟，禁止同一 actor 闭环）
 *   - 关闭 OWNER 单人即可
 *   - 变更入口（POST /admin/kill-switch）：phase×target 校验 / CSRF / 幂等持久化 / 双人确认 /
 *     15 分钟窗口 / CAS 状态迁移 / emergency=true 审计
 *   - 不改变历史事实：本模块只做状态解析、控制面请求与审计写入，
 *     绝不触碰 Claim / Settlement / Billing / Payment 既有记录，也不触发任何自动动作
 *
 * 幂等与并发的持久化真相：KillSwitchRequest（20260930090000_kill_switch_request）。
 *   · 幂等键 (organizationId, idempotencyKey) 唯一 —— 跨进程 / 跨重启 / 跨实例成立
 *   · 同租户同 scope 仅一条 PENDING_ENABLE —— 部分唯一索引 kill_switch_request_pending_unique
 *   · 状态迁移一律 CAS（updateMany + 状态守卫），竞态下只有一个能收口
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

import { createHash } from 'node:crypto';

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
export type KillSwitchTargetValue = 'ENABLED' | 'DISABLED';
export type KillSwitchRequestStateValue = 'PENDING_ENABLE' | 'APPLIED' | 'EXPIRED' | 'CANCELLED';

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
/** note 上限（MSG-20260929-55 §11.5）。 */
export const KILL_SWITCH_MAX_NOTE_LENGTH = 200;
/** 速率限制：同一 (organizationId, actorUserId, scope) 每分钟最多 5 次 POST。 */
export const KILL_SWITCH_RATE_LIMIT_PER_MINUTE = 5;
export const KILL_SWITCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;
/** CSRF：浏览器路径必须带自定义头（MSG-20260929-55 §11.2）。 */
export const KILL_SWITCH_CSRF_HEADER = 'x-crossclaim-csrf';
export const KILL_SWITCH_CSRF_HEADER_VALUE = '1';
/** 变更入口审计动作（读层按同一 action 回溯最近变更）。 */
export const KILL_SWITCH_AUDIT_ACTION = 'killswitch.changed';

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

/** 仅 OWNER 可发起变更；OPS/FINANCE/VIEWER/ADMIN 不可（ADMIN 只能确认）。 */
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

// ============================================================
// 错误类型（HTTP 层映射：403 / 429）
// ============================================================

/** CSRF 校验失败（同源校验 + 自定义头）。审计中绝不出现 token 值。 */
export class CsrfRejectedError extends Error {
  readonly code = 'CSRF_REJECTED';

  constructor(message = '跨站请求被拒绝') {
    super(message);
    this.name = 'CsrfRejectedError';
  }
}

/** 速率限制（emergency reasonCode 不受限，但审计必须带 emergency=true）。 */
export class RateLimitedError extends Error {
  readonly code = 'RATE_LIMITED';

  constructor(message = '请求过于频繁') {
    super(message);
    this.name = 'RateLimitedError';
  }
}

// ============================================================
// 读层（GET /admin/kill-switch）
// ============================================================

export interface KillSwitchSwitchView {
  scope: KillSwitchScope;
  value: KillSwitchValue;
  source: string;
  updatedAt?: string;
  actorUserId?: string | null;
  /** 仅 full 可见：控制面状态（与 KillSwitchRequest 一致，避免「审计说 pending」的分裂） */
  controlState?: KillSwitchRequestStateValue | 'NONE';
  pendingRequest?: {
    requestId: string;
    expiresAt: string;
    requestedBy: string;
    target: KillSwitchTargetValue;
  };
  lastRequest?: {
    requestId: string;
    state: KillSwitchRequestStateValue;
    target: KillSwitchTargetValue;
    appliedAt: string | null;
  };
}

export interface KillSwitchStatusView {
  visibility: 'full' | 'summary';
  switches: KillSwitchSwitchView[];
}

export async function getKillSwitchStatus(
  deps: { prisma: PrismaClient; config?: KillSwitchConfig },
  actor: Pick<KillSwitchActor, 'organizationId' | 'role'>,
  options: { now?: () => Date } = {},
): Promise<KillSwitchStatusView> {
  const visibility = assertKillSwitchVisibility(actor.role);
  const now = options.now ? options.now() : new Date();
  const switches: KillSwitchSwitchView[] = KILL_SWITCH_SCOPES.map((scope) => {
    const resolved = resolveKillSwitch(deps.config, scope, actor.organizationId);
    return { scope, value: resolved.value, source: resolved.source };
  });

  if (visibility === 'summary') return { visibility, switches };

  // full：附最近一次变更（来自既有 AuditLog，只读）
  const logs = await deps.prisma.auditLog.findMany({
    where: { organizationId: actor.organizationId, action: KILL_SWITCH_AUDIT_ACTION },
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

  // full：附控制面状态（pending / 最近 APPLIED），来源为 KillSwitchRequest（不是进程内状态）
  const requests = await deps.prisma.killSwitchRequest.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      scope: true,
      target: true,
      state: true,
      requestedBy: true,
      expiresAt: true,
      appliedAt: true,
    },
  });
  const pendingByScope = new Map<string, (typeof requests)[number]>();
  const appliedByScope = new Map<string, (typeof requests)[number]>();
  for (const row of requests) {
    if (row.state === 'PENDING_ENABLE' && row.expiresAt.getTime() > now.getTime() && !pendingByScope.has(row.scope)) {
      pendingByScope.set(row.scope, row);
    }
    if (row.state === 'APPLIED' && row.appliedAt !== null && !appliedByScope.has(row.scope)) {
      appliedByScope.set(row.scope, row);
    }
  }

  return {
    visibility,
    switches: switches.map((item) => {
      const pending = pendingByScope.get(item.scope);
      const applied = appliedByScope.get(item.scope);
      const lastRequest = applied
        ? {
            requestId: applied.id,
            state: applied.state as KillSwitchRequestStateValue,
            target: applied.target as KillSwitchTargetValue,
            appliedAt: applied.appliedAt ? applied.appliedAt.toISOString() : null,
          }
        : undefined;
      return {
        ...item,
        ...(lastByScope.get(item.scope) ?? {}),
        controlState: pending ? 'PENDING_ENABLE' : applied ? 'APPLIED' : 'NONE',
        ...(pending
          ? {
              pendingRequest: {
                requestId: pending.id,
                expiresAt: pending.expiresAt.toISOString(),
                requestedBy: pending.requestedBy,
                target: pending.target as KillSwitchTargetValue,
              },
            }
          : {}),
        ...(lastRequest ? { lastRequest } : {}),
      };
    }),
  };
}

// ============================================================
// 变更入口（POST /admin/kill-switch）
// ============================================================

type Db = PrismaClient | Prisma.TransactionClient;

export interface KillSwitchChangeInput {
  scope: unknown;
  target: unknown;
  phase: unknown;
  reasonCode: unknown;
  note?: unknown;
  /** 仅 phase=confirm 必填：被确认的申请 id */
  requestId?: unknown;
  idempotencyKey: unknown;
}

export interface KillSwitchChangeResult {
  status: 'applied' | 'awaiting_confirmation';
  scope: KillSwitchScope;
  value: KillSwitchValue;
  requestId: string;
  state: KillSwitchRequestStateValue;
  /** 幂等重放（同键第二次 / 已 APPLIED 的确认重试）：不写第二条审计、不改状态 */
  replayed: boolean;
  confirmationBy?: string | null;
  expiresAt?: string;
}

function assertScope(raw: unknown): KillSwitchScope {
  if (typeof raw !== 'string' || !(KILL_SWITCH_SCOPES as readonly string[]).includes(raw)) {
    throw new WorkflowError('INVALID_INPUT', 'scope 不在白名单内');
  }
  return raw as KillSwitchScope;
}

function assertTarget(raw: unknown): KillSwitchTargetValue {
  if (raw === 'enabled') return 'ENABLED';
  if (raw === 'disabled') return 'DISABLED';
  throw new WorkflowError('INVALID_INPUT', 'target 必须是 enabled 或 disabled');
}

function assertPhase(raw: unknown): 'request' | 'confirm' {
  if (raw === 'request' || raw === 'confirm') return raw;
  throw new WorkflowError('INVALID_INPUT', 'phase 必须是 request 或 confirm');
}

function assertReason(raw: unknown): KillSwitchReasonCode {
  if (typeof raw !== 'string' || !(KILL_SWITCH_REASON_CODES as readonly string[]).includes(raw)) {
    throw new WorkflowError('INVALID_REASON', 'reasonCode 不在白名单内');
  }
  return raw as KillSwitchReasonCode;
}

/** 凭据形态（大小写不敏感）：`secret|token|key|password` + `:`/`=`，JWT，长 hex / base64。 */
const KILL_SWITCH_NOTE_SECRET_PATTERNS: readonly RegExp[] = [
  /(secret|token|key|password)\s*[:=]/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b[A-Fa-f0-9]{32,}\b/,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
];

/** note 校验（≤200 字符 + 凭据形态拒绝；MSG-20260929-55 §11.5）。导出以便离线用例直接覆盖。 */
export function validateKillSwitchNote(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new WorkflowError('INVALID_INPUT', 'note 必须是字符串');
  if (raw.length > KILL_SWITCH_MAX_NOTE_LENGTH) {
    throw new WorkflowError('INVALID_INPUT', `note 不得超过 ${KILL_SWITCH_MAX_NOTE_LENGTH} 字符`);
  }
  for (const pattern of KILL_SWITCH_NOTE_SECRET_PATTERNS) {
    if (pattern.test(raw)) throw new WorkflowError('SECRET_NOT_ACCEPTED', 'note 不得包含凭据样式内容');
  }
  return raw;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertIdempotencyKey(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
    throw new WorkflowError('INVALID_INPUT', 'idempotencyKey 必须是 UUID');
  }
  return raw.toLowerCase();
}

/** 幂等键哈希（审计只存哈希，不落客户端原值）。 */
export function hashIdempotencyKey(organizationId: string, idempotencyKey: string): string {
  return createHash('sha256').update(`${organizationId}|${idempotencyKey}`).digest('hex').slice(0, 32);
}

/** CSRF：同源（Origin/Referer 与 Host 一致）+ 自定义头（服务端强制，不仅是前端约定）。 */
export function assertKillSwitchCsrf(input: {
  origin?: string | undefined;
  referer?: string | undefined;
  host?: string | undefined;
  csrfHeader?: string | undefined;
}): void {
  if (input.csrfHeader !== KILL_SWITCH_CSRF_HEADER_VALUE) throw new CsrfRejectedError();
  const source = input.origin ?? input.referer;
  if (!source) throw new CsrfRejectedError('缺少 Origin/Referer');
  let sourceHost: string;
  try {
    sourceHost = new URL(source).host;
  } catch {
    throw new CsrfRejectedError('Origin/Referer 非法');
  }
  if (!input.host || sourceHost !== input.host) throw new CsrfRejectedError();
}

const rateBuckets = new Map<string, number[]>();

/**
 * 速率限制：同 (organizationId, actorUserId, scope) 每分钟最多 5 次 POST。
 * `SECURITY_INCIDENT`（紧急关闭）不受限 —— 但必须留痕（审计带 emergency=true）。
 * v1 为进程内计数（软控制）；持久化限流不属本阶段范围。
 */
export function enforceKillSwitchRateLimit(
  actor: Pick<KillSwitchActor, 'organizationId' | 'actorUserId'>,
  scope: unknown,
  reasonCode: unknown,
  nowMs: number = Date.now(),
): void {
  if (reasonCode === 'SECURITY_INCIDENT') return;
  const key = `${actor.organizationId}:${actor.actorUserId}:${typeof scope === 'string' ? scope : 'invalid'}`;
  const cutoff = nowMs - KILL_SWITCH_RATE_LIMIT_WINDOW_MS;
  const hits = (rateBuckets.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= KILL_SWITCH_RATE_LIMIT_PER_MINUTE) {
    rateBuckets.set(key, hits);
    throw new RateLimitedError();
  }
  hits.push(nowMs);
  rateBuckets.set(key, hits);
}

/** 测试辅助：清空进程内速率限制桶。 */
export function __resetKillSwitchRateLimit(): void {
  rateBuckets.clear();
}

interface AuditActor {
  organizationId: string;
  actorUserId: string | null;
  actorType: 'USER' | 'SYSTEM';
  actorRef?: string;
}

async function writeKillSwitchAudit(
  db: Db,
  actor: AuditActor,
  changes: Record<string, unknown>,
): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId: actor.organizationId,
      actorType: actor.actorType,
      ...(actor.actorType === 'USER' ? { actorUserId: actor.actorUserId } : { actorRef: actor.actorRef ?? 'kill-switch' }),
      action: KILL_SWITCH_AUDIT_ACTION,
      entityType: 'KillSwitch',
      entityId: String(changes.scope ?? 'unknown'),
      changes: changes as Prisma.InputJsonValue,
    },
  });
}

/**
 * 惰性收口过期申请：CAS（state=PENDING_ENABLE AND expiresAt<=now → EXPIRED），
 * 竞态时与 confirm 的 CAS 只有一个能成功。每次状态变化写一条审计。
 */
export async function expirePendingKillSwitchRequests(
  db: Db,
  options: { organizationId: string; scope?: KillSwitchScope; now: Date; actorRef?: string },
): Promise<{ expired: string[] }> {
  const stale = await db.killSwitchRequest.findMany({
    where: {
      organizationId: options.organizationId,
      ...(options.scope ? { scope: options.scope } : {}),
      state: 'PENDING_ENABLE',
      expiresAt: { lte: options.now },
    },
    select: { id: true, scope: true, target: true, reasonCode: true, requestedBy: true, expiresAt: true },
  });
  const expired: string[] = [];
  for (const row of stale) {
    const cas = await db.killSwitchRequest.updateMany({
      where: { id: row.id, state: 'PENDING_ENABLE', expiresAt: { lte: options.now } },
      data: { state: 'EXPIRED' },
    });
    if (cas.count === 0) continue; // 竞态：已被 confirm / cancel 收口
    expired.push(row.id);
    await writeKillSwitchAudit(
      db,
      { organizationId: options.organizationId, actorUserId: null, actorType: 'SYSTEM', actorRef: options.actorRef ?? 'kill-switch-expiry' },
      {
        scope: row.scope,
        oldValue: 'disabled',
        newValue: 'disabled',
        reasonCode: row.reasonCode,
        phase: 'expire',
        target: row.target,
        requestId: row.id,
        state: 'EXPIRED',
        requestedBy: row.requestedBy,
        expiresAt: row.expiresAt.toISOString(),
        occurredAt: options.now.toISOString(),
      },
    );
  }
  return { expired };
}

/**
 * 变更 Kill Switch（唯一写入口，POST /admin/kill-switch）。
 *
 *   phase=request + target=disabled → OWNER 单人立即 APPLIED（并取消同 scope 的 pending enable）
 *   phase=request + target=enabled  → 创建 PENDING_ENABLE（15 分钟窗口，等待他人确认）
 *   phase=confirm + target=enabled  → 另一 OWNER/ADMIN 在窗口内确认 → APPLIED
 *   phase=confirm + target=disabled → 400（组合非法）
 *
 * 幂等：同 (organizationId, idempotencyKey) 返回首次结果，不写第二条审计、不改状态。
 * 事务：请求/状态变更 + 审计写入同一事务；审计失败即整体回滚。
 */
export async function changeKillSwitch(
  deps: { prisma: PrismaClient; config?: KillSwitchConfig },
  actor: KillSwitchActor,
  input: KillSwitchChangeInput,
  options: { now?: () => Date } = {},
): Promise<KillSwitchChangeResult> {
  const now = options.now ? options.now() : new Date();
  const scope = assertScope(input.scope);
  const target = assertTarget(input.target);
  const phase = assertPhase(input.phase);
  const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  const reasonCode = assertReason(input.reasonCode);
  const note = validateKillSwitchNote(input.note);

  // phase × target 组合（MSG-20260929-55 §11.1）
  if (phase === 'confirm' && target === 'DISABLED') {
    throw new WorkflowError('INVALID_INPUT', 'confirm 只能用于 enabled 申请');
  }

  const requestId = typeof input.requestId === 'string' ? input.requestId : undefined;
  if (phase === 'confirm' && !requestId) {
    throw new WorkflowError('INVALID_INPUT', 'confirm 必须带 requestId');
  }

  // 角色：发起仅 OWNER；确认 OWNER/ADMIN
  if (phase === 'request' && !canChangeKillSwitch(actor.role)) {
    throw new WorkflowError('FORBIDDEN', '当前角色无权变更 Kill Switch');
  }
  if (phase === 'confirm' && !canConfirmKillSwitch(actor.role)) {
    throw new WorkflowError('FORBIDDEN', '当前角色无权确认 Kill Switch 变更');
  }

  const emergency = reasonCode === 'SECURITY_INCIDENT';

  const run = async (tx: Prisma.TransactionClient): Promise<KillSwitchChangeResult> => {
    // 0) 幂等：先看同键（唯一约束兜底并发）
    const existing = await tx.killSwitchRequest.findFirst({
      where: { organizationId: actor.organizationId, idempotencyKey },
    });
    if (existing) {
      return replayResult(
        scope,
        existing.target as KillSwitchTargetValue,
        existing.state as KillSwitchRequestStateValue,
        existing.id,
        existing.confirmedBy,
        existing.expiresAt,
      );
    }

    const currentValue = resolveKillSwitch(deps.config, scope, actor.organizationId).value;

    if (phase === 'request' && target === 'DISABLED') {
      // 取消同 scope 的 pending enable（审计逐条留痕）
      const pendingRows = await tx.killSwitchRequest.findMany({
        where: { organizationId: actor.organizationId, scope, state: 'PENDING_ENABLE' },
        select: { id: true, reasonCode: true, requestedBy: true },
      });
      const row = await tx.killSwitchRequest.create({
        data: {
          organizationId: actor.organizationId,
          scope,
          target: 'DISABLED',
          state: 'APPLIED',
          reasonCode,
          ...(note !== undefined ? { note } : {}),
          requestedBy: actor.actorUserId,
          requestedAt: now,
          // 无确认窗口：disabled 立即生效（expiresAt 仍必填，取同一时刻）
          expiresAt: now,
          appliedAt: now,
          idempotencyKey,
        },
      });
      await tx.killSwitchRequest.updateMany({
        where: { organizationId: actor.organizationId, scope, state: 'PENDING_ENABLE' },
        data: { state: 'CANCELLED' },
      });
      for (const pending of pendingRows) {
        await writeKillSwitchAudit(
          tx,
          { organizationId: actor.organizationId, actorUserId: actor.actorUserId, actorType: 'USER' },
          {
            scope,
            oldValue: 'disabled',
            newValue: 'disabled',
            reasonCode,
            phase: 'cancel',
            target: 'ENABLED',
            requestId: pending.id,
            state: 'CANCELLED',
            cancelledBy: row.id,
            cancelledByUserId: actor.actorUserId,
            occurredAt: now.toISOString(),
          },
        );
      }
      await writeKillSwitchAudit(
        tx,
        { organizationId: actor.organizationId, actorUserId: actor.actorUserId, actorType: 'USER' },
        {
          scope,
          oldValue: currentValue,
          newValue: 'disabled',
          reasonCode,
          ...(note !== undefined ? { note } : {}),
          phase: 'request',
          target: 'DISABLED',
          requestId: row.id,
          state: 'APPLIED',
          ...(emergency ? { emergency: true } : {}),
          ...(pendingRows.length > 0 ? { cancelledPendingRequestIds: pendingRows.map((p) => p.id) } : {}),
          idempotencyKeyHash: hashIdempotencyKey(actor.organizationId, idempotencyKey),
          actorUserId: actor.actorUserId,
          occurredAt: now.toISOString(),
        },
      );
      return {
        status: 'applied',
        scope,
        value: 'disabled',
        requestId: row.id,
        state: 'APPLIED',
        replayed: false,
        confirmationBy: null,
        expiresAt: row.expiresAt.toISOString(),
      };
    }

    if (phase === 'request' && target === 'ENABLED') {
      if (currentValue === 'enabled') {
        throw new WorkflowError('ILLEGAL_TRANSITION', '该 scope 已处于 enabled，无需申请');
      }
      const expiresAt = new Date(now.getTime() + KILL_SWITCH_CONFIRM_WINDOW_MS);
      const row = await tx.killSwitchRequest.create({
        data: {
          organizationId: actor.organizationId,
          scope,
          target: 'ENABLED',
          state: 'PENDING_ENABLE',
          reasonCode,
          ...(note !== undefined ? { note } : {}),
          requestedBy: actor.actorUserId,
          requestedAt: now,
          expiresAt,
          idempotencyKey,
        },
      });
      await writeKillSwitchAudit(
        tx,
        { organizationId: actor.organizationId, actorUserId: actor.actorUserId, actorType: 'USER' },
        {
          scope,
          oldValue: currentValue,
          newValue: currentValue,
          reasonCode,
          ...(note !== undefined ? { note } : {}),
          phase: 'request',
          target: 'ENABLED',
          requestId: row.id,
          state: 'PENDING_ENABLE',
          expiresAt: expiresAt.toISOString(),
          ...(emergency ? { emergency: true } : {}),
          idempotencyKeyHash: hashIdempotencyKey(actor.organizationId, idempotencyKey),
          actorUserId: actor.actorUserId,
          occurredAt: now.toISOString(),
        },
      );
      return {
        status: 'awaiting_confirmation',
        scope,
        value: currentValue,
        requestId: row.id,
        state: 'PENDING_ENABLE',
        replayed: false,
        confirmationBy: null,
        expiresAt: expiresAt.toISOString(),
      };
    }

    // phase=confirm + target=ENABLED
    const requestRow = await tx.killSwitchRequest.findFirst({
      where: { id: requestId, organizationId: actor.organizationId, scope },
      select: {
        id: true,
        target: true,
        state: true,
        requestedBy: true,
        reasonCode: true,
        note: true,
        expiresAt: true,
        confirmedBy: true,
      },
    });
    if (!requestRow) throw new WorkflowError('NOT_FOUND', '待确认申请不存在');
    if (requestRow.target !== 'ENABLED') {
      throw new WorkflowError('INVALID_INPUT', '该申请不是 enabled 申请');
    }
    if (requestRow.state === 'EXPIRED') {
      throw new WorkflowError('ILLEGAL_TRANSITION', '申请已过期，请重新发起');
    }
    if (requestRow.state === 'CANCELLED') {
      throw new WorkflowError('ILLEGAL_TRANSITION', '申请已被取消，请重新发起');
    }
    if (requestRow.state === 'APPLIED') {
      // 确认的幂等重试：返回首次结果，不写第二条审计
      return {
        status: 'applied',
        scope,
        value: 'enabled',
        requestId: requestRow.id,
        state: 'APPLIED',
        replayed: true,
        confirmationBy: requestRow.confirmedBy ?? null,
        expiresAt: requestRow.expiresAt.toISOString(),
      };
    }
    // 服务端强制双人确认（禁止同一 actor 闭环）
    if (requestRow.requestedBy === actor.actorUserId) {
      throw new WorkflowError('FORBIDDEN', '同一用户不得完成双人确认闭环');
    }
    if (requestRow.expiresAt.getTime() <= now.getTime()) {
      throw new WorkflowError('ILLEGAL_TRANSITION', '申请已过期，请重新发起');
    }
    if (requestRow.state !== 'PENDING_ENABLE') {
      throw new WorkflowError('ILLEGAL_TRANSITION', `申请已处于 ${requestRow.state}`);
    }

    // CAS：只有 state 仍为 PENDING_ENABLE 且未过期时才收口
    const cas = await tx.killSwitchRequest.updateMany({
      where: {
        id: requestRow.id,
        organizationId: actor.organizationId,
        state: 'PENDING_ENABLE',
        expiresAt: { gt: now },
      },
      data: { state: 'APPLIED', confirmedBy: actor.actorUserId, confirmedAt: now, appliedAt: now },
    });
    if (cas.count === 0) {
      throw new WorkflowError('ILLEGAL_TRANSITION', '并发状态下申请已被其他操作收口');
    }
    await writeKillSwitchAudit(
      tx,
      { organizationId: actor.organizationId, actorUserId: actor.actorUserId, actorType: 'USER' },
      {
        scope,
        oldValue: 'disabled',
        newValue: 'enabled',
        reasonCode: requestRow.reasonCode,
        ...(requestRow.note ? { note: requestRow.note } : {}),
        phase: 'confirm',
        target: 'ENABLED',
        requestId: requestRow.id,
        state: 'APPLIED',
        confirmationBy: actor.actorUserId,
        requestedBy: requestRow.requestedBy,
        ...(emergency ? { emergency: true } : {}),
        idempotencyKeyHash: hashIdempotencyKey(actor.organizationId, idempotencyKey),
        actorUserId: actor.actorUserId,
        occurredAt: now.toISOString(),
      },
    );
    return {
      status: 'applied',
      scope,
      value: 'enabled',
      requestId: requestRow.id,
      state: 'APPLIED',
      replayed: false,
      confirmationBy: actor.actorUserId,
      expiresAt: requestRow.expiresAt.toISOString(),
    };
  };

  try {
    // 惰性收口过期申请：独立事务（CAS 保证并发安全），避免随本次变更一起回滚
    await expirePendingKillSwitchRequests(deps.prisma, {
      organizationId: actor.organizationId,
      scope,
      now,
    });
    return await deps.prisma.$transaction(run);
  } catch (error) {
    // 并发同键：唯一约束兜底 → 读既有记录返回首次结果
    if (isUniqueViolation(error)) {
      const existing = await deps.prisma.killSwitchRequest.findFirst({
        where: { organizationId: actor.organizationId, idempotencyKey },
      });
      if (existing) {
        return replayResult(
          scope,
          existing.target as KillSwitchTargetValue,
          existing.state as KillSwitchRequestStateValue,
          existing.id,
          existing.confirmedBy,
          existing.expiresAt,
        );
      }
      // 同 scope 第二个 pending（部分唯一索引）
      throw new WorkflowError('ILLEGAL_TRANSITION', '该 scope 已存在未完成的开启申请');
    }
    throw error;
  }
}

function replayResult(
  scope: KillSwitchScope,
  target: KillSwitchTargetValue,
  state: KillSwitchRequestStateValue,
  requestId: string,
  confirmedBy: string | null,
  expiresAt: Date,
): KillSwitchChangeResult {
  return {
    status: state === 'APPLIED' ? 'applied' : 'awaiting_confirmation',
    scope,
    value: target === 'DISABLED' ? 'disabled' : state === 'APPLIED' ? 'enabled' : 'disabled',
    requestId,
    state,
    replayed: true,
    confirmationBy: confirmedBy ?? null,
    expiresAt: expiresAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
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
