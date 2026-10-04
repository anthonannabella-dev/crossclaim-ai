/**
 * CA-5/CA-6 — 授权中心 + 一键追回计划的真实 tenant-scoped loader（MSG-20261004-09/-11 之后）
 * ---------------------------------------------------------------
 * 单一事实装配入口（全部按 organizationId 隔离，零进程级授权 flags，零默认 true）：
 *   RecoveryOpportunity(CUSTOMS) → RecoveryRoute(target) → filing route（未知 → null = fail-closed）
 *   CustomsRightLineageFact(entryReference) → principal / 追回权 / claimant / filing permission
 *   CustomsIorIdentityFact → evaluateIorIdentity（有效窗口 / REVOKED / UNVERIFIED / legalEntityRef）
 *   CustomsBrokerPoaFact / CustomsAuthorizedSignerFact → CA-1 resolver（latest usable / revoke / expire / supersede）
 * 计划层再把「既有授权能否复用」编码成 snapshot（CA-6：同一 principal/jurisdiction/scope/route 不重复签署）。
 */

import type { PrismaClient } from '@prisma/client';

import {
  CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS,
  missingFilingCapabilities,
  type CustomsFilingCapabilities,
} from './customs-filing-provider';
import {
  evaluateCustomsAuthorizationForRoute,
  resolveAuthorizedSignerFacts,
  resolveBrokerPoaFacts,
  type AuthorizedSignerRow,
  type BrokerPoaRow,
  type CustomsAuthorizationFacts,
  type CustomsFilingRoute,
} from './customs-authorization-route';
import { buildCustomsAuthorizationCenter, type CustomsAuthorizationCenter } from './customs-authorization-center';
import type { CustomsAuthorizationCenterHttpDeps } from './customs-authorization-center-http';
import {
  planCustomsOneClickAuthorization,
  type CustomsExistingAuthorizationSnapshot,
  type CustomsOneClickAuthorizationPlan,
} from './customs-one-click-authorization';
import { evaluateIorIdentity, normalizeIorIdentity } from './enterprise-ior/ior-identity';

/** RecoveryRoute.target → 三种合法 filing route；其它一律 null（未知 = fail-closed）。 */
export const ROUTE_TARGET_TO_FILING_ROUTE: Record<string, CustomsFilingRoute | null> = {
  CUSTOMS_BROKER: 'BROKER_FILED',
  CUSTOMER_SELF: 'SELF_FILED',
};

export interface CustomsAuthorizationLoaderOptions {
  provider?: { providerId: string; capabilities: CustomsFilingCapabilities } | null;
  now?: () => Date;
}

export interface CustomsAuthorizationContext {
  center: CustomsAuthorizationCenter;
  existingAuthorization: CustomsExistingAuthorizationSnapshot | null;
  /** true = BROKER_FILED 且目标 broker 尚未由 server truth（CA-4 session）确定。 */
  targetBindingUnknown: boolean;
}

/** 辖区匹配：任一为 null / '*' 视为通配（与 CA-1 policy 语义一致）。 */
function jurisdictionMatches(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return true;
  if (a === '*' || b === '*') return true;
  return a === b;
}

function providerCapabilityReady(
  provider: { providerId: string; capabilities: CustomsFilingCapabilities } | null,
): boolean {
  if (provider === null) return false;
  return missingFilingCapabilities(provider.capabilities, CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS).length === 0;
}

/** IOR 可用性：复用既有 evaluateIorIdentity；任何异常一律不可用（fail-closed）。 */
function iorIdentityUsable(
  row: {
    jurisdiction: string;
    principalType: string;
    importerOfRecordRef: string;
    legalEntityRef: string;
    aceAccountRef: string | null;
    verificationStatus: string;
    verificationSource: string;
    verifiedAt: Date | null;
    effectiveFrom: Date | null;
    effectiveTo: Date | null;
  } | null,
  organizationId: string,
  at: Date,
): boolean {
  if (!row) return false;
  try {
    const identity = normalizeIorIdentity({
      organizationId,
      jurisdiction: row.jurisdiction,
      principalType: String(row.principalType),
      importerOfRecordRef: row.importerOfRecordRef,
      legalEntityRef: row.legalEntityRef,
      aceAccountRef: row.aceAccountRef,
      verificationStatus: String(row.verificationStatus),
      verificationSource: String(row.verificationSource),
      verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
      effectiveFrom: row.effectiveFrom ? row.effectiveFrom.toISOString() : null,
      effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
    });
    return evaluateIorIdentity(identity, at.toISOString()).usable;
  } catch {
    return false;
  }
}

export function createPrismaCustomsAuthorizationContextLoader(
  prisma: PrismaClient,
  options: CustomsAuthorizationLoaderOptions = {},
): { load(input: { organizationId: string; opportunityId: string }): Promise<CustomsAuthorizationContext | null> } {
  const provider = options.provider ?? null;
  const now = options.now ?? (() => new Date());

  return {
    async load({ organizationId, opportunityId }) {
      const opportunity = await prisma.recoveryOpportunity.findFirst({
        where: { organizationId, id: opportunityId, domain: 'CUSTOMS' },
        select: { id: true, opportunityType: true },
      });
      if (!opportunity) return null;

      const routeRow = await prisma.recoveryRoute.findFirst({
        where: { organizationId, opportunityId },
        orderBy: [{ createdAt: 'desc' }],
        select: { target: true },
      });
      const filingRoute = routeRow ? ROUTE_TARGET_TO_FILING_ROUTE[String(routeRow.target)] ?? null : null;
      if (!filingRoute) return null;

      const lineage = await prisma.customsRightLineageFact.findFirst({
        where: { organizationId, entryReference: opportunity.opportunityType },
        orderBy: [{ observedAt: 'desc' }],
      });
      if (!lineage) return null;

      const principalRef = lineage.importerOfRecordRef;
      const remedy = lineage.remedyRoute === '' ? '*' : lineage.remedyRoute;

      const ior = await prisma.customsIorIdentityFact.findFirst({
        where: { organizationId, importerOfRecordRef: principalRef },
        orderBy: [{ observedAt: 'desc' }],
        select: {
          jurisdiction: true,
          principalType: true,
          importerOfRecordRef: true,
          legalEntityRef: true,
          aceAccountRef: true,
          verificationStatus: true,
          verificationSource: true,
          verifiedAt: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      });

      const poaRowsRaw = await prisma.customsBrokerPoaFact.findMany({
        where: { organizationId, principalRef },
        orderBy: [{ observedAt: 'desc' }],
      });
      const signerRowsRaw = await prisma.customsAuthorizedSignerFact.findMany({
        where: { organizationId, principalRef },
        orderBy: [{ observedAt: 'desc' }],
      });

      const poaRows: BrokerPoaRow[] = poaRowsRaw.map((row) => ({
        id: row.id,
        principalRef: row.principalRef,
        brokerRef: row.brokerRef,
        jurisdiction: row.jurisdiction,
        authorizationType: row.authorizationType as BrokerPoaRow['authorizationType'],
        scopeRemedies: Array.isArray(row.scope) ? (row.scope as string[]) : [],
        effectiveAt: row.effectiveAt,
        expiresAt: row.expiresAt,
        verificationStatus: row.verificationStatus as never,
        observedAt: row.observedAt,
        contentDigest: row.contentDigest,
      }));
      const signerRows: AuthorizedSignerRow[] = signerRowsRaw.map((row) => ({
        id: row.id,
        principalRef: row.principalRef,
        signerRef: row.signerRef,
        signerType: row.signerType as AuthorizedSignerRow['signerType'],
        authorityBasis: row.authorityBasis,
        scopeRemedies: Array.isArray(row.scope) ? (row.scope as string[]) : [],
        jurisdiction: row.jurisdiction,
        effectiveAt: row.effectiveAt,
        expiresAt: row.expiresAt,
        verificationStatus: row.verificationStatus as never,
        observedAt: row.observedAt,
        revokedAt: row.revokedAt,
        supersededAt: row.supersededAt,
        contentDigest: row.contentDigest,
      }));

      const at = now();
      const latestBrokerRef = poaRowsRaw[0]?.brokerRef ?? null;

      // CA-6 REVISE（MSG-20261004-12）：目标 broker 必须来自 server truth（CA-4 broker authorization session），
      // 不得用"最新一张 POA 的 broker"冒充"本次 filing 的目标 broker"，也不得默认 true。
      // MSG-20261004-13 REVISE：目标 session 必须与本次机会上下文匹配
      // （principal + route + jurisdiction 通配 + requestedScope 覆盖 remedy），且排除已撤销/过期 session；
      // 不能只按 principal 取"最新一条 session"，否则旧 context 的新 session 会制造错误的 BROKER_CHANGED。
      const sessionCandidates = await prisma.customsBrokerAuthorizationSession.findMany({
        where: { organizationId, principalRef },
        orderBy: [{ updatedAt: 'desc' }, { sessionId: 'desc' }],
        select: { brokerRef: true, jurisdiction: true, requestedScope: true, route: true, status: true },
      });
      const sessionScopeCoversRemedy = (scope: unknown): boolean =>
        Array.isArray(scope) && (scope.includes('*') || scope.includes(remedy));
      const sessionJurisdictionMatches = (sessionJurisdiction: string): boolean =>
        sessionJurisdiction === '*' || sessionJurisdiction === ior?.jurisdiction;
      const targetSession =
        sessionCandidates.find(
          (session) =>
            session.route === filingRoute &&
            sessionScopeCoversRemedy(session.requestedScope) &&
            sessionJurisdictionMatches(session.jurisdiction) &&
            session.status !== 'REVOKED' &&
            session.status !== 'EXPIRED' &&
            session.status !== 'REJECTED',
        ) ?? null;
      const targetBrokerRef = targetSession?.brokerRef ?? null;
      const targetBindingUnknown = filingRoute === 'BROKER_FILED' && targetBrokerRef === null;
      const effectiveBrokerRef = filingRoute === 'BROKER_FILED' ? targetBrokerRef ?? latestBrokerRef : null;

      const poa = resolveBrokerPoaFacts(poaRows, {
        at,
        remedy,
        principalRef,
        ...(effectiveBrokerRef ? { brokerRef: effectiveBrokerRef } : {}),
      });
      const signer = resolveAuthorizedSignerFacts(signerRows, { at, remedy, principalRef });

      const facts: CustomsAuthorizationFacts = {
        customsAgreementSigned: false,
        iorConfirmed: iorIdentityUsable(ior, organizationId, at),
        claimantConfirmed: typeof lineage.claimantRef === 'string' && lineage.claimantRef.trim() !== '',
        recoveryRightForRemedy:
          lineage.iorRightsForRemedy === 'CONFIRMED' && lineage.claimantRightsForRemedy === 'CONFIRMED',
        brokerConnected: effectiveBrokerRef !== null,
        brokerPoaStatus: poa.status,
        brokerPoaScopeCoversRemedy: poa.scopeCoversRemedy,
        brokerPoaJurisdiction: poa.jurisdiction,
        brokerPoaSource: poa.source,
        signerStatus: signer.status,
        signerScopeCoversRemedy: signer.scopeCoversRemedy,
        signerSource: signer.source,
        signerJurisdiction: signer.jurisdiction,
        filingPermissionValid: lineage.filingAuthorized === true,
        providerCapabilityReady: providerCapabilityReady(provider),
        payeeIdentityConfirmed: false,
        refundDestinationVerified: false,
        aceEnrollmentReady: false,
      };

      const readiness = evaluateCustomsAuthorizationForRoute({ route: filingRoute, remedy, facts });
      const center = buildCustomsAuthorizationCenter({ readiness });

      // CA-6：既有授权快照（用于"要不要重签"判定；只看已解析事实，不做任何新写入）
      const existingAuthorization: CustomsExistingAuthorizationSnapshot | null =
        filingRoute === 'BROKER_FILED'
          ? targetBindingUnknown
            ? null
            : {
              subject: 'BROKER_POA',
              status: poa.status === 'VERIFIED' ? 'VERIFIED' : (poa.status as CustomsExistingAuthorizationSnapshot['status']),
              scopeCoversRequested: poa.scopeCoversRemedy,
              jurisdictionMatches: jurisdictionMatches(poa.jurisdiction, readiness.jurisdiction),
              routeMatches: true,
              // 真实比较：POA 的 brokerRef 必须等于本次 filing 的目标 broker（来自 CA-4 session）
              samePrincipal: poaRowsRaw.every((row) => row.principalRef === principalRef),
              sameBrokerOrSigner: poaRowsRaw.some(
                (row) => row.principalRef === principalRef && row.brokerRef === targetBrokerRef,
              ),
            }
          : filingRoute === 'SELF_FILED'
            ? {
                subject: 'AUTHORIZED_SIGNER',
                status:
                  signer.status === 'VERIFIED'
                    ? 'VERIFIED'
                    : (signer.status as CustomsExistingAuthorizationSnapshot['status']),
                scopeCoversRequested: signer.scopeCoversRemedy,
                jurisdictionMatches: jurisdictionMatches(signer.jurisdiction, readiness.jurisdiction),
                routeMatches: true,
                samePrincipal: signerRowsRaw.every((row) => row.principalRef === principalRef),
                // SELF_FILED 契约语义：同一 principal 下**任一仍有效的授权签署人**即可复用（不再声称"same signer"）
                sameBrokerOrSigner: signer.status === 'VERIFIED',
              }
            : null;

      return { center, existingAuthorization, targetBindingUnknown };
    },
  };
}

export function createPrismaCustomsAuthorizationCenterLoader(
  prisma: PrismaClient,
  options: CustomsAuthorizationLoaderOptions = {},
): CustomsAuthorizationCenterHttpDeps {
  const context = createPrismaCustomsAuthorizationContextLoader(prisma, options);
  return {
    async loadCenter(args) {
      const loaded = await context.load(args);
      return loaded ? loaded.center : null;
    },
  };
}

export function createPrismaCustomsOneClickAuthorizationPlanLoader(
  prisma: PrismaClient,
  options: CustomsAuthorizationLoaderOptions = {},
): { loadPlan(input: { organizationId: string; opportunityId: string }): Promise<CustomsOneClickAuthorizationPlan | null> } {
  const context = createPrismaCustomsAuthorizationContextLoader(prisma, options);
  return {
    async loadPlan(args) {
      const loaded = await context.load(args);
      if (!loaded) return null;
      return planCustomsOneClickAuthorization({
        center: loaded.center,
        existingAuthorization: loaded.existingAuthorization,
        ...(loaded.targetBindingUnknown ? { targetBindingUnknown: true } : {}),
      });
    },
  };
}
