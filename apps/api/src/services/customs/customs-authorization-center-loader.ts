/**
 * CA-5 REVISE D — 授权中心真实只读 loader（composition root 接线，MSG-20261004-08）
 * ---------------------------------------------------------------
 * 把既有的 server-side 只读输入装配成 CA-5 六项清单：
 *   · opportunities.load(organizationId, opportunityId) → 租户内 opportunity truth（不存在即 null → 404）
 *   · authorization（配置的授权事实，缺省 fail-closed 全 false，不伪造"已授权"）
 *   · provider（已登记 filing provider；没有 = 提交能力未就绪）
 * 本模块只读、零外写；真实 filing / provider transport 继续 HOLD。
 */

import {
  CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS,
  missingFilingCapabilities,
  type CustomsFilingCapabilities,
} from './customs-filing-provider';
import type { CustomsAuthorizationFlags } from './customs-authorization-readiness';
import type { CustomsRecoveryHttpDeps } from './customs-recovery-http';
import {
  evaluateCustomsAuthorizationForRoute,
  type CustomsAuthorizationFacts,
} from './customs-authorization-route';
import { buildCustomsAuthorizationCenter } from './customs-authorization-center';
import type { CustomsAuthorizationCenterHttpDeps } from './customs-authorization-center-http';

/** 未配置任何授权事实时的缺省（全 false → 保守显示"需要处理"，绝不显示"已确认"）。 */
export const FAIL_CLOSED_CUSTOMS_AUTHORIZATION_FLAGS: CustomsAuthorizationFlags = {
  customsAgreementSigned: false,
  importerOfRecordConfirmed: false,
  claimantConfirmed: false,
  recoveryRightConfirmed: false,
  brokerConnected: false,
  brokerAuthorizationValid: false,
  filingPermissionValid: false,
  providerCapabilityReady: false,
};

function providerCapabilityReady(
  provider: { providerId: string; capabilities: CustomsFilingCapabilities } | null,
): boolean {
  if (provider === null) return false;
  return missingFilingCapabilities(provider.capabilities, CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS).length === 0;
}

/** flags → CA-1 facts（BROKER_FILED 默认策略口径，与 customs-authorization-readiness.ts 等价）。 */
export function customsAuthorizationFactsFromFlags(
  flags: CustomsAuthorizationFlags,
  input: {
    providerCapabilityReady: boolean;
    signerStatus?: CustomsAuthorizationFacts['signerStatus'];
    brokerPoaStatus?: CustomsAuthorizationFacts['brokerPoaStatus'];
  },
): CustomsAuthorizationFacts {
  return {
    customsAgreementSigned: flags.customsAgreementSigned,
    iorConfirmed: flags.importerOfRecordConfirmed,
    claimantConfirmed: flags.claimantConfirmed,
    recoveryRightForRemedy: flags.recoveryRightConfirmed,
    brokerConnected: flags.brokerConnected,
    brokerPoaStatus: input.brokerPoaStatus ?? (flags.brokerAuthorizationValid ? 'VERIFIED' : 'MISSING'),
    brokerPoaScopeCoversRemedy: true,
    brokerPoaJurisdiction: null,
    brokerPoaSource: 'BROKER_POA_FACT',
    signerStatus: input.signerStatus ?? 'MISSING',
    signerScopeCoversRemedy: false,
    signerSource: 'MISSING',
    signerJurisdiction: null,
    filingPermissionValid: flags.filingPermissionValid,
    providerCapabilityReady: input.providerCapabilityReady,
    payeeIdentityConfirmed: true,
    refundDestinationVerified: true,
    aceEnrollmentReady: true,
  };
}

export function createCustomsAuthorizationCenterLoader(deps: {
  opportunities: CustomsRecoveryHttpDeps['opportunities'];
  authorization?: CustomsAuthorizationFlags;
  provider?: { providerId: string; capabilities: CustomsFilingCapabilities } | null;
}): CustomsAuthorizationCenterHttpDeps {
  const authorization = deps.authorization ?? FAIL_CLOSED_CUSTOMS_AUTHORIZATION_FLAGS;
  const provider = deps.provider ?? null;
  return {
    async loadCenter({ organizationId, opportunityId }) {
      const truth = await deps.opportunities.load(organizationId, opportunityId);
      if (truth === null) return null;
      const readiness = evaluateCustomsAuthorizationForRoute({
        route: 'BROKER_FILED',
        remedy: truth.remedyRoute ?? '*',
        facts: customsAuthorizationFactsFromFlags(authorization, {
          providerCapabilityReady: providerCapabilityReady(provider),
        }),
      });
      return buildCustomsAuthorizationCenter({ readiness });
    },
  };
}
