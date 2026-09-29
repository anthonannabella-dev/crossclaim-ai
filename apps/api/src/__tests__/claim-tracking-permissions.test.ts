/**
 * MSG-20260929-25 A1 验收：Claim Tracking 专用权限键（fail-closed）
 *   claimTrackingApprove = OWNER/ADMIN
 *   claimTrackingReceive = OWNER/ADMIN/OPS
 */

import { describe, expect, it } from 'vitest';

import { permissionsFor } from '../services/workflow/permissions';

describe('MSG-25 A1 · Claim Tracking 权限键', () => {
  it('01 OWNER / ADMIN：批准与回执皆可', () => {
    for (const role of ['OWNER', 'ADMIN']) {
      expect(permissionsFor(role).claimTrackingApprove, role).toBe(true);
      expect(permissionsFor(role).claimTrackingReceive, role).toBe(true);
    }
  });

  it('02 OPS：可录回执，不可批准', () => {
    expect(permissionsFor('OPS').claimTrackingReceive).toBe(true);
    expect(permissionsFor('OPS').claimTrackingApprove).toBe(false);
  });

  it('03 FINANCE / VIEWER：两者皆不可（fail-closed）', () => {
    for (const role of ['FINANCE', 'VIEWER']) {
      expect(permissionsFor(role).claimTrackingApprove, role).toBe(false);
      expect(permissionsFor(role).claimTrackingReceive, role).toBe(false);
    }
  });

  it('04 未知角色：一律 false（fail-closed）', () => {
    for (const role of ['SUPERADMIN', '', null, undefined]) {
      expect(permissionsFor(role as never).claimTrackingApprove).toBe(false);
      expect(permissionsFor(role as never).claimTrackingReceive).toBe(false);
    }
  });
});
