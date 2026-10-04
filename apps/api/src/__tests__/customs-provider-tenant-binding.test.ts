/** C18-6 单元验收：provider tenant / account lineage（server-derived 绑定 + 跨租户隔离 + fail-closed 负路径）。 */

import { describe, expect, it } from 'vitest';

import {
  appendCustomsProviderTenantLineage,
  bindCustomsProviderSubmissionRequest,
  computeProviderBindingScopeKey,
  CUSTOMS_PROVIDER_TENANT_BINDING_BOUNDARY,
  customsProviderTenantLineageDigest,
  createInMemoryCustomsProviderTenantBindingResolver,
  isJurisdictionCovered,
  resolveCustomsProviderTenantBinding,
  BINDING_SCOPE_VERSION,
  type CustomsProviderTenantBinding,
  type CustomsProviderTenantBindingQuery,
} from '../services/customs/customs-provider-tenant-binding';

const DIGEST = 'a'.repeat(64);

const binding = (overrides: Partial<CustomsProviderTenantBinding> = {}): CustomsProviderTenantBinding => ({
  organizationId: 'org:acme',
  principalRef: 'ior:acme',
  bindingScopeVersion: BINDING_SCOPE_VERSION,
  bindingScopeKey: 'b'.repeat(64),
  bindingSlotRef: 'slot:acme-us-1',
  providerId: 'provider:customs-a',
  providerTenantRef: 'ptenant:acme-us',
  providerAccountRef: 'paccount:broker-a',
  relationship: 'CROSSCLAIM_SAAS',
  relationshipEvidenceRef: 'evidence:saas-agreement-v1',
  relationshipVerifiedAt: '2026-10-04T05:00:00.000Z',
  jurisdictionScope: ['US'],
  status: 'ACTIVE',
  verifiedAt: '2026-10-04T05:00:00.000Z',
  credentialReference: 'credref:secret-slot-1',
  lineage: [{ event: 'BOUND', at: '2026-10-04T05:00:00.000Z', actorRef: 'actor:ops', note: null }],
  ...overrides,
});

const query = (overrides: Partial<CustomsProviderTenantBindingQuery> = {}): CustomsProviderTenantBindingQuery => ({
  organizationId: 'org:acme',
  providerId: 'provider:customs-a',
  jurisdiction: 'US',
  principalRef: 'ior:acme',
  ...overrides,
});

describe('C18-6 — provider tenant / account lineage（unit）', () => {
  it('ACTIVE 绑定：返回 server-derived tenant/account ref，且声明零外写', () => {
    const resolution = resolveCustomsProviderTenantBinding(binding(), query());
    expect(resolution.ok).toBe(true);
    expect(resolution.reasonCode).toBe('BINDING_RESOLVED');
    expect(resolution.providerTenantRef).toBe('ptenant:acme-us');
    expect(resolution.providerAccountRef).toBe('paccount:broker-a');
    expect(resolution.relationship).toBe('CROSSCLAIM_SAAS');
    expect(resolution.externalWritePerformed).toBe(false);
    expect(resolution.filingSubmitted).toBe(false);
    expect(resolution.transportEnabled).toBe(false);
    expect(resolution.productionCredentials).toBe('ABSENT');
    expect(resolution.nextAction).toBeNull();
  });

  it('无绑定 → BINDING_UNKNOWN 且不给出任何可执行动作', () => {
    const resolution = resolveCustomsProviderTenantBinding(null, query());
    expect(resolution.ok).toBe(false);
    expect(resolution.reasonCode).toBe('BINDING_UNKNOWN');
    expect(resolution.providerTenantRef).toBeNull();
    expect(resolution.nextAction).toBeNull();
  });

  it('非 ACTIVE 绑定（PENDING / SUSPENDED / REVOKED）→ BINDING_NOT_ACTIVE', () => {
    for (const status of ['PENDING_VERIFICATION', 'SUSPENDED', 'REVOKED'] as const) {
      const resolution = resolveCustomsProviderTenantBinding(binding({ status }), query());
      expect(resolution.ok).toBe(false);
      expect(resolution.reasonCode).toBe('BINDING_NOT_ACTIVE');
      expect(resolution.providerTenantRef).toBeNull();
    }
  });

  it('provider 不匹配 → PROVIDER_MISMATCH（绝不返回该绑定的 ref）', () => {
    const resolution = resolveCustomsProviderTenantBinding(
      binding({ providerId: 'provider:customs-b' }),
      query({ providerId: 'provider:customs-a' }),
    );
    expect(resolution.ok).toBe(false);
    expect(resolution.reasonCode).toBe('PROVIDER_MISMATCH');
    expect(resolution.providerTenantRef).toBeNull();
  });

  it('辖区覆盖：scope 精确匹配 / "*" 通配 / 不覆盖则拒绝', () => {
    expect(isJurisdictionCovered(['US'], 'US')).toBe(true);
    expect(isJurisdictionCovered(['*'], 'DE')).toBe(true);
    expect(isJurisdictionCovered(['US'], 'DE')).toBe(false);

    const denied = resolveCustomsProviderTenantBinding(binding(), query({ jurisdiction: 'DE' }));
    expect(denied.ok).toBe(false);
    expect(denied.reasonCode).toBe('JURISDICTION_NOT_COVERED');

    const wildcard = resolveCustomsProviderTenantBinding(
      binding({ jurisdictionScope: ['*'] }),
      query({ jurisdiction: 'DE' }),
    );
    expect(wildcard.ok).toBe(true);
  });

  it('关系门槛：CROSSCLAIM_SAAS 不能只是 enum —— 必须有验证证据与验证时间', () => {
    // 未验证（verifiedAt = null）
    const unverified = resolveCustomsProviderTenantBinding(
      binding({ relationshipVerifiedAt: null }),
      query(),
    );
    expect(unverified.ok).toBe(false);
    expect(unverified.reasonCode).toBe('RELATIONSHIP_NOT_VERIFIED');
    expect(unverified.providerTenantRef).toBeNull();

    // 缺证据引用
    const noEvidence = resolveCustomsProviderTenantBinding(
      binding({ relationshipEvidenceRef: null }),
      query(),
    );
    expect(noEvidence.reasonCode).toBe('RELATIONSHIP_NOT_VERIFIED');

    // 非 opaque 证据引用（裸 URL）一律拒绝
    const badEvidence = resolveCustomsProviderTenantBinding(
      binding({ relationshipEvidenceRef: 'https://example.com/contract' }),
      query(),
    );
    expect(badEvidence.reasonCode).toBe('RELATIONSHIP_NOT_VERIFIED');

    // 证据 + 验证时间齐备才放行
    expect(resolveCustomsProviderTenantBinding(binding(), query()).ok).toBe(true);

    // 非代客提交关系（CrossClaim 不是 filer）不强制该证据
    const brokerOfRecord = resolveCustomsProviderTenantBinding(
      binding({
        relationship: 'BROKER_OF_RECORD',
        relationshipEvidenceRef: null,
        relationshipVerifiedAt: null,
      }),
      query(),
    );
    expect(brokerOfRecord.ok).toBe(true);
  });

  it('关系门槛：bindCustomsProviderSubmissionRequest 在关系未验证时不得构造提交请求', async () => {
    const resolver = createInMemoryCustomsProviderTenantBindingResolver([
      binding({ relationshipVerifiedAt: null }),
    ]);
    const result = await bindCustomsProviderSubmissionRequest({
      resolver,
      organizationId: 'org:acme',
      providerId: 'provider:customs-a',
      entitlement: 'CROSSCLAIM_SAAS',
      draft: {
        principalRef: 'ior:acme',
        jurisdiction: 'US',
        remedy: 'DRAWBACK',
        filingAuthorized: true,
        packageRef: 'package:1',
        packageDigest: DIGEST,
        evidenceRefs: [{ evidenceRef: 'evidence:entry', documentKind: 'ENTRY_SUMMARY', sha256: DIGEST }],
        idempotencyKey: 'customs-submission:package:1',
        requestedAt: '2026-10-04T05:00:00.000Z',
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('BINDING');
    expect(result.reasonCode).toBe('RELATIONSHIP_NOT_VERIFIED');
  });

  it('调用方传入 tenantRef：一致可放行，不一致必须 CALLER_TENANT_OVERRIDE_REJECTED', () => {
    const same = resolveCustomsProviderTenantBinding(binding(), query(), 'ptenant:acme-us');
    expect(same.ok).toBe(true);

    const override = resolveCustomsProviderTenantBinding(binding(), query(), 'ptenant:attacker');
    expect(override.ok).toBe(false);
    expect(override.reasonCode).toBe('CALLER_TENANT_OVERRIDE_REJECTED');
    expect(override.providerTenantRef).toBeNull();
  });

  it('tenant isolation：跨租户查询不可能命中别人的绑定', () => {
    const isolation = resolveCustomsProviderTenantBinding(
      binding({ organizationId: 'org:other' }),
      query({ organizationId: 'org:acme' }),
    );
    expect(isolation.ok).toBe(false);
    expect(isolation.reasonCode).toBe('TENANT_ISOLATION_VIOLATION');
    expect(isolation.providerTenantRef).toBeNull();
  });

  it('多账号：bindingScopeKey 是 versioned、server-derived、immutable 的稳定身份', () => {
    const key = computeProviderBindingScopeKey({
      principalRef: 'ior:acme',
      jurisdictionAnchor: 'US',
      bindingSlotRef: 'slot:acme-us-1',
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // 稳定：同输入同结果。
    expect(
      computeProviderBindingScopeKey({
        principalRef: 'ior:acme',
        jurisdictionAnchor: 'US',
        bindingSlotRef: 'slot:acme-us-1',
      }),
    ).toBe(key);
    // 对 principal / jurisdictionAnchor / slot 敏感。
    expect(
      computeProviderBindingScopeKey({
        principalRef: 'ior:other',
        jurisdictionAnchor: 'US',
        bindingSlotRef: 'slot:acme-us-1',
      }),
    ).not.toBe(key);
    expect(
      computeProviderBindingScopeKey({
        principalRef: 'ior:acme',
        jurisdictionAnchor: '*',
        bindingSlotRef: 'slot:acme-us-1',
      }),
    ).not.toBe(key);
    expect(
      computeProviderBindingScopeKey({
        principalRef: 'ior:acme',
        jurisdictionAnchor: 'US',
        bindingSlotRef: 'slot:acme-us-2',
      }),
    ).not.toBe(key);
    // 非法输入 fail-closed。
    expect(() =>
      computeProviderBindingScopeKey({
        principalRef: '',
        jurisdictionAnchor: 'US',
        bindingSlotRef: 'slot:x',
      }),
    ).toThrow('INVALID_BINDING_SCOPE_INPUT');
    expect(() =>
      computeProviderBindingScopeKey({
        principalRef: 'ior:acme',
        jurisdictionAnchor: 'USA',
        bindingSlotRef: 'slot:x',
      }),
    ).toThrow('INVALID_BINDING_SCOPE_INPUT');
  });

  it('多账号选择：resolver 按 organization + provider + principalRef 选，绝不拿“第一条 provider binding”', async () => {
    const resolver = createInMemoryCustomsProviderTenantBindingResolver([
      binding({ principalRef: 'ior:acme', providerTenantRef: 'ptenant:acme-us' }),
      binding({ principalRef: 'ior:acme-ca', providerTenantRef: 'ptenant:acme-ca' }),
    ]);

    const us = await resolver.resolve(query({ principalRef: 'ior:acme' }));
    expect(us.ok).toBe(true);
    expect(us.providerTenantRef).toBe('ptenant:acme-us');

    const ca = await resolver.resolve(query({ principalRef: 'ior:acme-ca' }));
    expect(ca.ok).toBe(true);
    expect(ca.providerTenantRef).toBe('ptenant:acme-ca');

    // 该租户下没有这个 principal 的绑定 → BINDING_UNKNOWN（不退化成“随便拿一条”）。
    const unknown = await resolver.resolve(query({ principalRef: 'ior:acme-mx' }));
    expect(unknown.ok).toBe(false);
    expect(unknown.reasonCode).toBe('BINDING_UNKNOWN');
  });

  it('多账号歧义：同一 principal + provider + 辖区存在两条适用绑定 → BINDING_AMBIGUOUS（fail-closed）', async () => {
    const resolver = createInMemoryCustomsProviderTenantBindingResolver([
      binding({ bindingSlotRef: 'slot:a', bindingScopeKey: 'c'.repeat(64) }),
      binding({ bindingSlotRef: 'slot:b', bindingScopeKey: 'd'.repeat(64) }),
    ]);
    const ambiguous = await resolver.resolve(query());
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.reasonCode).toBe('BINDING_AMBIGUOUS');
    expect(ambiguous.providerTenantRef).toBeNull();
    expect(ambiguous.nextAction).toBeNull();
  });

  it('principal 不匹配：纯函数层面 PRINCIPAL_MISMATCH；query 缺 principalRef → INVALID_QUERY', async () => {
    const mismatch = resolveCustomsProviderTenantBinding(binding(), {
      organizationId: 'org:acme',
      providerId: 'provider:customs-a',
      jurisdiction: 'US',
      principalRef: 'ior:someone-else',
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reasonCode).toBe('PRINCIPAL_MISMATCH');

    const resolver = createInMemoryCustomsProviderTenantBindingResolver([binding()]);
    const invalid = await resolver.resolve({
      organizationId: 'org:acme',
      providerId: 'provider:customs-a',
      jurisdiction: 'US',
    } as never);
    expect(invalid.ok).toBe(false);
    expect(invalid.reasonCode).toBe('INVALID_QUERY');
  });

  it('resolver 端口：按 organizationId 过滤，且不接受违规 query', async () => {
    const resolver = createInMemoryCustomsProviderTenantBindingResolver([
      binding(),
      binding({ organizationId: 'org:other', providerTenantRef: 'ptenant:other-us' }),
    ]);

    const mine = await resolver.resolve(query());
    expect(mine.ok).toBe(true);
    expect(mine.providerTenantRef).toBe('ptenant:acme-us');

    const other = await resolver.resolve(query({ organizationId: 'org:other' }));
    expect(other.providerTenantRef).toBe('ptenant:other-us');

    const unknownOrg = await resolver.resolve(query({ organizationId: 'org:nobody' }));
    expect(unknownOrg.ok).toBe(false);
    expect(unknownOrg.reasonCode).toBe('BINDING_UNKNOWN');

    const badQuery = await resolver.resolve(query({ jurisdiction: 'us' }));
    expect(badQuery.ok).toBe(false);
    expect(badQuery.reasonCode).toBe('INVALID_QUERY');
  });

  it('bindCustomsProviderSubmissionRequest：tenantRef 只能来自 server-derived 绑定', async () => {
    const resolver = createInMemoryCustomsProviderTenantBindingResolver([binding()]);
    const draft = {
      principalRef: 'ior:acme',
      jurisdiction: 'US',
      remedy: 'DRAWBACK',
      brokerRef: 'broker:a',
      poaRef: 'evidence:poa',
      signerRef: null,
      filingAuthorized: true,
      packageRef: 'package:1',
      packageDigest: DIGEST,
      evidenceRefs: [{ evidenceRef: 'evidence:entry', documentKind: 'ENTRY_SUMMARY', sha256: DIGEST }],
      idempotencyKey: 'customs-submission:package:1',
      requestedAt: '2026-10-04T05:00:00.000Z',
    };

    const bound = await bindCustomsProviderSubmissionRequest({
      resolver,
      organizationId: 'org:acme',
      providerId: 'provider:customs-a',
      entitlement: 'CROSSCLAIM_SAAS',
      draft,
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.envelope.request.tenantRef).toBe('ptenant:acme-us');
    expect(bound.envelope.transportEnabled).toBe(false);
    expect(bound.envelope.externalWritePerformed).toBe(false);

    const overridden = await bindCustomsProviderSubmissionRequest({
      resolver,
      organizationId: 'org:acme',
      providerId: 'provider:customs-a',
      entitlement: 'CROSSCLAIM_SAAS',
      callerTenantRef: 'ptenant:attacker',
      draft,
    });
    expect(overridden.ok).toBe(false);
    if (overridden.ok) return;
    expect(overridden.stage).toBe('BINDING');
    expect(overridden.reasonCode).toBe('CALLER_TENANT_OVERRIDE_REJECTED');
  });

  it('绑定关系与所需 entitlement 不一致时不得构造提交请求（矩阵 #12 承载位）', async () => {
    const resolver = createInMemoryCustomsProviderTenantBindingResolver([
      binding({ relationship: 'BROKER_OF_RECORD' }),
    ]);
    const result = await bindCustomsProviderSubmissionRequest({
      resolver,
      organizationId: 'org:acme',
      providerId: 'provider:customs-a',
      entitlement: 'CROSSCLAIM_SAAS',
      draft: {
        principalRef: 'ior:acme',
        jurisdiction: 'US',
        remedy: 'DRAWBACK',
        filingAuthorized: true,
        packageRef: 'package:1',
        packageDigest: DIGEST,
        evidenceRefs: [{ evidenceRef: 'evidence:entry', documentKind: 'ENTRY_SUMMARY', sha256: DIGEST }],
        idempotencyKey: 'customs-submission:package:1',
        requestedAt: '2026-10-04T05:00:00.000Z',
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('BINDING');
  });

  it('绑定不存在时：binding 阶段 fail-closed，且不产生 DTO 请求', async () => {
    const resolver = createInMemoryCustomsProviderTenantBindingResolver([]);
    const result = await bindCustomsProviderSubmissionRequest({
      resolver,
      organizationId: 'org:acme',
      providerId: 'provider:customs-a',
      entitlement: 'CROSSCLAIM_SAAS',
      draft: {
        principalRef: 'ior:acme',
        jurisdiction: 'US',
        remedy: 'DRAWBACK',
        filingAuthorized: true,
        packageRef: 'package:1',
        packageDigest: DIGEST,
        evidenceRefs: [{ evidenceRef: 'evidence:entry', documentKind: 'ENTRY_SUMMARY', sha256: DIGEST }],
        idempotencyKey: 'customs-submission:package:1',
        requestedAt: '2026-10-04T05:00:00.000Z',
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('BINDING');
    expect(result.reasonCode).toBe('BINDING_UNKNOWN');
  });

  it('lineage 只追加：新对象不影响旧账本，摘要随内容变化', () => {
    const before = binding();
    const after = appendCustomsProviderTenantLineage(before, {
      event: 'REAUTH_REQUIRED',
      at: '2026-10-04T06:00:00.000Z',
      actorRef: 'actor:provider-webhook',
      note: 'protest window reopened',
    });

    expect(before.lineage).toHaveLength(1);
    expect(after.lineage).toHaveLength(2);
    expect(after).not.toBe(before);
    expect(customsProviderTenantLineageDigest(after.lineage)).not.toBe(
      customsProviderTenantLineageDigest(before.lineage),
    );

    expect(() =>
      appendCustomsProviderTenantLineage(before, {
        event: 'NOT_AN_EVENT' as never,
        at: '2026-10-04T06:00:00.000Z',
        actorRef: 'actor:ops',
        note: null,
      }),
    ).toThrow('INVALID_LINEAGE_EVENT');
  });

  it('边界自证：C18-6 离线层不读凭据、不写外部、不改 provider 账号', () => {
    expect(CUSTOMS_PROVIDER_TENANT_BINDING_BOUNDARY).toEqual({
      externalWritePerformed: false,
      filingSubmitted: false,
      transportEnabled: false,
      providerAccountMutationPerformed: false,
      credentialReadPerformed: false,
      productionCredentials: 'ABSENT',
    });
  });
});
