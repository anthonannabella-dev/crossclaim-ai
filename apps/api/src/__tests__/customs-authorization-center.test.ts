/** CA-5 单元验收：授权中心六项清单投影 + 只读 HTTP 边界（RBAC / 404 / 边界声明）。 */

import { describe, expect, it } from 'vitest';

import {
  buildCustomsAuthorizationCenter,
  customsAuthorizationCenterRequirements,
} from '../services/customs/customs-authorization-center';
import { handleCustomsAuthorizationCenterRequest } from '../services/customs/customs-authorization-center-http';
import {
  evaluateCustomsAuthorizationForRoute,
  type CustomsAuthorizationFacts,
  type CustomsAuthorizationPolicy,
  type CustomsFilingRoute,
} from '../services/customs/customs-authorization-route';

const selfFiledPolicy: CustomsAuthorizationPolicy = {
  jurisdiction: 'US',
  brokerPoaRequired: false,
  authorizedSignerRequired: true,
  filingPermissionRequired: true,
  providerCapabilityRequired: true,
  refundEnrollmentRequired: false,
};

const baseFacts: CustomsAuthorizationFacts = {
  customsAgreementSigned: true,
  iorConfirmed: true,
  claimantConfirmed: true,
  recoveryRightForRemedy: true,
  brokerConnected: true,
  brokerPoaStatus: 'VERIFIED',
  brokerPoaScopeCoversRemedy: true,
  brokerPoaJurisdiction: 'US',
  brokerPoaSource: 'BROKER_POA_FACT',
  signerStatus: 'VERIFIED',
  signerScopeCoversRemedy: true,
  signerSource: 'SIGNER_AUTHORITY_FACT',
  signerJurisdiction: 'US',
  filingPermissionValid: true,
  providerCapabilityReady: true,
  payeeIdentityConfirmed: true,
  refundDestinationVerified: true,
  aceEnrollmentReady: true,
};

function center(
  overrides: Partial<CustomsAuthorizationFacts> = {},
  route: CustomsFilingRoute = 'BROKER_FILED',
  policy?: CustomsAuthorizationPolicy,
) {
  const readiness = evaluateCustomsAuthorizationForRoute({
    route,
    remedy: 'DUTY_REFUND',
    facts: { ...baseFacts, ...overrides },
    ...(policy ? { policy } : {}),
  });
  return buildCustomsAuthorizationCenter({ readiness });
}

const item = (value: ReturnType<typeof center>, key: string) =>
  value.items.find((entry) => entry.key === key)!;

describe('CA-5 — customs authorization center projection（unit）', () => {
  it('全部就绪：六项清单 + 唯一动作 START_RECOVERY，且不表示已提交', () => {
    const value = center();
    expect(value.items).toHaveLength(6);
    expect(value.items.map((entry) => entry.key)).toEqual([
      'ENTERPRISE_IDENTITY',
      'RECOVERY_RIGHT',
      'SIGNER_AUTHORITY',
      'BROKER_AUTHORIZATION',
      'REFUND_ACCOUNT',
      'SUBMISSION_READINESS',
    ]);
    expect(item(value, 'ENTERPRISE_IDENTITY').state).toBe('CONFIRMED');
    expect(item(value, 'BROKER_AUTHORIZATION').state).toBe('CONFIRMED');
    expect(item(value, 'SIGNER_AUTHORITY').state).toBe('NOT_REQUIRED'); // BROKER_FILED 不要求签署权限
    expect(item(value, 'SUBMISSION_READINESS').state).toBe('READY_TO_SUBMIT');
    expect(value.nextAction).toBe('START_RECOVERY');
    expect(value.stages).toEqual({
      READY_TO_PREPARE: true,
      READY_TO_FILE: true,
      READY_TO_RECEIVE_REFUND: true,
    });
    expect(value.filingSubmitted).toBe(false);
    expect(value.externalWritePerformed).toBe(false);
    expect(value.transportEnabled).toBe(false);
    expect(value.productionCredentials).toBe('ABSENT');
    expect(value.serverDerived).toBe(true);
  });

  it('缺代理授权：④ 需要动作（COMPLETE_BROKER_AUTHORIZATION），⑥ 停在准备中，工程码只进高级详情', () => {
    const value = center({ brokerConnected: false, brokerPoaStatus: 'MISSING' });
    const broker = item(value, 'BROKER_AUTHORIZATION');
    expect(broker.state).toBe('NEEDS_ACTION');
    expect(broker.action).toBe('COMPLETE_BROKER_AUTHORIZATION');
    expect(item(value, 'SUBMISSION_READINESS').state).toBe('IN_PREPARATION');
    expect(value.nextAction).toBe('COMPLETE_BROKER_AUTHORIZATION');
    expect(value.advancedBlockerCodes).toContain('BROKER_NOT_CONNECTED');
    // 客户默认视图（items）只暴露 code 数组，由 UI 决定是否放进高级详情
    expect(broker.blockerCodes).toContain('BROKER_NOT_CONNECTED');
  });

  it('SELF_FILED：不要求代理授权，但要求签署权限（含辖区不匹配 fail-closed）', () => {
    const requirements = customsAuthorizationCenterRequirements('SELF_FILED');
    expect(requirements.signerAuthorityRequired).toBe(true);
    expect(requirements.brokerAuthorizationRequired).toBe(false);

    const ok = center({ signerJurisdiction: 'US' }, 'SELF_FILED', selfFiledPolicy);
    expect(item(ok, 'SIGNER_AUTHORITY').state).toBe('CONFIRMED');
    expect(item(ok, 'BROKER_AUTHORIZATION').state).toBe('NOT_REQUIRED');
    expect(item(ok, 'SUBMISSION_READINESS').state).toBe('READY_TO_SUBMIT');

    const mismatch = center({ signerJurisdiction: 'DE' }, 'SELF_FILED', selfFiledPolicy);
    expect(item(mismatch, 'SIGNER_AUTHORITY').state).toBe('NEEDS_ACTION');
    expect(item(mismatch, 'SIGNER_AUTHORITY').action).toBe('CONFIRM_SIGNING_AUTHORITY');
    expect(item(mismatch, 'SUBMISSION_READINESS').state).toBe('IN_PREPARATION');
    expect(mismatch.advancedBlockerCodes).toContain('SIGNER_JURISDICTION_MISMATCH');
  });

  it('退款账户未就绪：⑤ 需要动作，但不阻塞 ⑥（材料/证据准备与提交准备分离）', () => {
    const value = center({ refundDestinationVerified: false });
    expect(item(value, 'REFUND_ACCOUNT').state).toBe('NEEDS_ACTION');
    expect(item(value, 'REFUND_ACCOUNT').action).toBe('CONFIRM_REFUND_ACCOUNT');
    expect(item(value, 'SUBMISSION_READINESS').state).toBe('READY_TO_SUBMIT');
    expect(value.stages.READY_TO_FILE).toBe(true);
    expect(value.stages.READY_TO_RECEIVE_REFUND).toBe(false);
    // ⑤ 排在 ⑥ 之前，因此客户此刻应先去确认退款账户
    expect(value.nextAction).toBe('CONFIRM_REFUND_ACCOUNT');
  });

  it('提交能力未就绪：⑥ = 等待授权（不伪造可提交）', () => {
    const value = center({ providerCapabilityReady: false });
    expect(item(value, 'SUBMISSION_READINESS').state).toBe('WAITING_AUTHORIZATION');
    expect(item(value, 'SUBMISSION_READINESS').action).toBeNull();
    expect(item(value, 'SUBMISSION_READINESS').blockerCodes).toContain('FILING_PROVIDER_NOT_READY');
    expect(value.nextAction).toBeNull();
  });

  it('身份 / 追回权缺失：① 与 ② 分别给出客户动作', () => {
    const value = center({ iorConfirmed: false, recoveryRightForRemedy: false });
    expect(item(value, 'ENTERPRISE_IDENTITY').action).toBe('CONFIRM_ENTERPRISE_IDENTITY');
    expect(item(value, 'RECOVERY_RIGHT').action).toBe('SUPPLY_DOCUMENTS');
    expect(value.nextAction).toBe('CONFIRM_ENTERPRISE_IDENTITY');
  });

  it('不返回任何客户不可见的原始金额 / 凭证字段', () => {
    const value = center();
    const serialised = JSON.stringify(value);
    for (const forbidden of ['amount', 'currency', 'balance', 'providerWrite', 'lineage', 'dutyTruth']) {
      expect(serialised.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('CA-5 — authorization center HTTP boundary（unit）', () => {
  const deps = {
    async loadCenter(input: { organizationId: string; opportunityId: string }) {
      if (input.opportunityId === 'missing') return null;
      return center();
    },
  };

  it('未授权角色 → 403', async () => {
    const result = await handleCustomsAuthorizationCenterRequest(
      { opportunityId: 'opp-1', session: { organizationId: 'org-1', actorUserId: 'u1', role: 'VIEWER' } },
      deps,
    );
    expect(result.status).toBe(403);
    expect(result.body.reason).toBe('ROLE_NOT_PERMITTED');
  });

  it('空 opportunityId → 400', async () => {
    const result = await handleCustomsAuthorizationCenterRequest(
      { opportunityId: '  ', session: { organizationId: 'org-1', actorUserId: 'u1', role: 'OWNER' } },
      deps,
    );
    expect(result.status).toBe(400);
  });

  it('读不到（跨租户 / 不存在）→ 404，不泄露存在性', async () => {
    const result = await handleCustomsAuthorizationCenterRequest(
      { opportunityId: 'missing', session: { organizationId: 'org-1', actorUserId: 'u1', role: 'OWNER' } },
      deps,
    );
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: 'NOT_FOUND' });
  });

  it('正常读取 → 200 + 只读边界声明（永不表示已提交）', async () => {
    const result = await handleCustomsAuthorizationCenterRequest(
      { opportunityId: 'opp-1', session: { organizationId: 'org-1', actorUserId: 'u1', role: 'OPS' } },
      deps,
    );
    expect(result.status).toBe(200);
    expect(result.body.opportunityId).toBe('opp-1');
    expect(result.body.boundary).toEqual({
      readOnly: true,
      filingSubmitted: false,
      transportEnabled: false,
      externalWritePerformed: false,
      productionCredentials: 'ABSENT',
    });
    const payload = result.body.authorizationCenter as { nextAction: string; items: unknown[] };
    expect(payload.nextAction).toBe('START_RECOVERY');
    expect(payload.items).toHaveLength(6);
  });
});
