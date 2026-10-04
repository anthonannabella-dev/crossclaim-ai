/**
 * CA-1 — ROUTE-AWARE CUSTOMS AUTHORIZATION + 三阶段 READINESS
 * ---------------------------------------------------------------
 * 授权：MSG-20261004-02（CUSTOMS AUTHORIZATION CLOSURE — INTERNAL CONTRACT + CUSTOMER UX）
 *   CHANGE A（route-aware）、CHANGE C（生命周期）、CHANGE D（三阶段 readiness）。
 *
 * 冻结边界（本模块只做判定，不做任何外写）：
 *   filingSubmitted=false · externalWritePerformed=false · transportEnabled=false · productionCredentials=ABSENT
 * 三域严格独立：Platform OAuth ≠ Broker POA ≠ Payment Authorization ≠ Authorized Signer。
 */

export type CustomsFilingRoute = 'BROKER_FILED' | 'SELF_FILED' | 'SERVICE_PROVIDER_TRANSMIT';

/** 授权生命周期（§五）：不存在 / 待核验 / 已核验 / 已撤销 / 已被更新取代 / 已过期。 */
export type AuthorizationLifecycleStatus =
  | 'MISSING'
  | 'NOT_YET_EFFECTIVE'
  | 'PENDING'
  | 'VERIFIED'
  | 'REVOKED'
  | 'SUPERSEDED'
  | 'EXPIRED';

/** 授权事实来源（三域独立：只有 POA/Signer 事实能满足对应授权）。 */
export type AuthorizationSource =
  | 'BROKER_POA_FACT'
  | 'SIGNER_AUTHORITY_FACT'
  | 'PLATFORM_OAUTH'
  | 'PAYMENT_AUTHORIZATION'
  | 'MISSING';

export type CustomsStageBlocker =
  // prepare（身份 / 追回权）
  | 'CUSTOMS_AGREEMENT_REQUIRED'
  | 'IOR_NOT_CONFIRMED'
  | 'CLAIMANT_NOT_CONFIRMED'
  | 'RECOVERY_RIGHT_NOT_CONFIRMED'
  // file（route-specific 授权）
  | 'BROKER_NOT_CONNECTED'
  | 'BROKER_POA_REQUIRED'
  | 'BROKER_POA_NOT_USABLE'
  | 'BROKER_POA_SCOPE_MISMATCH'
  | 'JURISDICTION_MISMATCH'
  | 'SIGNER_AUTHORITY_REQUIRED'
  | 'SIGNER_NOT_USABLE'
  | 'SIGNER_SCOPE_MISMATCH'
  | 'SIGNER_JURISDICTION_MISMATCH'
  | 'AUTHORIZATION_SOURCE_NOT_ALLOWED'
  | 'FILING_PERMISSION_REQUIRED'
  | 'FILING_PROVIDER_NOT_READY'
  | 'PROVIDER_POLICY_REQUIRED'
  // refund（退款账户 / enrollment）
  | 'PAYEE_IDENTITY_NOT_CONFIRMED'
  | 'REFUND_DESTINATION_NOT_VERIFIED'
  | 'ACE_ENROLLMENT_NOT_READY';

export interface CustomsAuthorizationPolicy {
  jurisdiction: string;
  brokerPoaRequired: boolean;
  authorizedSignerRequired: boolean;
  filingPermissionRequired: boolean;
  providerCapabilityRequired: boolean;
  refundEnrollmentRequired: boolean;
}

/**
 * 默认 route 策略（§三）。SERVICE_PROVIDER_TRANSMIT 刻意**没有默认策略**：
 * 授权要求由 provider capability / jurisdiction policy 决定，缺失即 fail-closed。
 */
export function defaultPolicyForRoute(route: CustomsFilingRoute, jurisdiction: string): CustomsAuthorizationPolicy | null {
  switch (route) {
    case 'BROKER_FILED':
      return {
        jurisdiction,
        brokerPoaRequired: true,
        authorizedSignerRequired: false,
        filingPermissionRequired: true,
        providerCapabilityRequired: true,
        refundEnrollmentRequired: false,
      };
    case 'SELF_FILED':
      return {
        jurisdiction,
        brokerPoaRequired: false,
        authorizedSignerRequired: true,
        filingPermissionRequired: true,
        providerCapabilityRequired: true,
        refundEnrollmentRequired: false,
      };
    case 'SERVICE_PROVIDER_TRANSMIT':
      return null;
    default:
      return null;
  }
}

export interface CustomsAuthorizationFacts {
  customsAgreementSigned: boolean;
  iorConfirmed: boolean;
  claimantConfirmed: boolean;
  recoveryRightForRemedy: boolean;
  brokerConnected: boolean;
  brokerPoaStatus: AuthorizationLifecycleStatus;
  brokerPoaScopeCoversRemedy: boolean;
  brokerPoaJurisdiction: string | null;
  brokerPoaSource: AuthorizationSource;
  signerStatus: AuthorizationLifecycleStatus;
  signerScopeCoversRemedy: boolean;
  signerSource: AuthorizationSource;
  /** Signer authority jurisdiction; SELF_FILED requires it to match the policy jurisdiction. */
  signerJurisdiction: string | null;
  filingPermissionValid: boolean;
  providerCapabilityReady: boolean;
  payeeIdentityConfirmed: boolean;
  refundDestinationVerified: boolean;
  aceEnrollmentReady: boolean;
}

export interface CustomsStageReadiness {
  ready: boolean;
  blockers: readonly CustomsStageBlocker[];
}

/** CA-5 REVISE A：CA-1 实际应用的 policy 归一化要求快照（policy 未确定时为 null）。 */
export interface CustomsRouteAuthorizationRequirements {
  jurisdiction: string;
  brokerPoaRequired: boolean;
  authorizedSignerRequired: boolean;
  filingPermissionRequired: boolean;
  providerCapabilityRequired: boolean;
  refundEnrollmentRequired: boolean;
}

export interface CustomsRouteAuthorizationReadiness {
  route: CustomsFilingRoute;
  /** 本次判定所用的 remedy（scope 覆盖以事实层已解析结果为准）。 */
  remedy: string;
  jurisdiction: string | null;
  policyApplied: boolean;
  /** 本次判定实际应用的 policy 归一化要求；policy 未确定时 null（调用方不得据此声称"不需要授权"）。 */
  requirements: CustomsRouteAuthorizationRequirements | null;
  prepare: CustomsStageReadiness;
  file: CustomsStageReadiness;
  refund: CustomsStageReadiness;
  READY_TO_PREPARE: boolean;
  READY_TO_FILE: boolean;
  READY_TO_RECEIVE_REFUND: boolean;
  blockers: readonly CustomsStageBlocker[];
  filingSubmitted: false;
  externalWritePerformed: false;
  transportEnabled: false;
  productionCredentials: 'ABSENT';
}

function usableStatus(status: AuthorizationLifecycleStatus): boolean {
  return status === 'VERIFIED';
}

/** jurisdiction 比较：`*` / null 视为通配（未限定辖区）。 */
function jurisdictionMismatch(poaJurisdiction: string | null, policyJurisdiction: string): boolean {
  if (poaJurisdiction === null || poaJurisdiction === '*') return false;
  if (policyJurisdiction === '*') return false;
  return poaJurisdiction !== policyJurisdiction;
}

function dedupe(codes: readonly CustomsStageBlocker[]): CustomsStageBlocker[] {
  const out: CustomsStageBlocker[] = [];
  for (const code of codes) {
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * 三阶段判定（§六）：
 *  prepare = 身份 / 追回权 / 来源事实是否足够（**不受** POA、退款账户阻塞）
 *  file    = prepare + route-specific 授权 + 提交能力
 *  refund  = 收款人身份 / 退款账户 / enrollment（独立于 prepare/file）
 */
export function evaluateCustomsAuthorizationForRoute(input: {
  route: CustomsFilingRoute;
  remedy: string;
  facts: CustomsAuthorizationFacts;
  policy?: CustomsAuthorizationPolicy;
}): CustomsRouteAuthorizationReadiness {
  const { route, remedy, facts } = input;
  const policy = input.policy ?? defaultPolicyForRoute(route, '*');

  const prepareBlockers: CustomsStageBlocker[] = [];
  if (!facts.customsAgreementSigned) prepareBlockers.push('CUSTOMS_AGREEMENT_REQUIRED');
  if (!facts.iorConfirmed) prepareBlockers.push('IOR_NOT_CONFIRMED');
  if (!facts.claimantConfirmed) prepareBlockers.push('CLAIMANT_NOT_CONFIRMED');
  if (!facts.recoveryRightForRemedy) prepareBlockers.push('RECOVERY_RIGHT_NOT_CONFIRMED');

  const fileBlockers: CustomsStageBlocker[] = [...prepareBlockers];
  if (policy === null) {
    // SERVICE_PROVIDER_TRANSMIT 无策略 = 缺授权信息 → fail-closed
    fileBlockers.push('PROVIDER_POLICY_REQUIRED');
  } else {
    if (policy.brokerPoaRequired) {
      if (!facts.brokerConnected) {
        fileBlockers.push('BROKER_NOT_CONNECTED');
      } else if (facts.brokerPoaStatus === 'MISSING' || facts.brokerPoaStatus === 'PENDING') {
        fileBlockers.push('BROKER_POA_REQUIRED');
      } else if (!usableStatus(facts.brokerPoaStatus)) {
        fileBlockers.push('BROKER_POA_NOT_USABLE');
      } else if (facts.brokerPoaSource !== 'BROKER_POA_FACT') {
        // 三域独立：平台 OAuth / 支付授权**不得**满足 Broker 授权
        fileBlockers.push('AUTHORIZATION_SOURCE_NOT_ALLOWED');
      } else {
        if (!facts.brokerPoaScopeCoversRemedy) fileBlockers.push('BROKER_POA_SCOPE_MISMATCH');
        if (jurisdictionMismatch(facts.brokerPoaJurisdiction, policy.jurisdiction)) fileBlockers.push('JURISDICTION_MISMATCH');
      }
    }
    if (policy.authorizedSignerRequired) {
      if (facts.signerStatus === 'MISSING' || facts.signerStatus === 'PENDING') {
        fileBlockers.push('SIGNER_AUTHORITY_REQUIRED');
      } else if (!usableStatus(facts.signerStatus)) {
        fileBlockers.push('SIGNER_NOT_USABLE');
      } else if (facts.signerSource !== 'SIGNER_AUTHORITY_FACT') {
        fileBlockers.push('AUTHORIZATION_SOURCE_NOT_ALLOWED');
      } else if (!facts.signerScopeCoversRemedy) {
        fileBlockers.push('SIGNER_SCOPE_MISMATCH');
      } else if (jurisdictionMismatch(facts.signerJurisdiction, policy.jurisdiction)) {
        fileBlockers.push('SIGNER_JURISDICTION_MISMATCH');
      }
    }
    if (policy.filingPermissionRequired && !facts.filingPermissionValid) {
      fileBlockers.push('FILING_PERMISSION_REQUIRED');
    }
    if (policy.providerCapabilityRequired && !facts.providerCapabilityReady) {
      fileBlockers.push('FILING_PROVIDER_NOT_READY');
    }
  }

  const refundBlockers: CustomsStageBlocker[] = [];
  if (!facts.payeeIdentityConfirmed) refundBlockers.push('PAYEE_IDENTITY_NOT_CONFIRMED');
  if (!facts.refundDestinationVerified) refundBlockers.push('REFUND_DESTINATION_NOT_VERIFIED');
  if ((policy?.refundEnrollmentRequired ?? false) && !facts.aceEnrollmentReady) {
    refundBlockers.push('ACE_ENROLLMENT_NOT_READY');
  }

  const prepare: CustomsStageReadiness = { ready: prepareBlockers.length === 0, blockers: prepareBlockers };
  const file: CustomsStageReadiness = { ready: fileBlockers.length === 0, blockers: fileBlockers };
  const refund: CustomsStageReadiness = { ready: refundBlockers.length === 0, blockers: refundBlockers };

  return {
    route,
    remedy,
    jurisdiction: policy?.jurisdiction ?? null,
    policyApplied: policy !== null,
    requirements: policy === null
      ? null
      : {
          jurisdiction: policy.jurisdiction,
          brokerPoaRequired: policy.brokerPoaRequired,
          authorizedSignerRequired: policy.authorizedSignerRequired,
          filingPermissionRequired: policy.filingPermissionRequired,
          providerCapabilityRequired: policy.providerCapabilityRequired,
          refundEnrollmentRequired: policy.refundEnrollmentRequired,
        },
    prepare,
    file,
    refund,
    READY_TO_PREPARE: prepare.ready,
    READY_TO_FILE: file.ready,
    READY_TO_RECEIVE_REFUND: refund.ready,
    blockers: dedupe([...fileBlockers, ...refundBlockers]),
    filingSubmitted: false,
    externalWritePerformed: false,
    transportEnabled: false,
    productionCredentials: 'ABSENT',
  };
}

/** 数据库/事实层的 POA 行（append-only；同一 principal+broker 可有多条历史）。 */
export interface BrokerPoaRow {
  id: string;
  principalRef: string;
  brokerRef: string;
  jurisdiction: string;
  authorizationType: 'CBP_FORM_5291' | 'EQUIVALENT_REGULATORY_POA';
  scopeRemedies: readonly string[];
  effectiveAt: Date;
  expiresAt: Date | null;
  verificationStatus: 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REVOKED' | 'UNKNOWN';
  observedAt: Date;
  contentDigest: string;
}

export interface ResolvedPoaFacts {
  status: AuthorizationLifecycleStatus;
  scopeCoversRemedy: boolean;
  jurisdiction: string | null;
  source: AuthorizationSource;
  rowId: string | null;
  expiresAt: Date | null;
  supersedesId: string | null;
}

/**
 * server-side deterministic 选择（§五）：按 observedAt（并列时 contentDigest）取最新一条，
 * 旧的 VERIFIED 事实自动视为 SUPERSEDED；REVOKED 覆盖更早的 VERIFIED；到期视为 EXPIRED。
 */
export function resolveBrokerPoaFacts(
  rows: readonly BrokerPoaRow[],
  ctx: { at: Date; remedy: string; principalRef?: string; brokerRef?: string },
): ResolvedPoaFacts {
  const candidates = rows
    .filter((row) => (ctx.principalRef ? row.principalRef === ctx.principalRef : true))
    .filter((row) => (ctx.brokerRef ? row.brokerRef === ctx.brokerRef : true))
    .slice()
    .sort((a, b) => {
      const byObserved = b.observedAt.getTime() - a.observedAt.getTime();
      if (byObserved !== 0) return byObserved;
      const byEffective = b.effectiveAt.getTime() - a.effectiveAt.getTime();
      if (byEffective !== 0) return byEffective;
      return a.contentDigest.localeCompare(b.contentDigest);
    });

  const latest = candidates[0];
  if (!latest) {
    return { status: 'MISSING', scopeCoversRemedy: false, jurisdiction: null, source: 'MISSING', rowId: null, expiresAt: null, supersedesId: null };
  }

  const newer = candidates.find((row) => row.id !== latest.id) ?? null;
  const scopeCoversRemedy = latest.scopeRemedies.includes('*') || latest.scopeRemedies.includes(ctx.remedy);

  let status: AuthorizationLifecycleStatus;
  if (latest.effectiveAt.getTime() > ctx.at.getTime()) status = 'NOT_YET_EFFECTIVE';
  else if (latest.verificationStatus === 'REVOKED') status = 'REVOKED';
  else if (latest.verificationStatus === 'VERIFIED') {
    if (latest.expiresAt !== null && latest.expiresAt.getTime() <= ctx.at.getTime()) status = 'EXPIRED';
    else status = 'VERIFIED';
  } else if (latest.verificationStatus === 'PENDING') status = 'PENDING';
  else status = 'PENDING';

  return {
    status,
    scopeCoversRemedy,
    jurisdiction: latest.jurisdiction,
    source: 'BROKER_POA_FACT',
    rowId: latest.id,
    expiresAt: latest.expiresAt,
    supersedesId: newer ? newer.id : null,
  };
}

/**
 * 三域独立断言（§三、§十；测试 M/N）：
 * 平台 OAuth 与支付授权都不得被当作 Broker POA / 签署权限的来源。
 */
export function assertAuthorizationDomainsIndependent(input: {
  brokerPoaStatus: AuthorizationLifecycleStatus;
  brokerPoaSource: AuthorizationSource;
  signerStatus: AuthorizationLifecycleStatus;
  signerSource: AuthorizationSource;
}): { independent: boolean; violations: string[] } {
  const violations: string[] = [];
  if (input.brokerPoaStatus === 'VERIFIED' && input.brokerPoaSource !== 'BROKER_POA_FACT') {
    violations.push('BROKER_POA_SOURCE_NOT_ALLOWED:' + input.brokerPoaSource);
  }
  if (input.signerStatus === 'VERIFIED' && input.signerSource !== 'SIGNER_AUTHORITY_FACT') {
    violations.push('SIGNER_SOURCE_NOT_ALLOWED:' + input.signerSource);
  }
  return { independent: violations.length === 0, violations };
}

/** ── CA-2：AuthorizedSignerFact（谁有权代表 claimant/importer 启动或签署 Customs recovery） ── */

export type CustomsAuthorizedSignerType =
  | 'LEGAL_REPRESENTATIVE'
  | 'AUTHORIZED_EMPLOYEE'
  | 'LICENSED_CUSTOMS_BROKER'
  | 'OTHER_REGULATORY_AUTHORIZED_SIGNER';

/** 数据库/事实层的签署人事实行（append-only；同一 principal 可有多条历史）。 */
export interface AuthorizedSignerRow {
  id: string;
  principalRef: string;
  signerRef: string;
  signerType: CustomsAuthorizedSignerType;
  authorityBasis: string;
  scopeRemedies: readonly string[];
  jurisdiction: string;
  effectiveAt: Date;
  expiresAt: Date | null;
  verificationStatus: 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REVOKED' | 'UNKNOWN';
  observedAt: Date;
  revokedAt: Date | null;
  supersededAt: Date | null;
  contentDigest: string;
}

export interface ResolvedSignerFacts {
  status: AuthorizationLifecycleStatus;
  scopeCoversRemedy: boolean;
  jurisdiction: string | null;
  source: AuthorizationSource;
  rowId: string | null;
  signerType: CustomsAuthorizedSignerType | null;
  supersedesId: string | null;
}

/**
 * server-side deterministic 选择（CA-2/CA-3）：最新一条事实生效；
 * 显式 revokedAt / supersededAt 优先；VERIFIED 且已过期 → EXPIRED；scope 必须覆盖本次 remedy。
 * 旧事实即使曾 VERIFIED 也不可用（由最新事实的 revoked/superseded/scope 决定）。
 */
export function resolveAuthorizedSignerFacts(
  rows: readonly AuthorizedSignerRow[],
  ctx: { at: Date; remedy: string; principalRef?: string },
): ResolvedSignerFacts {
  const candidates = rows
    .filter((row) => (ctx.principalRef ? row.principalRef === ctx.principalRef : true))
    .slice()
    .sort((a, b) => {
      const byObserved = b.observedAt.getTime() - a.observedAt.getTime();
      if (byObserved !== 0) return byObserved;
      const byEffective = b.effectiveAt.getTime() - a.effectiveAt.getTime();
      if (byEffective !== 0) return byEffective;
      return a.contentDigest.localeCompare(b.contentDigest);
    });

  const latest = candidates[0];
  if (!latest) {
    return {
      status: 'MISSING',
      scopeCoversRemedy: false,
      jurisdiction: null,
      source: 'MISSING',
      rowId: null,
      signerType: null,
      supersedesId: null,
    };
  }

  const newer = candidates.find((row) => row.id !== latest.id) ?? null;
  const scopeCoversRemedy = latest.scopeRemedies.includes('*') || latest.scopeRemedies.includes(ctx.remedy);

  let status: AuthorizationLifecycleStatus;
  if (latest.effectiveAt.getTime() > ctx.at.getTime()) status = 'NOT_YET_EFFECTIVE';
  else if (latest.revokedAt !== null || latest.verificationStatus === 'REVOKED') status = 'REVOKED';
  else if (latest.supersededAt !== null) status = 'SUPERSEDED';
  else if (latest.verificationStatus === 'VERIFIED') {
    status = latest.expiresAt !== null && latest.expiresAt.getTime() <= ctx.at.getTime() ? 'EXPIRED' : 'VERIFIED';
  } else if (latest.verificationStatus === 'PENDING') status = 'PENDING';
  else status = 'PENDING';

  return {
    status,
    scopeCoversRemedy,
    jurisdiction: latest.jurisdiction,
    source: 'SIGNER_AUTHORITY_FACT',
    rowId: latest.id,
    signerType: latest.signerType,
    supersedesId: newer ? newer.id : null,
  };
}

