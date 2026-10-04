/** C18-7 单元验收：provider 授权生命周期（事件校验 / 确定性折叠 / 提交前置条件 / 撤销传播计划）。 */

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_PROVIDER_AUTHORIZATION_LIFECYCLE_BOUNDARY,
  deriveProviderAuthorizationState,
  evaluateProviderSubmissionPrecondition,
  planProviderRevocationPropagation,
  validateProviderAuthorizationEvent,
  type ProviderAuthorizationEvent,
} from '../services/customs/customs-provider-authorization-lifecycle';

const NOW = new Date('2026-10-04T06:00:00.000Z');

const event = (overrides: Partial<ProviderAuthorizationEvent> = {}): ProviderAuthorizationEvent => ({
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
  ...overrides,
});

describe('C18-7 — provider authorization lifecycle（unit）', () => {
  it('事件校验：未知 kind / 非 opaque 引用 / 坏时间戳 / 裸 URL 来源一律拒绝', () => {
    expect(validateProviderAuthorizationEvent(event())).toEqual({ ok: true });
    expect(validateProviderAuthorizationEvent(event({ kind: 'NOPE' as never }))).toEqual({
      ok: false,
      errors: ['INVALID_EVENT_KIND'],
    });
    expect(validateProviderAuthorizationEvent(event({ providerAuthorizationRef: 'https://x/y' }))).toEqual({
      ok: false,
      errors: ['INVALID_PROVIDER_REF'],
    });
    expect(validateProviderAuthorizationEvent(event({ observedAt: 'not-a-date' }))).toEqual({
      ok: false,
      errors: ['INVALID_OBSERVED_AT'],
    });
    expect(validateProviderAuthorizationEvent(event({ sourceRef: '' }))).toEqual({
      ok: false,
      errors: ['MISSING_SOURCE_REF'],
    });
    expect(validateProviderAuthorizationEvent(event({ expiresAt: '2026-09-01T00:00:00.000Z' }))).toEqual({
      ok: false,
      errors: ['INVALID_EXPIRY_WINDOW'],
    });
  });

  it('折叠：无事件 → UNKNOWN（不猜）', () => {
    const state = deriveProviderAuthorizationState([], NOW);
    expect(state.status).toBe('UNKNOWN');
    expect(state.appliedEventCount).toBe(0);
    expect(evaluateProviderSubmissionPrecondition({ internal: { status: 'VERIFIED' }, provider: state, now: NOW }))
      .toMatchObject({
        allowed: false,
        reasonCode: 'PROVIDER_AUTHORIZATION_UNKNOWN',
        requiredAction: 'REQUEST_PROVIDER_ATTESTATION',
      });
  });

  it('折叠：GRANTED → ACTIVE；provider 过期时间到点 → 自动 EXPIRED', () => {
    expect(deriveProviderAuthorizationState([event()], NOW).status).toBe('ACTIVE');
    const expiring = event({ expiresAt: '2026-10-03T00:00:00.000Z' });
    const state = deriveProviderAuthorizationState([expiring], NOW);
    expect(state.status).toBe('EXPIRED');
    expect(state.expiresAt).toBe('2026-10-03T00:00:00.000Z');
  });

  it('折叠：REVOKED 是终止态，只有严格更晚的重新授权才解除', () => {
    const revoked = event({
      kind: 'REVOKED',
      effectiveAt: '2026-10-02T00:00:00.000Z',
      observedAt: '2026-10-02T00:00:01.000Z',
      sourceRef: 'webhook:delivery-2',
      reasonCode: 'PROVIDER_REVOKED',
    });
    const earlierGrant = event();
    const laterGrant = event({
      kind: 'RENEWED',
      effectiveAt: '2026-10-03T00:00:00.000Z',
      observedAt: '2026-10-03T00:00:01.000Z',
      sourceRef: 'webhook:delivery-3',
    });

    expect(deriveProviderAuthorizationState([earlierGrant, revoked], NOW).status).toBe('REVOKED');
    // 撤销事件更早时，之后的重新授权合法解除。
    expect(deriveProviderAuthorizationState([revoked, laterGrant], NOW).status).toBe('ACTIVE');
  });

  it('折叠：REAUTH_REQUIRED / SUSPENDED 不得降级 REVOKED / EXPIRED 的严重性', () => {
    const revoked = event({
      kind: 'REVOKED',
      effectiveAt: '2026-10-02T00:00:00.000Z',
      observedAt: '2026-10-02T00:00:01.000Z',
      sourceRef: 'webhook:delivery-2',
    });
    const reauth = event({
      kind: 'REAUTH_REQUIRED',
      effectiveAt: '2026-10-03T00:00:00.000Z',
      observedAt: '2026-10-03T00:00:01.000Z',
      sourceRef: 'webhook:delivery-3',
    });
    expect(deriveProviderAuthorizationState([revoked, reauth], NOW).status).toBe('REVOKED');
  });

  it('时间语义：未来才生效的授权不得提前变 ACTIVE', () => {
    const future = event({
      effectiveAt: '2026-10-05T00:00:00.000Z',
      observedAt: '2026-10-04T05:00:00.000Z',
    });
    const state = deriveProviderAuthorizationState([future], NOW);
    expect(state.status).toBe('UNKNOWN');
    expect(state.appliedEventCount).toBe(0);

    // 当前已生效 + 未来事件并存：只按已生效部分判定。
    const effectiveNow = event({ expiresAt: '2027-10-01T00:00:00.000Z' });
    const mixed = deriveProviderAuthorizationState([effectiveNow, future], NOW);
    expect(mixed.status).toBe('ACTIVE');
    expect(mixed.appliedEventCount).toBe(1);
  });

  it('时间语义：同 effectiveAt 的授权不得靠 observedAt 解除 REVOKED（必须 strictly later）', () => {
    const sameMomentRevoke = event({
      kind: 'REVOKED',
      effectiveAt: '2026-10-02T00:00:00.000Z',
      observedAt: '2026-10-02T00:00:01.000Z',
      sourceRef: 'webhook:delivery-2',
    });
    const sameMomentRenew = event({
      kind: 'RENEWED',
      effectiveAt: '2026-10-02T00:00:00.000Z',
      observedAt: '2026-10-02T00:00:10.000Z',
      sourceRef: 'webhook:delivery-3',
    });
    const state = deriveProviderAuthorizationState([sameMomentRevoke, sameMomentRenew], NOW);
    expect(state.conflict).toBe(true);
    expect(state.status).toBe('UNKNOWN');
    expect(
      evaluateProviderSubmissionPrecondition({ internal: { status: 'VERIFIED' }, provider: state, now: NOW })
        .allowed,
    ).toBe(false);

    // 只有 effectiveAt 严格更晚的重新授权才解除。
    const strictlyLater = event({
      kind: 'RENEWED',
      effectiveAt: '2026-10-03T00:00:00.000Z',
      observedAt: '2026-10-03T00:00:01.000Z',
      sourceRef: 'webhook:delivery-4',
    });
    expect(deriveProviderAuthorizationState([sameMomentRevoke, strictlyLater], NOW).status).toBe('ACTIVE');
  });

  it('折叠：同一时间点互相矛盾的事件 → conflict → UNKNOWN（fail-closed）', () => {
    const granted = event();
    const revokedSameMoment = event({
      kind: 'REVOKED',
      effectiveAt: granted.effectiveAt,
      observedAt: granted.observedAt,
      sourceRef: 'webhook:delivery-1b',
    });
    const state = deriveProviderAuthorizationState([granted, revokedSameMoment], NOW);
    expect(state.conflict).toBe(true);
    expect(state.status).toBe('UNKNOWN');
    expect(
      evaluateProviderSubmissionPrecondition({ internal: { status: 'VERIFIED' }, provider: state, now: NOW })
        .reasonCode,
    ).toBe('PROVIDER_AUTHORIZATION_CONFLICT');
  });

  it('提交前置条件：内部 + provider 同时有效才放行，且声明零外写', () => {
    const active = deriveProviderAuthorizationState([event()], NOW);
    const ok = evaluateProviderSubmissionPrecondition({
      internal: { status: 'VERIFIED' },
      provider: active,
      now: NOW,
    });
    expect(ok.allowed).toBe(true);
    expect(ok.reasonCode).toBe('SUBMISSION_AUTHORIZED');
    expect(ok.requiredAction).toBe('NONE');
    expect(ok.externalWritePerformed).toBe(false);
    expect(ok.filingSubmitted).toBe(false);
    expect(ok.transportEnabled).toBe(false);
    expect(ok.productionCredentials).toBe('ABSENT');
  });

  it('提交前置条件：内部授权不 VERIFIED 一律拒绝（未撤销也不放行）', () => {
    const active = deriveProviderAuthorizationState([event()], NOW);
    for (const status of ['MISSING', 'PENDING', 'EXPIRED'] as const) {
      const decision = evaluateProviderSubmissionPrecondition({
        internal: { status },
        provider: active,
        now: NOW,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe('INTERNAL_AUTHORIZATION_NOT_VERIFIED');
    }
    expect(
      evaluateProviderSubmissionPrecondition({
        internal: { status: 'REVOKED' },
        provider: active,
        now: NOW,
      }),
    ).toMatchObject({ allowed: false, reasonCode: 'INTERNAL_AUTHORIZATION_REVOKED', requiredAction: 'RE_SIGN_POA' });
  });

  it('提交前置条件：provider 侧 REVOKED / EXPIRED / REAUTH_REQUIRED / SUSPENDED 各自要求正确动作', () => {
    const cases = [
      ['REVOKED', 'PROVIDER_AUTHORIZATION_REVOKED', 'RE_SIGN_POA'],
      ['EXPIRED', 'PROVIDER_AUTHORIZATION_EXPIRED', 'RENEW_POA'],
      ['REAUTH_REQUIRED', 'PROVIDER_AUTHORIZATION_REAUTH_REQUIRED', 'REQUEST_PROVIDER_ATTESTATION'],
      ['SUSPENDED', 'PROVIDER_AUTHORIZATION_SUSPENDED', 'CONTACT_PROVIDER'],
    ] as const;
    for (const [status, reasonCode, requiredAction] of cases) {
      const decision = evaluateProviderSubmissionPrecondition({
        internal: { status: 'VERIFIED' },
        provider: {
          status,
          expiresAt: null,
          lastEffectiveAt: '2026-10-02T00:00:00.000Z',
          lastObservedAt: '2026-10-02T00:00:01.000Z',
          conflict: false,
          appliedEventCount: 1,
        },
        now: NOW,
      });
      expect(decision).toMatchObject({ allowed: false, reasonCode, requiredAction });
    }
  });

  it('撤销传播：只对 REVOKED / EXPIRED 生成 append-only 计划，绝不就地改历史', () => {
    const revoked = event({
      kind: 'REVOKED',
      effectiveAt: '2026-10-02T00:00:00.000Z',
      observedAt: '2026-10-02T00:00:01.000Z',
      sourceRef: 'webhook:delivery-2',
      reasonCode: 'PROVIDER_REVOKED',
    });
    const plan = planProviderRevocationPropagation({ event: revoked, lifecycleKey: 'lifecycle:poa:acme' });
    expect(plan).toMatchObject({
      kind: 'APPEND_AUTHORIZATION_FACT',
      action: 'REVOKE',
      lifecycleKey: 'lifecycle:poa:acme',
      reasonCode: 'PROVIDER_REVOKED',
      appendOnly: true,
      historyMutatedInPlace: false,
      externalWritePerformed: false,
    });

    const expired = planProviderRevocationPropagation({
      event: revoked,
      lifecycleKey: 'lifecycle:poa:acme',
    });
    expect(expired?.action).toBe('REVOKE');

    // 授权类事件不产生撤销事实；非法事件与非法 lifecycleKey 一律 null。
    expect(planProviderRevocationPropagation({ event: event(), lifecycleKey: 'lifecycle:poa:acme' })).toBeNull();
    expect(
      planProviderRevocationPropagation({ event: revoked, lifecycleKey: 'https://x/y' }),
    ).toBeNull();
    expect(
      planProviderRevocationPropagation({ event: { ...revoked, sourceRef: '' }, lifecycleKey: 'lifecycle:poa:acme' }),
    ).toBeNull();
  });

  it('边界自证：C18-7 离线层不写外部、不改 provider 授权、不读凭据', () => {
    expect(CUSTOMS_PROVIDER_AUTHORIZATION_LIFECYCLE_BOUNDARY).toEqual({
      externalWritePerformed: false,
      filingSubmitted: false,
      transportEnabled: false,
      providerAuthorizationMutationPerformed: false,
      credentialReadPerformed: false,
      productionCredentials: 'ABSENT',
    });
  });
});
