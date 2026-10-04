/** CA-5 单元验收：授权中心六项清单投影（含 MSG-20261004-08 REVISE A/B/C）+ 只读 HTTP 边界。 */

import { describe, expect, it } from 'vitest';

import {
  buildCustomsAuthorizationCenter,
  CUSTOMS_AUTHORIZATION_PROVIDER_SIDE_BLOCKERS,
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

const item = (value: ReturnType<typeof center>, key: string) => value.items.find((entry) => entry.key === key)!;

describe('CA-5 — customs authorization center projection（unit）', () => {
  it('全部就绪：六项清单 + 主 CTA START_RECOVERY，且不表示已提交', () => {
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
    // BROKER_FILED 的应用 policy 不要求签署权限
    expect(item(value, 'SIGNER_AUTHORITY').state).toBe('NOT_REQUIRED');
    expect(item(value, 'SUBMISSION_READINESS').state).toBe('READY_TO_SUBMIT');
    expect(value.nextAction).toBe('START_RECOVERY');
    expect(value.stages).toEqual({ READY_TO_PREPARE: true, READY_TO_FILE: true, READY_TO_RECEIVE_REFUND: true });
    expect(value.filingSubmitted).toBe(false);
    expect(value.transportEnabled).toBe(false);
    expect(value.productionCredentials).toBe('ABSENT');
    expect(value.serverDerived).toBe(true);
  });

  it('缺代理授权：④ 需要动作，⑥ 停在准备中，工程码只进高级详情', () => {
    const value = center({ brokerConnected: false, brokerPoaStatus: 'MISSING' });
    const broker = item(value, 'BROKER_AUTHORIZATION');
    expect(broker.state).toBe('NEEDS_ACTION');
    expect(broker.action).toBe('COMPLETE_BROKER_AUTHORIZATION');
    expect(item(value, 'SUBMISSION_READINESS').state).toBe('IN_PREPARATION');
    expect(value.nextAction).toBe('COMPLETE_BROKER_AUTHORIZATION');
    expect(value.advancedBlockerCodes).toContain('BROKER_NOT_CONNECTED');
  });

  it('SELF_FILED：③ 由应用 policy 判定为必需，④ NOT_REQUIRED；辖区不匹配 fail-closed', () => {
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

  it('REVISE A：policy 未确定时，③/④ 不得声称 NOT_REQUIRED（PENDING_POLICY + 等待授权）', () => {
    // SERVICE_PROVIDER_TRANSMIT 无默认 policy → policyApplied=false
    const value = center({}, 'SERVICE_PROVIDER_TRANSMIT');
    expect(item(value, 'SIGNER_AUTHORITY').state).toBe('PENDING_POLICY');
    expect(item(value, 'SIGNER_AUTHORITY').action).toBeNull();
    expect(item(value, 'BROKER_AUTHORIZATION').state).toBe('PENDING_POLICY');
    expect(item(value, 'BROKER_AUTHORIZATION').action).toBeNull();
    expect(item(value, 'SUBMISSION_READINESS').state).toBe('WAITING_AUTHORIZATION');
    expect(value.nextAction).toBeNull();
    expect(value.advancedBlockerCodes).toContain('PROVIDER_POLICY_REQUIRED');
  });

  it('REVISE B：缺少合法 filing permission 时不得出现「准备中 + 无下一步」死区', () => {
    const value = center({ filingPermissionValid: false });
    const submit = item(value, 'SUBMISSION_READINESS');
    expect(submit.state).toBe('WAITING_AUTHORIZATION');
    expect(submit.blockerCodes).toContain('FILING_PERMISSION_REQUIRED');
    expect(CUSTOMS_AUTHORIZATION_PROVIDER_SIDE_BLOCKERS).toContain('FILING_PERMISSION_REQUIRED');
    // 客户侧没有可做项 → nextAction 为空是合法"等待"，而不是错误状态
    expect(value.nextAction).toBeNull();
    expect(item(value, 'ENTERPRISE_IDENTITY').state).toBe('CONFIRMED');
  });

  it('REVISE B：provider 能力未就绪同样是等待授权（不是准备中）', () => {
    const value = center({ providerCapabilityReady: false });
    expect(item(value, 'SUBMISSION_READINESS').state).toBe('WAITING_AUTHORIZATION');
    expect(item(value, 'SUBMISSION_READINESS').blockerCodes).toContain('FILING_PROVIDER_NOT_READY');
  });

  it('REVISE C：⑥ 可提交时主 CTA 是 START_RECOVERY，退款账户不成为隐含前置', () => {
    const value = center({ refundDestinationVerified: false });
    expect(item(value, 'REFUND_ACCOUNT').state).toBe('NEEDS_ACTION');
    expect(item(value, 'REFUND_ACCOUNT').action).toBe('CONFIRM_REFUND_ACCOUNT');
    expect(item(value, 'SUBMISSION_READINESS').state).toBe('READY_TO_SUBMIT');
    expect(value.stages.READY_TO_FILE).toBe(true);
    expect(value.stages.READY_TO_RECEIVE_REFUND).toBe(false);
    expect(value.nextAction).toBe('START_RECOVERY');
  });

  it('身份 / 追回权缺失：① 与 ② 分别给出客户动作', () => {
    const value = center({ iorConfirmed: false, recoveryRightForRemedy: false });
    expect(item(value, 'ENTERPRISE_IDENTITY').action).toBe('CONFIRM_ENTERPRISE_IDENTITY');
    expect(item(value, 'RECOVERY_RIGHT').action).toBe('SUPPLY_DOCUMENTS');
    expect(value.nextAction).toBe('CONFIRM_ENTERPRISE_IDENTITY');
  });

  it('不返回任何客户不可见的原始金额 / 凭证字段', () => {
    const serialised = JSON.stringify(center());
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
