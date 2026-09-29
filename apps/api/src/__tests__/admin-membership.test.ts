// MSG-20260929-39 验收（离线）：邮箱掩码、禁键、无写路径、权限矩阵只读、角色分层。

import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_WRITE_PATTERNS,
  PERMANENT_FORBIDDEN_KEYS,
  getPermissionMatrix,
  maskEmail,
} from '../services/operations/admin-membership';
import { canAccessAdminModule } from '../services/operations/admin-console';

describe('MSG-39 · D1 邮箱默认掩码', () => {
  it('01 掩码：保留首字符与域名，不泄露完整本地名', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
    expect(maskEmail('bob.smith@corp.co.jp')).toBe('b***@corp.co.jp');
  });

  it('02 非法输入安全返回（不抛、不泄露）', () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail(undefined)).toBeNull();
    expect(maskEmail('no-at-sign')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
    expect(maskEmail('trailing@')).toBe('***');
  });

  it('03 掩码结果不含完整邮箱（断言用不含 @ 前的完整本地名）', () => {
    const masked = maskEmail('alice@example.com');
    expect(masked).not.toBe('alice@example.com');
    expect(masked).not.toContain('alice@');
  });
});

describe('MSG-39 · 禁键与无写路径', () => {
  it('04 永久禁键包含凭据、会话指纹、失败次数与锁定时间（D4 仅布尔）', () => {
    expect([...PERMANENT_FORBIDDEN_KEYS]).toEqual(
      expect.arrayContaining(['passwordHash', 'tokenHash', 'inviteToken', 'ip', 'userAgent', 'failedLogins', 'lockedUntil']),
    );
  });

  it('05 模块不导出任何治理写函数（invite/updateRole/deactivate/delete/revokeSession/resetPassword）', async () => {
    const module = await import('../services/operations/admin-membership');
    const exported = Object.keys(module).map((name) => name.toLowerCase());
    for (const pattern of FORBIDDEN_WRITE_PATTERNS) {
      const offenders = exported.filter((name) => name.includes(pattern.toLowerCase()));
      expect(offenders, `${pattern}: ${offenders.join(',')}`).toEqual([]);
    }
  });
});

describe('MSG-39 · D5 权限矩阵只读', () => {
  it('06 矩阵只读标记 + 角色/权限键齐全', () => {
    const view = getPermissionMatrix();
    expect(view.readonly).toBe(true);
    expect(view.roles).toEqual(['OWNER', 'ADMIN', 'OPS', 'FINANCE', 'VIEWER']);
    expect(view.permissions).toContain('claimTrackingApprove');
    expect(view.permissions).toContain('recoveryPayoutRecord');
    expect(view.matrix.OWNER?.claimTrackingApprove).toBe(true);
    expect(view.matrix.VIEWER?.claimTrackingApprove).toBe(false);
    expect(view.matrix.FINANCE?.recoveryPayoutRecord).toBe(true);
  });

  it('07 VIEWER 全 false（fail-closed 在矩阵中可见）', () => {
    const view = getPermissionMatrix();
    expect(Object.values(view.matrix.VIEWER ?? {}).every((value) => value === false)).toBe(true);
  });
});

describe('MSG-39 · A2 模块分层', () => {
  it('08 userMembership 仅 OWNER/ADMIN（OPS/FINANCE/VIEWER fail-closed）', () => {
    for (const role of ['OWNER', 'ADMIN']) expect(canAccessAdminModule(role, 'userMembership'), role).toBe(true);
    for (const role of ['OPS', 'FINANCE', 'VIEWER', '']) {
      expect(canAccessAdminModule(role, 'userMembership'), role).toBe(false);
    }
  });
});
