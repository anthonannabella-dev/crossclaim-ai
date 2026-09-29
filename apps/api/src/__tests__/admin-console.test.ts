// MSG-20260929-34 验收（离线部分）：Admin Phase 1 的角色分层、游标、审计窗口、健康降级不泄露。

import { describe, expect, it } from 'vitest';

import {
  ADMIN_MODULES,
  adminVisibilityFor,
  assertAdminAccess,
  canAccessAdminModule,
  decodeAdminCursor,
  encodeAdminCursor,
  getAdminSystemHealth,
  normalizeAdminPageSize,
  resolveAuditWindow,
  severityForAction,
  viewerIsFailClosed,
} from '../services/operations/admin-console';
import { WorkflowError } from '../services/workflow/opportunity-review';

const NOW = new Date('2026-09-29T10:00:00Z');

describe('MSG-34 · D1 角色分层（最小权限）', () => {
  it('01 OWNER/ADMIN 可访问三个模块', () => {
    for (const role of ['OWNER', 'ADMIN']) {
      for (const module of ADMIN_MODULES) expect(canAccessAdminModule(role, module), `${role}:${module}`).toBe(true);
    }
  });

  it('02 OPS 仅可访问 System Health', () => {
    expect(canAccessAdminModule('OPS', 'systemHealth')).toBe(true);
    expect(canAccessAdminModule('OPS', 'tenantOverview')).toBe(false);
    expect(canAccessAdminModule('OPS', 'auditExplorer')).toBe(false);
  });

  it('03 FINANCE / VIEWER / 未知角色 fail-closed', () => {
    for (const role of ['FINANCE', 'VIEWER', 'SUPERADMIN', '', null, undefined]) {
      for (const module of ADMIN_MODULES) {
        expect(canAccessAdminModule(role as never, module), `${String(role)}:${module}`).toBe(false);
      }
    }
  });

  it('04 越权抛 FORBIDDEN；可见性快照形状正确', () => {
    try {
      assertAdminAccess('VIEWER', 'auditExplorer');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as WorkflowError).code).toBe('FORBIDDEN');
    }
    expect(Object.keys(adminVisibilityFor('OWNER'))).toEqual([...ADMIN_MODULES]);
    expect(adminVisibilityFor('OPS')).toEqual({
      tenantOverview: false,
      auditExplorer: false,
      importValidation: true,
      recoveryReview: false,
      userMembership: false,
      systemHealth: true,
    });
  });
});

describe('MSG-34 · A3 审计浏览器的元数据与窗口', () => {
  it('05 列表元数据：高危动作标 WARN，其余 INFO', () => {
    expect(severityForAction('auth.login_failed')).toBe('WARN');
    expect(severityForAction('import.failed')).toBe('WARN');
    expect(severityForAction('claim.submitted_by_human')).toBe('INFO');
  });

  it('06 分页：默认 25、上限 100、非法 limit 拒绝', () => {
    expect(normalizeAdminPageSize(undefined)).toBe(25);
    expect(normalizeAdminPageSize('500')).toBe(100);
    expect(() => normalizeAdminPageSize('0')).toThrowError(/limit/);
    expect(() => normalizeAdminPageSize('abc')).toThrowError(/limit/);
  });

  it('07 游标：可逆、非法值拒绝', () => {
    const cursor = encodeAdminCursor(1759138800000, 'a-1');
    expect(decodeAdminCursor(cursor)).toEqual({ sortValue: 1759138800000, id: 'a-1' });
    expect(decodeAdminCursor(undefined)).toBeNull();
    expect(() => decodeAdminCursor('!!!')).toThrowError(/cursor/);
  });

  it('08 审计窗口：默认 7 天、上限 30 天、逆序拒绝', () => {
    const window = resolveAuditWindow({}, NOW);
    expect(window.from.toISOString()).toBe('2026-09-22T10:00:00.000Z');
    expect(window.to.toISOString()).toBe(NOW.toISOString());

    try {
      resolveAuditWindow({ from: '2026-01-01T00:00:00Z', to: NOW.toISOString() }, NOW);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as WorkflowError).code).toBe('INVALID_WINDOW');
    }
    expect(() => resolveAuditWindow({ from: '2026-09-29T11:00:00Z', to: NOW.toISOString() }, NOW)).toThrowError(
      /from/,
    );
  });
});

describe('MSG-34 · A6 健康降级不得泄露内部细节', () => {
  const deps = (overrides: Record<string, unknown>) =>
    ({
      prisma: overrides,
      now: () => NOW,
    }) as never;

  it('09 数据库异常 → degraded，且响应中不含 SQL 错误 / 连接串 / 堆栈', async () => {
    const failing = {
      $queryRaw: () => Promise.reject(new Error('connect ECONNREFUSED postgresql://user:pass@db:5432/crossclaim')),
      auditLog: { count: () => Promise.resolve(3) },
    };
    const health = await getAdminSystemHealth(deps(failing), {
      organizationId: 'b9000000-0000-4000-8000-000000000001',
      role: 'OWNER',
    });
    expect(health.status).toBe('degraded');
    expect(health.checks.database.ok).toBe(false);
    expect(health.checks.auditReadModel.ok).toBe(true);
    const text = JSON.stringify(health);
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('postgresql://');
    expect(text).not.toContain('at ');
  });

  it('10 两个检查都失败 → degraded（不抛异常）', async () => {
    const failing = {
      $queryRaw: () => Promise.reject(new Error('down')),
      auditLog: { count: () => Promise.reject(new Error('down')) },
    };
    const health = await getAdminSystemHealth(deps(failing), {
      organizationId: 'b9000000-0000-4000-8000-000000000001',
      role: 'OPS',
    });
    expect(health).toMatchObject({ status: 'degraded', checks: { database: { ok: false }, auditReadModel: { ok: false } } });
  });

  it('11 VIEWER 无权访问健康端点', async () => {
    await expect(
      getAdminSystemHealth(deps({}), {
        organizationId: 'b9000000-0000-4000-8000-000000000001',
        role: 'VIEWER',
      }),
    ).rejects.toThrowError(/无权/);
  });

  it('12 既有权限矩阵的 VIEWER 仍为 fail-closed（角色分层底层依据）', () => {
    expect(viewerIsFailClosed()).toBe(true);
  });
});
