/**
 * TRACK A / PC-09（MSG-20261003-96 ⑬）— 版本化商业/法律文档 registry（唯一机器可读来源）。
 * ---------------------------------------------------------------
 * 约束（架构方裁决）：
 *   1) 不能只有静态散落页面 —— 每份文档必须有 documentKey / version / effectiveAt / status / title / 引用；
 *   2) 未知文档 → **fail-closed**（不得回退到「最新」或空文档）；
 *   3) 已 superseded 的版本必须仍可历史寻址（保留在 registry 中）；
 *   4) 本层只做披露与接受事实，不做法律意见，不做合同生命周期。
 * 边界：不启用 payment / transport / provider OAuth；Payment = 0；collection = OFF。
 */

export type PolicyStatus = 'CURRENT' | 'SUPERSEDED';

export interface PolicyDocument {
  key: string;
  version: string;
  /** ISO-8601 日期（YYYY-MM-DD） */
  effectiveAt: string;
  status: PolicyStatus;
  title: string;
  summary: string;
  /** 人类可读正文（repo 相对路径） */
  documentRef: string;
  /** 该版本是否要求客户显式接受 */
  requiresExplicitAcceptance: boolean;
  /** superseded 版本是否仍允许被接受（默认 false：只允许接受 CURRENT 版本） */
  acceptanceAllowedWhenSuperseded?: boolean;
}

export const POLICY_DOCUMENTS: readonly PolicyDocument[] = [
  {
    // 历史版本：superseded 后**仍然可寻址**（不得删除；只允许接受 CURRENT 版本）。
    key: 'terms-of-service',
    version: '2026-09-01',
    effectiveAt: '2026-09-01',
    status: 'SUPERSEDED',
    title: 'Terms of Service',
    summary: '（历史版本）服务范围与客户责任；已被 2026-10-01 版本取代。',
    documentRef: 'docs/commercial/TERMS-OF-SERVICE.md',
    requiresExplicitAcceptance: true,
  },
  {
    key: 'terms-of-service',
    version: '2026-10-01',
    effectiveAt: '2026-10-01',
    status: 'CURRENT',
    title: 'Terms of Service',
    summary: '服务范围、非法律/报关代理声明、客户责任与版本变更规则。',
    documentRef: 'docs/commercial/TERMS-OF-SERVICE.md',
    requiresExplicitAcceptance: true,
  },
  {
    key: 'privacy-policy',
    version: '2026-10-01',
    effectiveAt: '2026-10-01',
    status: 'CURRENT',
    title: 'Privacy Policy',
    summary: '收集范围、用途、保留与删除、安全姿态（不宣称未取得的认证）。',
    documentRef: 'docs/commercial/PRIVACY-POLICY.md',
    requiresExplicitAcceptance: true,
  },
  {
    key: 'data-use-notice',
    version: '2026-10-01',
    effectiveAt: '2026-10-01',
    status: 'CURRENT',
    title: 'Data Processing / Data Use Notice',
    summary: '数据类别、保留、删除请求路径、第三方处理与安全边界。',
    documentRef: 'docs/commercial/DATA-USE-NOTICE.md',
    requiresExplicitAcceptance: true,
  },
  {
    key: 'refund-and-fee-policy',
    version: '2026-10-01',
    effectiveAt: '2026-10-01',
    status: 'CURRENT',
    title: 'Refund / Fee Policy',
    summary: 'estimated / actual / basis / collected 四口径；成功费仅在确认到账后计算；当前不扣款。',
    documentRef: 'docs/commercial/REFUND-AND-FEE-POLICY.md',
    requiresExplicitAcceptance: true,
  },
  {
    key: 'recovery-service-scope',
    version: '2026-10-01',
    effectiveAt: '2026-10-01',
    status: 'CURRENT',
    title: 'Recovery Service Scope',
    summary: '包含/不包含范围、人工环节与结果说明（estimate ≠ actual recovered）。',
    documentRef: 'docs/commercial/RECOVERY-SERVICE-SCOPE.md',
    requiresExplicitAcceptance: true,
  },
  {
    key: 'provider-authorization-disclosure',
    version: '2026-10-01',
    effectiveAt: '2026-10-01',
    status: 'CURRENT',
    title: 'Provider Authorization Disclosure',
    summary: '平台授权必须由客户主动发起；当前不持有生产授权（EXTERNAL_GATE）。',
    documentRef: 'docs/commercial/PROVIDER-AUTHORIZATION-DISCLOSURE.md',
    requiresExplicitAcceptance: true,
  },
  {
    key: 'customs-broker-limitation',
    version: '2026-10-01',
    effectiveAt: '2026-10-01',
    status: 'CURRENT',
    title: 'Customs / Broker Limitation',
    summary: '非持牌报关代理 / 非律所；退款资金默认指向客户合法账户，不代收、不资金池。',
    documentRef: 'docs/commercial/CUSTOMS-BROKER-LIMITATION.md',
    requiresExplicitAcceptance: true,
  },
] as const;

/** 所有版本（含 superseded）—— 历史寻址用。 */
export function listPolicyDocuments(): PolicyDocument[] {
  return [...POLICY_DOCUMENTS];
}

/** 仅 CURRENT 版本。 */
export function listCurrentPolicies(): PolicyDocument[] {
  return POLICY_DOCUMENTS.filter((doc) => doc.status === 'CURRENT');
}

/**
 * 解析文档：给定 key（可选 version）。
 * 未知 key / 未知 version → null（fail-closed，不猜测、不回退）。
 */
export function findPolicy(key: string, version?: string): PolicyDocument | null {
  const candidates = POLICY_DOCUMENTS.filter((doc) => doc.key === key);
  if (candidates.length === 0) return null;
  if (version === undefined) {
    return candidates.find((doc) => doc.status === 'CURRENT') ?? null;
  }
  return candidates.find((doc) => doc.version === version) ?? null;
}

/** 版本历史（按 effectiveAt 倒序；同 key）。 */
export function listPolicyVersions(key: string): PolicyDocument[] {
  return POLICY_DOCUMENTS.filter((doc) => doc.key === key).sort((a, b) => (a.effectiveAt < b.effectiveAt ? 1 : -1));
}

export const REQUIRED_ACCEPTANCE_KEYS: readonly string[] = POLICY_DOCUMENTS.filter(
  (doc) => doc.status === "CURRENT" && doc.requiresExplicitAcceptance,
).map((doc) => doc.key);

/** 商业/法律披露目录（供 /commercial-readiness 引用）。 */
export const COMMERCIAL_DISCLOSURES = {
  feeDisclosure: { available: true, documentKey: 'refund-and-fee-policy' },
  successFeeDisclosure: { available: true, documentKey: 'refund-and-fee-policy' },
  providerAuthorizationDisclosure: { available: true, documentKey: 'provider-authorization-disclosure' },
  customsBoundaryDisclosure: { available: true, documentKey: 'customs-broker-limitation' },
  dataHandlingDisclosure: { available: true, documentKey: 'data-use-notice' },
} as const;
