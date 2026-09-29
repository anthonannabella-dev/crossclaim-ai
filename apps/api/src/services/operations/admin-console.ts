/**
 * ADMIN CONSOLE — Phase 1 只读投影（MSG-20260929-34 = GO_WITH_PHASED_IMPLEMENTATION）
 * ---------------------------------------------------------------
 * Phase 1 仅三个模块（A1 租户概览 / A3 审计浏览器 / A6 系统健康）。
 *
 * 硬约束（MSG-20260929-34）：
 *   · Admin = 运营可观测层，**不是**超级管理员后台：无权限编辑、无平台配置、无 API Key、无资金操作
 *   · 只读：本模块不含 create/update/delete；读取不写 AuditLog
 *   · 单租户视图：所有查询强制 `organizationId`；不提供跨租户查询
 *   · A1 不得展示 token / secret / 原始连接配置（只露状态与类型）
 *   · A3 列表**只返回元数据**（action/entityType/entityId/createdAt/actor/severity），
 *     `changes` 只在独立详情端点返回（遵守既有脱敏结果，不额外还原原文）
 *   · A6 复用既有健康语义，失败时**不得**泄露 SQL 错误 / 连接串 / 内部堆栈
 */

import type { PrismaClient } from '@prisma/client';

import { WorkflowError } from '../workflow/opportunity-review';
import { permissionsFor } from '../workflow/permissions';

// ---------------------------------------------------------------- 访问控制（D1 角色分层）

export const ADMIN_MODULES = [
  'tenantOverview',
  'auditExplorer',
  'importValidation',
  'recoveryReview',
  'userMembership',
  'systemHealth',
] as const;
export type AdminModule = (typeof ADMIN_MODULES)[number];

/**
 * D1 裁决是**角色分层表**（不是新增权限键）：
 *   A1/A3 = OWNER/ADMIN；A6 = OWNER/ADMIN/OPS。
 * 未知角色一律 fail-closed。
 */
export const ADMIN_MODULE_ROLES: Record<AdminModule, readonly string[]> = {
  tenantOverview: ['OWNER', 'ADMIN'],
  auditExplorer: ['OWNER', 'ADMIN'],
  importValidation: ['OWNER', 'ADMIN', 'OPS'],
  recoveryReview: ['OWNER', 'ADMIN'],
  userMembership: ['OWNER', 'ADMIN'],
  systemHealth: ['OWNER', 'ADMIN', 'OPS'],
};

export function canAccessAdminModule(role: string | null | undefined, module: AdminModule): boolean {
  const value = typeof role === 'string' ? role : '';
  return ADMIN_MODULE_ROLES[module].includes(value);
}

export function assertAdminAccess(role: string | null | undefined, module: AdminModule): void {
  if (!canAccessAdminModule(role, module)) {
    throw new WorkflowError('FORBIDDEN', `当前角色无权访问 Admin 模块（${module}）`);
  }
}

// ---------------------------------------------------------------- 游标与分页（与看板同口径）

export const ADMIN_DEFAULT_PAGE_SIZE = 25;
export const ADMIN_MAX_PAGE_SIZE = 100;
export const ADMIN_AUDIT_WINDOW_MAX_DAYS = 30;

export function encodeAdminCursor(sortValue: number, id: string): string {
  return Buffer.from(`${sortValue}|${id}`, 'utf8').toString('base64url');
}

export function decodeAdminCursor(raw: unknown): { sortValue: number; id: string } | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const decoded = Buffer.from(raw.trim(), 'base64url').toString('utf8');
    const index = decoded.lastIndexOf('|');
    if (index <= 0) throw new Error('malformed');
    const sortValue = Number(decoded.slice(0, index));
    const id = decoded.slice(index + 1);
    if (!Number.isFinite(sortValue) || id === '') throw new Error('malformed');
    return { sortValue, id };
  } catch {
    throw new WorkflowError('INVALID_INPUT', 'cursor 非法');
  }
}

export function normalizeAdminPageSize(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return ADMIN_DEFAULT_PAGE_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new WorkflowError('INVALID_INPUT', 'limit 必须是正整数');
  }
  return Math.min(value, ADMIN_MAX_PAGE_SIZE);
}

/** 审计检索窗口：默认 7 天，上限 30 天（与看板 window 同思路，避免大扫描） */
export function resolveAuditWindow(input: { from?: unknown; to?: unknown }, now: Date): { from: Date; to: Date } {
  const to = input.to === undefined || input.to === null || input.to === '' ? now : new Date(String(input.to));
  if (Number.isNaN(to.getTime())) throw new WorkflowError('INVALID_INPUT', 'to 不是合法时间');
  const from =
    input.from === undefined || input.from === null || input.from === ''
      ? new Date(to.getTime() - 7 * 86_400_000)
      : new Date(String(input.from));
  if (Number.isNaN(from.getTime())) throw new WorkflowError('INVALID_INPUT', 'from 不是合法时间');
  if (from.getTime() > to.getTime()) throw new WorkflowError('INVALID_INPUT', 'from 必须早于 to');
  if (to.getTime() - from.getTime() > ADMIN_AUDIT_WINDOW_MAX_DAYS * 86_400_000) {
    throw new WorkflowError('INVALID_WINDOW', `审计检索窗口不得超过 ${ADMIN_AUDIT_WINDOW_MAX_DAYS} 天`);
  }
  return { from, to };
}

// ---------------------------------------------------------------- A1 租户概览

export interface TenantOverview {
  generatedAt: string;
  members: { active: number; total: number };
  sessions: { total: number };
  connections: Array<{ status: string; count: number }>;
  imports: { total: number };
  claims: Array<{ status: string; count: number }>;
  settlements: { total: number };
  audit: { entries: number; lastActivityAt: string | null };
}

// ---------------------------------------------------------------- A3 审计浏览器

export interface AuditListEntry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actorType: string;
  actorUserId: string | null;
  actorRef: string | null;
  severity: 'INFO' | 'WARN';
  createdAt: string;
}

export interface AuditDetail extends AuditListEntry {
  /** 详情端点独有；写入时已脱敏，不在读取侧还原原文 */
  changes: Record<string, unknown> | null;
}

export interface AuditListFilter {
  action?: unknown;
  actorUserId?: unknown;
  entityType?: unknown;
  entityId?: unknown;
  from?: unknown;
  to?: unknown;
  cursor?: unknown;
  limit?: unknown;
}

// ---------------------------------------------------------------- 读侧

export interface AdminConsoleDeps {
  prisma: PrismaClient;
  now?: () => Date;
}

/** 危险动作在列表里以 WARN 呈现，便于审计聚焦（不改变事实，只做标注） */
const WARN_ACTIONS = [
  'auth.login_failed',
  'file.upload_failed',
  'import.failed',
  'sync_run.failed',
  'payment.processing_failed',
  'payment.reconciliation_failed',
  'evidence.promotion_failed',
  'connector.pull_failed',
];

export function severityForAction(action: string): 'INFO' | 'WARN' {
  return WARN_ACTIONS.includes(action) ? 'WARN' : 'INFO';
}

export async function getTenantOverview(
  deps: AdminConsoleDeps,
  input: { organizationId: string; role: string | null | undefined },
): Promise<TenantOverview> {
  assertAdminAccess(input.role, 'tenantOverview');
  const at = (deps.now ?? (() => new Date()))();
  const organizationId = input.organizationId;

  const [membersTotal, membersActive, sessions, connections, imports, claims, settlements, audits, lastAudit] =
    await Promise.all([
      deps.prisma.membership.count({ where: { organizationId } }),
      deps.prisma.membership.count({ where: { organizationId, isActive: true } }),
      deps.prisma.session.count({ where: { organizationId } }),
      deps.prisma.sourceConnection.groupBy({
        by: ['status'],
        where: { organizationId },
        _count: { _all: true },
      }),
      deps.prisma.importBatch.count({ where: { organizationId } }),
      deps.prisma.claim.groupBy({ by: ['status'], where: { organizationId }, _count: { _all: true } }),
      deps.prisma.settlement.count({ where: { organizationId } }),
      deps.prisma.auditLog.count({ where: { organizationId } }),
      deps.prisma.auditLog.findFirst({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

  return {
    generatedAt: at.toISOString(),
    members: { active: membersActive, total: membersTotal },
    sessions: { total: sessions },
    // 只露状态与计数：绝不返回 token / secret / 原始连接配置
    connections: connections.map((row) => ({ status: row.status, count: row._count._all })),
    imports: { total: imports },
    claims: claims.map((row) => ({ status: row.status, count: row._count._all })),
    settlements: { total: settlements },
    audit: { entries: audits, lastActivityAt: lastAudit?.createdAt.toISOString() ?? null },
  };
}

/** A3 列表：只返回元数据；`changes` 不得出现在列表里（MSG-20260929-34 D3） */
export async function listAuditEntries(
  deps: AdminConsoleDeps,
  input: { organizationId: string; role: string | null | undefined; filter?: AuditListFilter },
): Promise<{ items: AuditListEntry[]; nextCursor: string | null; window: { from: string; to: string } }> {
  assertAdminAccess(input.role, 'auditExplorer');
  const at = (deps.now ?? (() => new Date()))();
  const filter = input.filter ?? {};
  const window = resolveAuditWindow(filter, at);
  const limit = normalizeAdminPageSize(filter.limit);
  const cursor = decodeAdminCursor(filter.cursor);

  const where: Record<string, unknown> = {
    organizationId: input.organizationId, // 强制租户注入：actorUserId 过滤也不得跨租户
    createdAt: { gte: window.from, lte: window.to },
  };
  if (typeof filter.action === 'string' && filter.action !== '') where.action = filter.action;
  if (typeof filter.actorUserId === 'string' && filter.actorUserId !== '') where.actorUserId = filter.actorUserId;
  if (typeof filter.entityType === 'string' && filter.entityType !== '') where.entityType = filter.entityType;
  if (typeof filter.entityId === 'string' && filter.entityId !== '') where.entityId = filter.entityId;
  if (cursor) {
    where.OR = [
      { createdAt: { lt: new Date(cursor.sortValue) } },
      { createdAt: new Date(cursor.sortValue), id: { lt: cursor.id } },
    ];
  }

  const rows = await deps.prisma.auditLog.findMany({
    where: where as never,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      actorType: true,
      actorUserId: true,
      actorRef: true,
      createdAt: true,
    },
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  return {
    items: page.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      actorRef: row.actorRef,
      severity: severityForAction(row.action),
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: rows.length > limit && last ? encodeAdminCursor(last.createdAt.getTime(), last.id) : null,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
  };
}

/** A3 详情：独立端点；changes 为写入时已脱敏的结果 */
export async function getAuditEntry(
  deps: AdminConsoleDeps,
  input: { organizationId: string; role: string | null | undefined; auditId: string },
): Promise<AuditDetail> {
  assertAdminAccess(input.role, 'auditExplorer');
  const row = await deps.prisma.auditLog.findFirst({
    where: { id: input.auditId, organizationId: input.organizationId },
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      actorType: true,
      actorUserId: true,
      actorRef: true,
      createdAt: true,
      changes: true,
    },
  });
  if (!row) throw new WorkflowError('NOT_FOUND', '审计记录不存在或不属于该租户');
  return {
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actorType: row.actorType,
    actorUserId: row.actorUserId,
    actorRef: row.actorRef,
    severity: severityForAction(row.action),
    createdAt: row.createdAt.toISOString(),
    changes: (row.changes ?? null) as Record<string, unknown> | null,
  };
}

// ---------------------------------------------------------------- A6 系统健康

export interface AdminSystemHealth {
  status: 'ok' | 'degraded';
  checkedAt: string;
  checks: {
    database: { ok: boolean };
    /** 失败原因只暴露稳定代码，绝不含 SQL 错误 / 连接串 / 堆栈 */
    auditReadModel: { ok: boolean };
  };
}

/**
 * 复用既有健康语义：只做最小连通性检查，失败一律折叠为 `{ ok: false }`。
 * 明确不返回：SQL 错误消息、连接串、堆栈、驱动版本等内部细节。
 */
export async function getAdminSystemHealth(
  deps: AdminConsoleDeps,
  input: { organizationId: string; role: string | null | undefined },
): Promise<AdminSystemHealth> {
  assertAdminAccess(input.role, 'systemHealth');
  const at = (deps.now ?? (() => new Date()))();

  const database = await deps.prisma
    .$queryRaw`SELECT 1 AS ok`
    .then(() => ({ ok: true }))
    .catch(() => ({ ok: false }));

  const auditReadModel = await deps.prisma.auditLog
    .count({ where: { organizationId: input.organizationId } })
    .then(() => ({ ok: true }))
    .catch(() => ({ ok: false }));

  return {
    status: database.ok && auditReadModel.ok ? 'ok' : 'degraded',
    checkedAt: at.toISOString(),
    checks: { database, auditReadModel },
  };
}

/** 供测试与审计使用的可见性快照（角色 → 可访问模块），不含任何业务数据 */
export function adminVisibilityFor(role: string | null | undefined): Record<AdminModule, boolean> {
  return Object.fromEntries(
    ADMIN_MODULES.map((module) => [module, canAccessAdminModule(role, module)]),
  ) as Record<AdminModule, boolean>;
}

/** 供权限矩阵一致性断言：VIEWER 在既有矩阵中必须全 false（fail-closed 的底层依据） */
export function viewerIsFailClosed(): boolean {
  const permissions = permissionsFor('VIEWER');
  return Object.values(permissions).every((value) => value === false);
}
