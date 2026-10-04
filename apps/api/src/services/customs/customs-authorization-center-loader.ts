/**
 * CA-5 REVISE D（MSG-20261004-09）— 真实 tenant-scoped 授权中心 loader
 * ---------------------------------------------------------------
 * 从**持久化事实**派生（全部按 organizationId 隔离，零进程级授权 flags，零默认 true）：
 *   RecoveryOpportunity(CUSTOMS) → RecoveryRoute(target) → 决定 filing route（未知即 fail-closed 返回 null）
 *   CustomsRightLineageFact(entryReference) → principal / 追回权 / claimant / filing permission
 *   CustomsIorIdentityFact(importerOfRecordRef) → IOR 是否已核验
 *   CustomsBrokerPoaFact / CustomsAuthorizedSignerFact → CA-1 resolver（latest usable / revoke / expire / supersede）
 * 退款账户三要素（payee / refund destination / ACE enrollment）当前**没有任何已核验事实来源**，
 * 因此恒为 false（⑤ 显示"需要处理"），绝不默认 true；provider 提交能力来自已登记 provider。
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
import { buildCustomsAuthorizationCenter } from './customs-authorization-center';
import type { CustomsAuthorizationCenterHttpDeps } from './customs-authorization-center-http';

/** RecoveryRoute.target → 三种合法 filing route；其它一律 null（未知 = fail-closed）。 */
export const ROUTE_TARGET_TO_FILING_ROUTE: Record<string, CustomsFilingRoute | null> = {
  CUSTOMS_BROKER: 'BROKER_FILED',
  CUSTOMER_SELF: 'SELF_FILED',
};

export interface CustomsAuthorizationCenterLoaderOptions {
  provider?: { providerId: string; capabilities: CustomsFilingCapabilities } | null;
  now?: () => Date;
}

function providerCapabilityReady(
  provider: { providerId: string; capabilities: CustomsFilingCapabilities } | null,
): boolean {
  if (provider === null) return false;
  return missingFilingCapabilities(provider.capabilities, CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS).length === 0;
}

export function createPrismaCustomsAuthorizationCenterLoader(
  prisma: PrismaClient,
  options: CustomsAuthorizationCenterLoaderOptions = {},
): CustomsAuthorizationCenterHttpDeps {
  const provider = options.provider ?? null;
  const now = options.now ?? (() => new Date());

  return {
    async loadCenter({ organizationId, opportunityId }) {
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
        select: { verificationStatus: true },
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
      const poa = resolveBrokerPoaFacts(poaRows, {
        at,
        remedy,
        principalRef,
        ...(latestBrokerRef ? { brokerRef: latestBrokerRef } : {}),
      });
      const signer = resolveAuthorizedSignerFacts(signerRows, { at, remedy, principalRef });

      const facts: CustomsAuthorizationFacts = {
        // 无服务端事实来源的项目一律保守 false（fail-closed），绝不默认 true
        customsAgreementSigned: false,
        iorConfirmed: ior?.verificationStatus === 'VERIFIED',
        claimantConfirmed: typeof lineage.claimantRef === 'string' && lineage.claimantRef.trim() !== '',
        recoveryRightForRemedy: lineage.outcome === 'COMPLETE',
        brokerConnected: latestBrokerRef !== null,
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
      return buildCustomsAuthorizationCenter({ readiness });
    },
  };
}
