/**
 * CARRIER QUEUE #3（MSG-20261003-105 ⑯–㉘）— UPS / FedEx 授权 + 账号发现内部契约回归。
 * 断言：未知 carrier fail-closed；明文凭据不受支持；identity 服务端派生；0/1/多账号分支；
 * 幂等；跨租户不可复用；UPS / FedEx 能力事实分离；bindExecuted / platform write / TRANSPORT 恒 false；
 * production credentials 恒 ABSENT；无真实 provider 请求。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CARRIER_AUTH_CONTRACTS,
  CARRIER_READ_ONLY_SCOPE_INTENTS,
  CarrierAuthContractError,
  assertCarrierNotProductionReady,
  assertCarrierReadOnlyScopeIntents,
  projectCarrierReadiness,
  requireCarrierAuthContract,
  resolveCarrierAuthContract,
  type CarrierReadinessView,
} from '../services/carriers/carrier-auth-contract';
import {
  CARRIER_ACCOUNT_TYPES,
  carrierCandidateIdentity,
  createInMemoryCarrierCredentialLineageStore,
  createSandboxCarrierAccountDiscoveryPort,
  discoverCarrierAccounts,
  type CarrierAccountDiscoveryPort,
  type CarrierDiscoveredAccount,
  type CarrierDiscoveryInput,
  type CarrierDiscoveryOutcome,
} from '../services/carriers/carrier-account-discovery';
import { resolveCarrierConnector } from '../services/carriers/connector-capability';

const UPS_ACCOUNT: CarrierDiscoveredAccount = {
  provider: 'UPS',
  externalAccountId: 'UPS-ACCT-1',
  displayName: 'UPS Shipper 1',
  accountType: 'SHIPPER',
  countryOrRegion: 'US',
  status: 'ACTIVE',
  identityVersion: 'carrier-identity-v1',
};

const FEDEX_ACCOUNT: CarrierDiscoveredAccount = {
  provider: 'FEDEX',
  externalAccountId: 'FDX-ACCT-9',
  displayName: 'FedEx Payer 9',
  accountType: 'PAYER',
  countryOrRegion: 'US',
  status: 'ACTIVE',
  identityVersion: 'carrier-identity-v1',
};

function baseInput(overrides: Partial<CarrierDiscoveryInput> = {}): CarrierDiscoveryInput {
  return {
    provider: 'UPS',
    credentialRef: 'SANDBOX:UPS:cred-1',
    organizationId: 'org-a',
    actorUserId: 'user-a',
    ...overrides,
  };
}

type PortCall = Parameters<CarrierAccountDiscoveryPort['discoverAccounts']>[0];

function spyPort(result: readonly CarrierDiscoveredAccount[] | Error): {
  port: CarrierAccountDiscoveryPort;
  calls: PortCall[];
} {
  const calls: PortCall[] = [];
  return {
    calls,
    port: {
      async discoverAccounts(input) {
        calls.push(input);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

describe('CARRIER QUEUE #3 — carrier auth contract（UPS / FedEx 分别声明）', () => {
  it('UPS = OAUTH_AUTH_CODE；FedEx = INTEGRATOR_CREDENTIAL_REGISTRATION；未知 carrier fail-closed', () => {
    expect(requireCarrierAuthContract('UPS').authKind).toBe('OAUTH_AUTH_CODE');
    expect(requireCarrierAuthContract('FEDEX').authKind).toBe('INTEGRATOR_CREDENTIAL_REGISTRATION');
    expect(resolveCarrierAuthContract('ups')?.provider).toBe('UPS');
    expect(resolveCarrierAuthContract('DHL')).toBeNull();
    expect(() => requireCarrierAuthContract('DHL')).toThrow(CarrierAuthContractError);
    expect(() => requireCarrierAuthContract('DHL')).toThrow('CARRIER_PROVIDER_UNKNOWN');
  });

  it('authKind 与 connector-capability 单一事实源一致（不另立第二套 provider 事实）', () => {
    expect(CARRIER_AUTH_CONTRACTS).toHaveLength(2);
    for (const contract of CARRIER_AUTH_CONTRACTS) {
      const descriptor = resolveCarrierConnector(contract.provider);
      expect(descriptor).not.toBeNull();
      expect(contract.authKind).toBe(descriptor?.authModel);
      expect(contract.credentialReferenceOnly).toBe(true);
      expect(contract.identityVerificationRequired).toBe(true);
      expect(contract.multiAccountPerCredential).toBe('PROVIDER_DISCOVERY_DECIDES');
    }
  });

  it('端点只声明抽象名 + HOST 配置责任，不含任何真实取值', () => {
    for (const contract of CARRIER_AUTH_CONTRACTS) {
      for (const endpoint of [
        contract.authorizationEndpoint,
        contract.tokenEndpoint,
        contract.accountDiscoveryEndpoint,
      ]) {
        expect(endpoint.configuredBy).toBe('HOST');
        expect(endpoint.value).toBeNull();
        expect(endpoint.abstraction.length).toBeGreaterThan(0);
      }
      const serialized = JSON.stringify(contract);
      expect(serialized).not.toContain('https://');
      expect(serialized).not.toContain('client_secret=');
    }
  });

  it('只读 scope 意图非空且拒绝任何 write / 未登记意图', () => {
    expect([...CARRIER_READ_ONLY_SCOPE_INTENTS]).toEqual(['TRACKING_READ', 'INVOICE_READ', 'POD_READ']);
    for (const contract of CARRIER_AUTH_CONTRACTS) {
      expect(contract.readOnlyScopeIntents.length).toBeGreaterThan(0);
      expect(() => assertCarrierReadOnlyScopeIntents(contract.provider, [...contract.readOnlyScopeIntents])).not.toThrow();
      expect(() => assertCarrierReadOnlyScopeIntents(contract.provider, ['SHIPMENT_WRITE'])).toThrow('CARRIER_SCOPE_ESCALATION_REJECTED');
      expect(() => assertCarrierReadOnlyScopeIntents(contract.provider, ['CLAIM_SUBMIT'])).toThrow('CARRIER_SCOPE_ESCALATION_REJECTED');
      expect(() => assertCarrierReadOnlyScopeIntents(contract.provider, ['RATE_READ'])).toThrow('CARRIER_SCOPE_ESCALATION_REJECTED');
    }
  });

  it('token 过期 / refresh 行为按 provider 分别声明（UPS refresh_token；FedEx 凭据重新签发）', () => {
    const ups = requireCarrierAuthContract('UPS');
    const fedex = requireCarrierAuthContract('FEDEX');
    expect(ups.tokenExpiry.supported).toBe(true);
    expect(ups.tokenExpiry.defaultTtlSeconds).toBeNull(); // 真实 TTL 由 HOST 注入，不猜
    expect(ups.refreshBehavior).toBe('REFRESH_TOKEN');
    expect(ups.refreshSupported).toBe(true);
    expect(fedex.refreshBehavior).toBe('CLIENT_CREDENTIAL_REISSUE');
    expect(fedex.refreshSupported).toBe(true);
    expect(ups.requiredProductionCredentials).not.toEqual(fedex.requiredProductionCredentials);
  });

  it('readiness 按 provider 分离：production credentials 恒 ABSENT / transport=false / platform write=false', () => {
    const views = projectCarrierReadiness();
    expect(views.map((view) => view.provider).sort()).toEqual(['FEDEX', 'UPS']);
    for (const view of views) {
      expect(view.authContractReady).toBe(true);
      expect(view.accountDiscoveryContractReady).toBe(true);
      expect(view.authImplemented).toBe(false);
      expect(view.accountDiscoveryImplemented).toBe(false);
      expect(view.identityVerificationRequired).toBe(true);
      expect(view.productionCredentials).toBe('ABSENT');
      expect(view.productionApprovalState).toBe('NOT_REQUESTED');
      expect(view.sandboxState).toBe('AVAILABLE');
      expect(view.platformWriteEnabled).toBe(false);
      expect(view.transportEnabled).toBe(false);
      expect(view.requiredHostActions.length).toBeGreaterThan(0);
    }
    const serialized = JSON.stringify(views);
    expect(serialized).not.toContain('CARRIER_READY');
    expect(serialized).not.toContain('PRODUCTION_READY');
    expect(new Set(views.map((view) => view.provider)).size).toBe(2);
  });

  it('assertCarrierNotProductionReady 对伪造的「已就绪」视图 fail-closed', () => {
    const forged = { ...projectCarrierReadiness()[0], transportEnabled: true } as unknown as CarrierReadinessView;
    expect(() => assertCarrierNotProductionReady(forged)).toThrow('CARRIER_READINESS_MUST_REMAIN_EXTERNAL_GATE');
    expect(() => assertCarrierNotProductionReady(projectCarrierReadiness()[0])).not.toThrow();
  });
});

describe('CARRIER QUEUE #3 — discovery fail-closed', () => {
  it('未知 carrier → UNKNOWN_CARRIER，且 discovery port 从未被调用', async () => {
    const spy = spyPort([UPS_ACCOUNT]);
    const outcome = await discoverCarrierAccounts({ port: spy.port }, baseInput({ provider: 'DHL' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reason).toBe('UNKNOWN_CARRIER');
    expect(spy.calls).toHaveLength(0);
  });

  it('缺 credentialRef（缺省 / 空串 / 仅空白）→ CREDENTIAL_REF_REQUIRED，且 port 未被调用', async () => {
    for (const credentialRef of [undefined, null, '', '   ']) {
      const spy = spyPort([UPS_ACCOUNT]);
      const outcome = await discoverCarrierAccounts({ port: spy.port }, baseInput({ credentialRef }));
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? null : outcome.reason).toBe('CREDENTIAL_REF_REQUIRED');
      expect(spy.calls).toHaveLength(0);
    }
  });

  it('明文凭据输入一律不受支持（accessToken / refreshToken / clientSecret）', async () => {
    for (const key of ['accessToken', 'refreshToken', 'clientSecret']) {
      const spy = spyPort([UPS_ACCOUNT]);
      const input = { ...baseInput(), [key]: 'PLAINTEXT-VALUE' } as unknown as CarrierDiscoveryInput;
      const outcome = await discoverCarrierAccounts({ port: spy.port }, input);
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? null : outcome.reason).toBe('PLAINTEXT_CREDENTIAL_NOT_SUPPORTED');
      expect(spy.calls).toHaveLength(0);
      expect(JSON.stringify(outcome)).not.toContain('PLAINTEXT-VALUE');
    }
  });

  it('未声明的未知字段 → UNSUPPORTED_INPUT（fail-closed）', async () => {
    const spy = spyPort([UPS_ACCOUNT]);
    const input = { ...baseInput(), shipperNumber: '1234' } as unknown as CarrierDiscoveryInput;
    const outcome = await discoverCarrierAccounts({ port: spy.port }, input);
    expect(outcome.ok ? null : outcome.reason).toBe('UNSUPPORTED_INPUT');
    expect(spy.calls).toHaveLength(0);
  });

  it('缺租户上下文（organizationId / actorUserId）→ TENANT_CONTEXT_REQUIRED', async () => {
    const missingOrg = spyPort([UPS_ACCOUNT]);
    const outcomeOrg = await discoverCarrierAccounts({ port: missingOrg.port }, baseInput({ organizationId: '   ' }));
    expect(outcomeOrg.ok ? null : outcomeOrg.reason).toBe('TENANT_CONTEXT_REQUIRED');
    const missingUser = spyPort([UPS_ACCOUNT]);
    const outcomeUser = await discoverCarrierAccounts({ port: missingUser.port }, baseInput({ actorUserId: null }));
    expect(outcomeUser.ok ? null : outcomeUser.reason).toBe('TENANT_CONTEXT_REQUIRED');
    expect(missingOrg.calls).toHaveLength(0);
    expect(missingUser.calls).toHaveLength(0);
  });

  it('discovery port 抛错 → DISCOVERY_FAILED（不向上抛，也不泄漏上游错误细节）', async () => {
    const spy = spyPort(new Error('CARRIER_API_500'));
    const outcome = await discoverCarrierAccounts({ port: spy.port }, baseInput());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reason).toBe('DISCOVERY_FAILED');
    expect(JSON.stringify(outcome)).not.toContain('CARRIER_API_500');
  });

  it('账号形状非法（provider 不符 / 空 externalAccountId / 携带凭据字段 / 非法 status / 非对象）→ DISCOVERED_ACCOUNT_INVALID', async () => {
    const cases: unknown[] = [
      [{ ...UPS_ACCOUNT, provider: 'FEDEX' }],
      [{ ...UPS_ACCOUNT, externalAccountId: '   ' }],
      [{ ...UPS_ACCOUNT, accessToken: 'ACC-TOKEN-XYZ' }],
      [{ ...UPS_ACCOUNT, status: 'WHATEVER' }],
      ['not-an-object'],
    ];
    for (const result of cases) {
      const spy = spyPort(result as unknown as readonly CarrierDiscoveredAccount[]);
      const outcome = await discoverCarrierAccounts({ port: spy.port }, baseInput());
      expect(outcome.ok ? null : outcome.reason).toBe('DISCOVERED_ACCOUNT_INVALID');
      expect(JSON.stringify(outcome)).not.toContain('ACC-TOKEN-XYZ');
    }
  });
});

describe('CARRIER QUEUE #3 — discovery result handling（0 / 1 / 多账号 + 幂等 + 租户）', () => {
  it('0 账号 → NO_ACCOUNT_DISCOVERED，且重复 discovery 结果稳定（plan 为 null）', async () => {
    const spy = spyPort([]);
    const first = await discoverCarrierAccounts({ port: spy.port }, baseInput());
    const second = await discoverCarrierAccounts({ port: spy.port }, baseInput());
    for (const outcome of [first, second]) {
      expect(outcome.ok).toBe(true);
      expect(outcome.ok ? outcome.status : null).toBe('NO_ACCOUNT_DISCOVERED');
      expect(outcome.ok ? outcome.candidates : null).toHaveLength(0);
      expect(outcome.ok ? outcome.plan : null).toBeNull();
    }
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('1 账号 → candidate bind plan（bindExecuted=false / identity 服务端派生）', async () => {
    const spy = spyPort([UPS_ACCOUNT]);
    const outcome = await discoverCarrierAccounts({ port: spy.port }, baseInput());
    if (!outcome.ok || outcome.status !== 'CANDIDATE_BIND_PLAN') throw new Error('expected CANDIDATE_BIND_PLAN');
    expect(outcome.candidates).toHaveLength(1);
    const candidate = outcome.candidates[0];
    expect(candidate.externalAccountId).toBe('UPS-ACCT-1');
    expect(candidate.identitySource).toBe('PROVIDER_DISCOVERY');
    expect(candidate.candidateIdentity).toBe(carrierCandidateIdentity('UPS', 'UPS-ACCT-1'));
    expect(CARRIER_ACCOUNT_TYPES).toContain(candidate.accountType);
    expect(outcome.plan.bindExecuted).toBe(false);
    expect(outcome.plan.candidates).toHaveLength(1);
    expect(outcome.plan.productionCredentials).toBe('ABSENT');
    expect(outcome.plan.platformWriteEnabled).toBe(false);
    expect(outcome.plan.transportEnabled).toBe(false);
    expect(outcome.plan.credentialLineage).toEqual({
      provider: 'UPS',
      organizationId: 'org-a',
      actorUserId: 'user-a',
      credentialRef: 'SANDBOX:UPS:cred-1',
    });
  });

  it('多账号 → EXPLICIT_SELECTION_REQUIRED（不得自动绑定任一账号）', async () => {
    const spy = spyPort([UPS_ACCOUNT, { ...UPS_ACCOUNT, externalAccountId: 'UPS-ACCT-2' }]);
    const outcome = await discoverCarrierAccounts({ port: spy.port }, baseInput());
    expect(outcome.ok ? outcome.status : null).toBe('EXPLICIT_SELECTION_REQUIRED');
    expect(outcome.ok ? outcome.plan : null).toBeNull();
    const identities = outcome.ok ? outcome.candidates.map((item) => item.candidateIdentity) : [];
    expect(identities).toEqual(['carrier:UPS:UPS-ACCT-1', 'carrier:UPS:UPS-ACCT-2']);
  });

  it('多账号 + 命中用户 hint 仍然要求显式选择（hint 不参与选择）', async () => {
    const spy = spyPort([UPS_ACCOUNT, { ...UPS_ACCOUNT, externalAccountId: 'UPS-ACCT-2' }]);
    const outcome = await discoverCarrierAccounts(
      { port: spy.port },
      baseInput({ hint: { externalAccountId: 'UPS-ACCT-2' } }),
    );
    expect(outcome.ok ? outcome.status : null).toBe('EXPLICIT_SELECTION_REQUIRED');
    expect(outcome.ok ? outcome.plan : null).toBeNull();
    expect(outcome.ok ? outcome.identityHintAccepted : null).toBe(false);
  });

  it('客户端伪造 externalAccountId 被忽略：只出现服务端检索到的 identity', async () => {
    const spy = spyPort([UPS_ACCOUNT]);
    const outcome = await discoverCarrierAccounts({ port: spy.port }, baseInput({ hint: { externalAccountId: 'FORGED-999' } }));
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.candidates[0].externalAccountId).toBe('UPS-ACCT-1');
    expect(outcome.identityHintAccepted).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain('FORGED-999');
  });

  it('幂等：同一 provider + externalAccountId 重复 discovery → 同一 candidate identity；同一响应内重复条目去重', async () => {
    const spy = spyPort([UPS_ACCOUNT, { ...UPS_ACCOUNT, displayName: 'duplicate row' }]);
    const first = await discoverCarrierAccounts({ port: spy.port }, baseInput());
    const second = await discoverCarrierAccounts({ port: spy.port }, baseInput());
    const identitiesOf = (outcome: CarrierDiscoveryOutcome): string[] =>
      outcome.ok ? outcome.candidates.map((item) => item.candidateIdentity) : [];
    expect(identitiesOf(first)).toEqual(['carrier:UPS:UPS-ACCT-1']);
    expect(identitiesOf(second)).toEqual(identitiesOf(first));
  });

  it('跨租户结果不可复用：同一 credentialRef 登记在别的 organization → CREDENTIAL_LINEAGE_CONFLICT', async () => {
    const lineage = createInMemoryCarrierCredentialLineageStore();
    const spy = spyPort([UPS_ACCOUNT]);
    const firstOutcome = await discoverCarrierAccounts({ port: spy.port, lineage }, baseInput({ organizationId: 'org-a' }));
    expect(firstOutcome.ok).toBe(true);
    const crossTenant = await discoverCarrierAccounts(
      { port: spy.port, lineage },
      baseInput({ organizationId: 'org-b', actorUserId: 'user-b' }),
    );
    expect(crossTenant.ok ? null : crossTenant.reason).toBe('CREDENTIAL_LINEAGE_CONFLICT');
    const sameTenant = await discoverCarrierAccounts({ port: spy.port, lineage }, baseInput({ organizationId: 'org-a' }));
    expect(sameTenant.ok).toBe(true);
    const providerMismatch = await discoverCarrierAccounts({ port: spy.port, lineage }, baseInput({ provider: 'FEDEX' }));
    expect(providerMismatch.ok ? null : providerMismatch.reason).toBe('CREDENTIAL_LINEAGE_CONFLICT');
  });

  it('凭据值绝不回显：outcome 只含 credentialRef 引用，不含任何凭据字段；port 只收到引用', async () => {
    const spy = spyPort([UPS_ACCOUNT]);
    const outcome = await discoverCarrierAccounts({ port: spy.port }, baseInput());
    const serialized = JSON.stringify(outcome);
    for (const forbidden of ['accessToken', 'refreshToken', 'clientSecret', 'password']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain('SANDBOX:UPS:cred-1'); // 只允许「引用」
    expect(spy.calls[0].credentialRef).toBe('SANDBOX:UPS:cred-1');
    expect(Object.keys(spy.calls[0]).sort()).toEqual(['actorUserId', 'credentialRef', 'organizationId', 'provider']);
  });

  it('边界恒关：bindExecuted / platform write / TRANSPORT 恒 false，production credentials 恒 ABSENT', async () => {
    const spy = spyPort([FEDEX_ACCOUNT]);
    const outcome = await discoverCarrierAccounts(
      { port: spy.port },
      baseInput({ provider: 'FEDEX', credentialRef: 'SANDBOX:FEDEX:cred-9' }),
    );
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.transportEnabled).toBe(false);
    expect(outcome.platformWriteEnabled).toBe(false);
    expect(outcome.productionCredentials).toBe('ABSENT');
    if (outcome.plan) {
      expect(outcome.plan.bindExecuted).toBe(false);
      expect(outcome.plan.transportEnabled).toBe(false);
      expect(outcome.plan.platformWriteEnabled).toBe(false);
      expect(outcome.plan.productionCredentials).toBe('ABSENT');
      expect(outcome.plan.requiredNextStep).toBe('VERIFIED_BIND_REQUIRED_EXTERNAL_GATE');
    }
  });

  it('sandbox port：未登记 credentialRef → 空结果；已登记 → 候选计划（无网络）', async () => {
    const port = createSandboxCarrierAccountDiscoveryPort({ UPS: { 'SANDBOX:UPS:known': [UPS_ACCOUNT] } });
    const unknown = await discoverCarrierAccounts({ port }, baseInput({ credentialRef: 'SANDBOX:UPS:unknown' }));
    expect(unknown.ok ? unknown.status : null).toBe('NO_ACCOUNT_DISCOVERED');
    const known = await discoverCarrierAccounts({ port }, baseInput({ credentialRef: 'SANDBOX:UPS:known' }));
    expect(known.ok ? known.status : null).toBe('CANDIDATE_BIND_PLAN');
  });

  it('无真实 provider 请求：全流程不触发 fetch / 任何 HTTP', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const spy = spyPort([UPS_ACCOUNT]);
    const outcome = await discoverCarrierAccounts({ port: spy.port }, baseInput());
    expect(outcome.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
