/**
 * C-0008-B1 — role permission matrix (approved by the architecture review).
 *
 *   role     connections(write)  opportunity review  case create  claim text  claim amounts  billing view  billing advance
 *   OWNER         yes                yes                yes          yes           yes            yes            yes
 *   ADMIN         yes                yes                yes          yes           yes            yes            yes
 *   OPS           no                 yes                yes          yes           yes            yes            no
 *   FINANCE       no                 no                 no           no            no             yes            yes
 *   VIEWER        no                 no                 no           no            no             no             no
 *
 * Unknown roles fail closed (everything false).
 */

export const APP_ROLES = ['OWNER', 'ADMIN', 'OPS', 'FINANCE', 'VIEWER'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export interface PermissionMatrix {
  manageConnections: boolean;
  reviewOpportunities: boolean;
  createCase: boolean;
  /** 建案时填写/修改 successFeeRate（MSG-20260928-53 裁定 1：只有 OWNER / ADMIN 可以） */
  setCommercialTerms: boolean;
  viewClaimText: boolean;
  viewClaimAmounts: boolean;
  viewBilling: boolean;
  advanceBilling: boolean;
}

const DENY_ALL: PermissionMatrix = {
  manageConnections: false,
  reviewOpportunities: false,
  createCase: false,
  setCommercialTerms: false,
  viewClaimText: false,
  viewClaimAmounts: false,
  viewBilling: false,
  advanceBilling: false,
};

export const PERMISSIONS: Record<AppRole, PermissionMatrix> = {
  OWNER: {
    manageConnections: true,
    reviewOpportunities: true,
    createCase: true,
    setCommercialTerms: true,
    viewClaimText: true,
    viewClaimAmounts: true,
    viewBilling: true,
    advanceBilling: true,
  },
  ADMIN: {
    manageConnections: true,
    reviewOpportunities: true,
    createCase: true,
    setCommercialTerms: true,
    viewClaimText: true,
    viewClaimAmounts: true,
    viewBilling: true,
    advanceBilling: true,
  },
  OPS: {
    manageConnections: false,
    reviewOpportunities: true,
    createCase: true,
    setCommercialTerms: false,
    viewClaimText: true,
    viewClaimAmounts: true,
    viewBilling: true,
    advanceBilling: false,
  },
  FINANCE: {
    manageConnections: false,
    reviewOpportunities: false,
    createCase: false,
    setCommercialTerms: false,
    viewClaimText: false,
    viewClaimAmounts: false,
    viewBilling: true,
    advanceBilling: true,
  },
  VIEWER: { ...DENY_ALL },
};

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN';

  constructor(permission: keyof PermissionMatrix) {
    super(`当前角色没有执行该操作的权限（${permission}）`);
    this.name = 'ForbiddenError';
  }
}

export function permissionsFor(role: string | null | undefined): PermissionMatrix {
  if (role && (APP_ROLES as readonly string[]).includes(role)) {
    return PERMISSIONS[role as AppRole];
  }
  return { ...DENY_ALL };
}

export function assertPermission(
  role: string | null | undefined,
  permission: keyof PermissionMatrix,
): void {
  if (!permissionsFor(role)[permission]) throw new ForbiddenError(permission);
}
