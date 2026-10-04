/**
 * C18-8 — NEGATIVE-PATH SANDBOX E2E（Layer 3 / P0，离线）
 * ---------------------------------------------------------------
 * 把 C18-2 DTO / C18-3 沙盒 provider / C18-5 对账 / C18-6 tenant binding /
 * C18-7 授权生命周期 / C18-8 webhook atomic durable claim 串成负路径端到端验收：
 *   · 跨租户读取必须 CROSS_TENANT_ACCESS；
 *   · 同 key 同 payload = replay（同一 providerSubmissionId），同 key 不同 payload = CONFLICT；
 *   · 无绑定 / 调用方覆盖 tenantRef ⇒ 在任何 provider 调用之前 fail-closed；
 *   · 写操作 AMBIGUOUS ⇒ 必须对账、绝不盲重发（assertResubmitAllowed 抛错）；
 *   · webhook 重放 ⇒ 并发同名 deliveryId 只有一个 CLAIMED，坏签名不产生 claim；
 *   · provider 授权 REVOKED ⇒ 提交前置条件拒绝，且沙盒里不产生任何 submission。
 */

import { describe, expect, it } from 'vitest';

import {
  claimVerifiedProviderWebhookDelivery,
  createInMemoryProviderWebhookReplayClaimStore,
} from '../services/customs/customs-provider-webhook-replay-claim';
import { computeProviderWebhookSignature } from '../services/customs/customs-provider-webhook';
import {
  assertResubmitAllowed,
  buildProviderReconciliationPlan,
  canAutoRetry,
  classifyProviderOutcome,
  nextRetryDelayMs,
  ProviderBlindRetryError,
  ProviderRetryExhaustedError,
} from '../services/customs/customs-provider-reconciliation';
import {
  bindCustomsProviderSubmissionRequest,
  createInMemoryCustomsProviderTenantBindingResolver,
  type CustomsProviderTenantBinding,
} from '../services/customs/customs-provider-tenant-binding';
import {
  deriveProviderAuthorizationState,
  evaluateProviderSubmissionPrecondition,
} from '../services/customs/customs-provider-authorization-lifecycle';
import { createSandboxFilingProvider } from '../services/customs/customs-sandbox-filing-provider';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const NOW = new Date('2026-10-04T06:00:00.000Z');
const SECRET = 'sandbox-webhook-secret';

const binding = (overrides: Partial<CustomsProviderTenantBinding> = {}): CustomsProviderTenantBinding => ({
  organizationId: 'org:acme',
  providerId: 'provider:customs-a',
  providerTenantRef: 'ptenant:acme-us',
  providerAccountRef: 'paccount:broker-a',
  relationship: 'CROSSCLAIM_SAAS',
  relationshipEvidenceRef: 'evidence:saas-agreement-v1',
  relationshipVerifiedAt: '2026-10-04T05:00:00.000Z',
  jurisdictionScope: ['US'],
  status: 'ACTIVE',
  verifiedAt: '2026-10-04T05:00:00.000Z',
  credentialReference: 'credref:slot-1',
  lineage: [{ event: 'BOUND', at: '2026-10-04T05:00:00.000Z', actorRef: 'actor:ops', note: null }],
  ...overrides,
});

const draft = (packageDigest = DIGEST_A) => ({
  principalRef: 'ior:acme',
  jurisdiction: 'US',
  remedy: 'DRAWBACK',
  brokerRef: 'broker:a',
  poaRef: 'evidence:poa',
  signerRef: null,
  filingAuthorized: true as const,
  packageRef: 'package:1',
  packageDigest,
  evidenceRefs: [{ evidenceRef: 'evidence:entry', documentKind: 'ENTRY_SUMMARY', sha256: DIGEST_A }],
  idempotencyKey: 'customs-submission:package:1',
  requestedAt: '2026-10-04T05:00:00.000Z',
});

const createInput = (packageDigest = DIGEST_A) => ({
  organizationId: 'org:acme',
  opportunityId: 'opportunity:1',
  claimItemId: 'claim-item:1',
  packageId: 'package:1',
  packageDigest,
  jurisdiction: 'US',
  remedyType: 'DRAWBACK',
  idempotencyKey: 'customs-submission:package:1',
});

describe('C18-8 — negative-path sandbox E2E', () => {
  it('正常路径：server-derived tenantRef 绑定成功后可提交；同 key 同 payload 是 replay', async () => {
    const resolver = createInMemoryCustomsProviderTenantBindingResolver([binding()]);
    const bound = await bindCustomsProviderSubmissionRequest({
      resolver,
      organizationId: 'org:acme',
      providerId: 'provider:customs-a',
      entitlement: 'CROSSCLAIM_SAAS',
      draft: draft(),
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.envelope.request.tenantRef).toBe('ptenant:acme-us');

    const provider = createSandboxFilingProvider({ now: () => NOW });
    const first = await provider.createSubmission(createInput());
    const replay = await provider.createSubmission(createInput());
    expect(replay.providerSubmissionId).toBe(first.providerSubmissionId);
    expect(provider.listSubmissions('org:acme')).toHaveLength(1);
  });

  it('跨租户：另一个 organizationId 读取/推进别人的 submission 必须 CROSS_TENANT_ACCESS', async () => {
    const provider = createSandboxFilingProvider({ now: () => NOW });
    const created = await provider.createSubmission(createInput());
    await expect(
      (async () =>
        provider.advanceStatus({
          organizationId: 'org:other',
          providerSubmissionId: created.providerSubmissionId,
          status: 'ACCEPTED',
        }))(),
    ).rejects.toThrow('CROSS_TENANT_ACCESS');
    await expect(
      (async () =>
        provider.getSubmissionStatus({
          organizationId: 'org:other',
          providerSubmissionId: created.providerSubmissionId,
        }))(),
    ).rejects.toThrow('CROSS_TENANT_ACCESS');
  });

  it('幂等冲突：同 idempotencyKey + 不同 payloadDigest 必须 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const provider = createSandboxFilingProvider({ now: () => NOW });
    await provider.createSubmission(createInput(DIGEST_A));
    await expect(provider.createSubmission(createInput(DIGEST_B))).rejects.toThrow('IDEMPOTENCY_KEY_CONFLICT');
    expect(provider.listSubmissions('org:acme')).toHaveLength(1);
  });

  it('无绑定 / 调用方覆盖 tenantRef：在任何 provider 调用之前就 fail-closed', async () => {
    const empty = createInMemoryCustomsProviderTenantBindingResolver([]);
    const provider = createSandboxFilingProvider({ now: () => NOW });

    const unknown = await bindCustomsProviderSubmissionRequest({
      resolver: empty,
      organizationId: 'org:acme',
      providerId: 'provider:customs-a',
      entitlement: 'CROSSCLAIM_SAAS',
      draft: draft(),
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.stage).toBe('BINDING');
    expect(unknown.reasonCode).toBe('BINDING_UNKNOWN');

    const resolver = createInMemoryCustomsProviderTenantBindingResolver([binding()]);
    const override = await bindCustomsProviderSubmissionRequest({
      resolver,
      organizationId: 'org:acme',
      providerId: 'provider:customs-a',
      entitlement: 'CROSSCLAIM_SAAS',
      callerTenantRef: 'ptenant:attacker',
      draft: draft(),
    });
    expect(override.ok).toBe(false);
    if (override.ok) return;
    expect(override.reasonCode).toBe('CALLER_TENANT_OVERRIDE_REJECTED');

    // 两条负路径都没有产生任何 provider submission。
    expect(provider.listSubmissions('org:acme')).toHaveLength(0);
  });

  it('写操作 AMBIGUOUS：必须对账、绝不盲重发；只读 5xx 才可自动重试', () => {
    const ambiguous = classifyProviderOutcome(
      { httpStatus: 500, transportCompleted: true },
      { operation: 'CREATE_SUBMISSION' },
    );
    expect(ambiguous).toBe('AMBIGUOUS');
    expect(classifyProviderOutcome({ httpStatus: 500, transportCompleted: true }, {
      operation: 'CREATE_SUBMISSION',
      idempotencySemantics: 'REPLAY_SAFE',
    })).toBe('RETRYABLE');
    expect(
      classifyProviderOutcome({ httpStatus: 500, transportCompleted: true }, { operation: 'GET_SUBMISSION_STATUS' }),
    ).toBe('RETRYABLE');
    expect(
      classifyProviderOutcome({ httpStatus: null, transportCompleted: false }, { operation: 'CREATE_SUBMISSION' }),
    ).toBe('AMBIGUOUS');
    expect(
      classifyProviderOutcome(
        { httpStatus: 409, transportCompleted: true, errorCode: 'IDEMPOTENCY_KEY_CONFLICT' },
        { operation: 'CREATE_SUBMISSION' },
      ),
    ).toBe('CONFLICT');

    const plan = buildProviderReconciliationPlan({ operation: 'CREATE_SUBMISSION', outcome: ambiguous });
    expect(plan.required).toBe(true);
    expect(plan.actions).toEqual([
      'LOOKUP_BY_IDEMPOTENCY_KEY',
      'COMPARE_PAYLOAD_DIGEST',
      'ADOPT_EXISTING_ON_MATCH',
      'MARK_CONFLICT_ON_MISMATCH',
      'NEVER_RESUBMIT_BLIND',
    ]);
    expect(plan.resubmitAllowed).toBe(false);
    expect(() => assertResubmitAllowed({ operation: 'CREATE_SUBMISSION', outcome: ambiguous })).toThrow(
      ProviderBlindRetryError,
    );
    expect(canAutoRetry({ operation: 'CREATE_SUBMISSION', attempt: 1, outcome: ambiguous })).toBe(false);
  });

  it('重试上限是真上限：超过 maxAttempts 一律拒绝并抛 RETRY_EXHAUSTED', () => {
    expect(canAutoRetry({ operation: 'CREATE_SUBMISSION', attempt: 99, outcome: 'RETRYABLE' })).toBe(false);
    expect(() => nextRetryDelayMs({ operation: 'CREATE_SUBMISSION', attempt: 99 })).toThrow(
      ProviderRetryExhaustedError,
    );
    expect(() =>
      assertResubmitAllowed({ operation: 'CREATE_SUBMISSION', outcome: 'PERMANENT_FAILURE' }),
    ).toThrow(/PROVIDER_OUTCOME_NOT_RETRYABLE/);
  });

  it('webhook atomic durable claim：并发相同 deliveryId 只有一个 CLAIMED，坏签名不产生 claim', async () => {
    const store = createInMemoryProviderWebhookReplayClaimStore();
    const rawBody = JSON.stringify({ eventType: 'SUBMISSION_STATUS', providerSubmissionId: 'psub:1' });
    const timestampSeconds = Math.floor(NOW.getTime() / 1000);
    const headers = {
      'x-cc-signature': computeProviderWebhookSignature({ secret: SECRET, timestampSeconds, rawBody }),
      'x-cc-timestamp': String(timestampSeconds),
      'x-cc-delivery-id': 'delivery:1',
    };

    const [a, b] = await Promise.all([
      claimVerifiedProviderWebhookDelivery({
        providerId: 'provider:customs-a',
        rawBody,
        headers,
        secret: SECRET,
        claimStore: store,
        now: NOW,
      }),
      claimVerifiedProviderWebhookDelivery({
        providerId: 'provider:customs-a',
        rawBody,
        headers,
        secret: SECRET,
        claimStore: store,
        now: NOW,
      }),
    ]);
    const outcomes = [a, b].map((result) => (result.ok ? 'CLAIMED' : result.code)).sort();
    expect(outcomes).toEqual(['CLAIMED', 'REPLAY_DETECTED']);
    expect(store.size()).toBe(1);

    const third = await claimVerifiedProviderWebhookDelivery({
      providerId: 'provider:customs-a',
      rawBody,
      headers,
      secret: SECRET,
      claimStore: store,
      now: NOW,
    });
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.code).toBe('REPLAY_DETECTED');

    const badSignature = await claimVerifiedProviderWebhookDelivery({
      providerId: 'provider:customs-a',
      rawBody,
      headers: { ...headers, 'x-cc-signature': 'f'.repeat(64), 'x-cc-delivery-id': 'delivery:2' },
      secret: SECRET,
      claimStore: store,
      now: NOW,
    });
    expect(badSignature.ok).toBe(false);
    if (badSignature.ok) return;
    expect(badSignature.code).toBe('INVALID_SIGNATURE');
    // 坏签名不得烧掉 deliveryId（否则合法重投会被判成 replay）。
    expect(store.has('provider:customs-a', 'delivery:2')).toBe(false);
  });

  it('provider 授权 REVOKED：提交前置条件拒绝，沙盒中不产生 submission', async () => {
    const provider = createSandboxFilingProvider({ now: () => NOW });
    const state = deriveProviderAuthorizationState(
      [
        {
          providerId: 'provider:customs-a',
          providerAuthorizationRef: 'pauth:acme-1',
          organizationId: 'org:acme',
          principalRef: 'ior:acme',
          kind: 'GRANTED',
          effectiveAt: '2026-10-01T00:00:00.000Z',
          observedAt: '2026-10-01T00:00:05.000Z',
          expiresAt: '2027-10-01T00:00:00.000Z',
          reasonCode: null,
          sourceRef: 'webhook:delivery-1',
        },
        {
          providerId: 'provider:customs-a',
          providerAuthorizationRef: 'pauth:acme-1',
          organizationId: 'org:acme',
          principalRef: 'ior:acme',
          kind: 'REVOKED',
          effectiveAt: '2026-10-03T00:00:00.000Z',
          observedAt: '2026-10-03T00:00:01.000Z',
          reasonCode: 'PROVIDER_REVOKED',
          sourceRef: 'webhook:delivery-2',
        },
      ],
      NOW,
    );
    const precondition = evaluateProviderSubmissionPrecondition({
      internal: { status: 'VERIFIED' },
      provider: state,
      now: NOW,
    });
    expect(precondition.allowed).toBe(false);
    expect(precondition.reasonCode).toBe('PROVIDER_AUTHORIZATION_REVOKED');
    expect(precondition.requiredAction).toBe('RE_SIGN_POA');

    if (precondition.allowed) await provider.createSubmission(createInput());
    expect(provider.listSubmissions('org:acme')).toHaveLength(0);
  });
});
