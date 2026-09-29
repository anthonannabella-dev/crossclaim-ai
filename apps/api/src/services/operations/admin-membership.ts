/**
 * ADMIN — User / Membership View（Admin Phase 4 / A2）
 * ---------------------------------------------------------------
 * 依据：ADMIN-USER-MEMBERSHIP-DESIGN.md（R1）+ MSG-20260929-39。
 * 身份治理的**只读视图**：Admin v1 **无任何写路径**
 *   （禁止 invite / updateRole / deactivate / delete / revokeSession / resetPassword）。
 *
 * 裁决口径：
 *   · D1 邮箱**默认掩码**（不返回完整邮箱，也不提供解掩码入口）
 *   · D2 会话仅计数与状态分布（无单条会话、无 IP/UA/tokenHash）
 *   · D3 邀请仅 status / expiresAt / attemptCount（无 tokenHash、无邀请链接）
 *   · D4 仅允许 `locked` 布尔（不给失败次数、锁定原因或解锁入口）
 *   · D5 权限矩阵只读（来源 permissionsFor 代码常量）
 */

import type { PrismaClient } from '@prisma/client';

import { WorkflowError } from '../workflow/opportunity-review';
import { APP_ROLES, permissionsFor, type PermissionMatrix } from '../workflow/permissions';
import { assertAdminAccess, decodeAdminCursor, encodeAdminCursor, ADMIN_DEFAULT_PAGE_SIZE, ADMIN_MAX_PAGE_SIZE } from './admin-console';

/** D1：邮箱默认掩码（保留首字符与域名，其余打码） */
export function maskEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null;
  const value = email.trim();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

const PERMANENT_FORBIDDEN_KEYS = [
  'passwordHash',
  'tokenHash',
  'inviteToken',
  'secret',
  'credential',
  'storageKey',
  'ip',
  'userAgent',
  'failedLogins',
  'lockedUntil',
  'amount',
  'currency',
] as const;

/** 治理动作一律不存在（实现期扫描用） */
export const FORBIDDEN_WRITE_PATTERNS = [
  'invite',
  'updateRole',
  'deactivate',
  'delete',
  'revokeSession',
  'resetPassword',
] as const;

export interface AdminMemberDeps {
  prisma: PrismaClient;
  now?: () => Date;
}

export interface MemberListItem {
  userId: string;
  displayName: string;
  /** D1：掩码形式；不提供完整邮箱 */
  emailMasked: string | null;
  role: string;
  isActive: boolean;
  status: string;
  /** D4：仅布尔 */
  locked: boolean;
  lastLoginAt: string | null;
}

export interface MemberDetail extends MemberListItem {
  sessions: { total: number; active: number; expired: number };
  invitations: Array<{ status: string; expiresAt: string | null; attemptCount: number }>;
}

function normalizeLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return ADMIN_DEFAULT_PAGE_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new WorkflowError('INVALID_INPUT', 'limit 必须是正整数');
  return Math.min(value, ADMIN_MAX_PAGE_SIZE);
}

export async function listMembers(
  deps: AdminMemberDeps,
  input: { organizationId: string; role: string | null | undefined; filter?: { cursor?: unknown; limit?: unknown } },
): Promise<{ items: MemberListItem[]; nextCursor: string | null }> {
  assertAdminAccess(input.role, 'userMembership');
  const filter = input.filter ?? {};
  const limit = normalizeLimit(filter.limit);
  const cursor = decodeAdminCursor(filter.cursor);

  const where: Record<string, unknown> = { organizationId: input.organizationId };
  if (cursor) {
    where.OR = [
      { joinedAt: { lt: new Date(cursor.sortValue) } },
      { joinedAt: new Date(cursor.sortValue), id: { lt: cursor.id } },
    ];
  }

  const rows = await deps.prisma.membership.findMany({
    where: where as never,
    orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: { id: true, joinedAt: true, role: true, isActive: true, userId: true },
  });
  const page = rows.slice(0, limit);
  const users = await deps.prisma.user.findMany({
    where: { id: { in: page.map((row) => row.userId) } },
    select: { id: true, displayName: true, email: true, status: true, lastLoginAt: true, lockedUntil: true },
  });
  const userById = new Map(users.map((row) => [row.id, row] as const));
  const last = page[page.length - 1];
  return {
    items: page.flatMap((row) => {
      const user = userById.get(row.userId);
      if (!user) return [];
      return [
        {
          userId: user.id,
          displayName: user.displayName,
          emailMasked: maskEmail(user.email),
          role: row.role,
          isActive: row.isActive,
          status: user.status,
          locked: user.lockedUntil !== null,
          lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
        } satisfies MemberListItem,
      ];
    }),
    nextCursor: rows.length > limit && last ? encodeAdminCursor(last.joinedAt.getTime(), last.id) : null,
  };
}

export async function getMember(
  deps: AdminMemberDeps,
  input: { organizationId: string; role: string | null | undefined; userId: string },
): Promise<MemberDetail> {
  assertAdminAccess(input.role, 'userMembership');
  const at = (deps.now ?? (() => new Date()))();
  const membership = await deps.prisma.membership.findFirst({
    where: { organizationId: input.organizationId, userId: input.userId },
    select: { role: true, isActive: true, userId: true },
  });
  if (!membership) throw new WorkflowError('NOT_FOUND', '成员不存在或不属于该租户');
  const user = await deps.prisma.user.findFirst({
    where: { id: membership.userId },
    select: { id: true, displayName: true, email: true, status: true, lastLoginAt: true, lockedUntil: true },
  });
  if (!user) throw new WorkflowError('NOT_FOUND', '成员不存在或不属于该租户');

  const [sessions, invitations] = await Promise.all([
    deps.prisma.session.findMany({
      where: { organizationId: input.organizationId, userId: input.userId },
      select: { expiresAt: true },
    }),
    deps.prisma.userInvitation.findMany({
      where: { organizationId: input.organizationId, email: user.email },
      orderBy: { expiresAt: 'desc' },
      take: 10,
      select: { expiresAt: true, attemptCount: true, acceptedAt: true, revokedAt: true },
    }),
  ]);

  const active = sessions.filter((row) => row.expiresAt.getTime() > at.getTime()).length;
  return {
    userId: user.id,
    displayName: user.displayName,
    emailMasked: maskEmail(user.email),
    role: membership.role,
    isActive: membership.isActive,
    status: user.status,
    locked: user.lockedUntil !== null,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    sessions: { total: sessions.length, active, expired: sessions.length - active },
    // D3：只暴露状态/到期/尝试次数（状态由既有 acceptedAt / revokedAt / expiresAt 事实推导，非新增状态机）
    invitations: invitations.map((row) => ({
      status:
        row.acceptedAt !== null
          ? 'ACCEPTED'
          : row.revokedAt !== null
            ? 'REVOKED'
            : row.expiresAt.getTime() <= at.getTime()
              ? 'EXPIRED'
              : 'PENDING',
      expiresAt: row.expiresAt.toISOString(),
      attemptCount: row.attemptCount,
    })),
  };
}

export interface PermissionMatrixView {
  /** 只读标记：矩阵来自代码常量，Admin 不可编辑 */
  readonly: true;
  roles: string[];
  permissions: string[];
  matrix: Record<string, Record<string, boolean>>;
}

export function getPermissionMatrix(): PermissionMatrixView {
  const roles = [...APP_ROLES];
  const sample: PermissionMatrix = permissionsFor('OWNER');
  const permissions = Object.keys(sample);
  const matrix: Record<string, Record<string, boolean>> = {};
  for (const role of roles) {
    const row = permissionsFor(role);
    matrix[role] = Object.fromEntries(permissions.map((key) => [key, row[key as keyof PermissionMatrix]]));
  }
  return { readonly: true, roles, permissions, matrix };
}

export { PERMANENT_FORBIDDEN_KEYS };
