/** CA-4 单元验收：BrokerAuthorizationSession 状态机 + 引用/Opaque 校验 + VERIFIED 证据门槛 + POA 生成契约。 */

import { describe, expect, it } from 'vitest';

import {
  BROKER_AUTHORIZATION_SESSION_TRANSITIONS,
  BrokerAuthorizationSessionError,
  brokerAuthorizationSessionToPoaAppend,
  createBrokerAuthorizationSession,
  transitionBrokerAuthorizationSession,
  type BrokerAuthorizationSession,
} from '../services/customs/broker-authorization-session';

const base = () => ({
  sessionId: 'session-1',
  organizationId: 'org-1',
  principalRef: 'ior:acme',
  brokerRef: 'broker:1',
  providerRef: 'provider:fixture',
  jurisdiction: 'US',
  requestedScope: ['DUTY_REFUND'],
  externalAuthorizationUrlRef: 'provider-portal:session-1',
  now: new Date('2026-10-04T00:00:00.000Z'),
});

const verified = (): BrokerAuthorizationSession => {
  let session = createBrokerAuthorizationSession(base());
  session = transitionBrokerAuthorizationSession(session, 'CUSTOMER_ACTION_REQUIRED', {
    at: new Date('2026-10-04T00:01:00.000Z'),
  });
  session = transitionBrokerAuthorizationSession(session, 'SIGNED', { at: new Date('2026-10-04T00:02:00.000Z') });
  session = transitionBrokerAuthorizationSession(session, 'PROVIDER_VERIFYING', {
    at: new Date('2026-10-04T00:03:00.000Z'),
  });
  return transitionBrokerAuthorizationSession(session, 'VERIFIED', {
    at: new Date('2026-10-04T00:04:00.000Z'),
    verificationSource: 'PROVIDER_EVIDENCE',
    providerAuthorizationRef: 'provider-auth:abc',
    evidenceArtifactRef: 'evidence:poa',
  });
};

describe('CA-4 — broker authorization session contract（unit）', () => {
  it('创建会话为 CREATED，且 server-derived digest 稳定', () => {
    const a = createBrokerAuthorizationSession(base());
    const b = createBrokerAuthorizationSession(base());
    expect(a.status).toBe('CREATED');
    expect(a.contentDigest).toBe(b.contentDigest);
    expect(a.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.completedAt).toBeNull();
  });

  it('裸 URL / 非法引用 / 非法 scope / 非法辖区 → fail-closed', () => {
    expect(() =>
      createBrokerAuthorizationSession({ ...base(), externalAuthorizationUrlRef: 'https://broker.example/authorize' }),
    ).toThrow(BrokerAuthorizationSessionError);
    expect(() => createBrokerAuthorizationSession({ ...base(), principalRef: '12-3456789' })).toThrow();
    expect(() => createBrokerAuthorizationSession({ ...base(), requestedScope: ['lowercase'] })).toThrow();
    expect(() => createBrokerAuthorizationSession({ ...base(), jurisdiction: 'USA' })).toThrow();
  });

  it('状态机只允许白名单迁移，终态不可迁出', () => {
    const created = createBrokerAuthorizationSession(base());
    expect(() => transitionBrokerAuthorizationSession(created, 'VERIFIED')).toThrow(
      BrokerAuthorizationSessionError,
    );
    expect(BROKER_AUTHORIZATION_SESSION_TRANSITIONS.VERIFIED).toEqual([]);
    expect(BROKER_AUTHORIZATION_SESSION_TRANSITIONS.REVOKED).toEqual([]);
    const revoked = transitionBrokerAuthorizationSession(created, 'REVOKED', {
      at: new Date('2026-10-04T00:05:00.000Z'),
    });
    expect(revoked.status).toBe('REVOKED');
    expect(() => transitionBrokerAuthorizationSession(revoked, 'SIGNED')).toThrow();
  });

  it('VERIFIED 必须有 server/provider 证据（client 不得自报）', () => {
    let session = createBrokerAuthorizationSession(base());
    session = transitionBrokerAuthorizationSession(session, 'SIGNED');
    expect(() => transitionBrokerAuthorizationSession(session, 'VERIFIED')).toThrow(
      BrokerAuthorizationSessionError,
    );
    expect(() =>
      transitionBrokerAuthorizationSession(session, 'VERIFIED', { verificationSource: 'PROVIDER_EVIDENCE' }),
    ).toThrow();
  });

  it('VERIFIED 会话 → 生成 append-only POA 输入（幂等键=sessionId）', () => {
    const session = verified();
    expect(session.status).toBe('VERIFIED');
    expect(session.completedAt).not.toBeNull();
    const append = brokerAuthorizationSessionToPoaAppend(session);
    expect(append.subject).toBe('BROKER_POA');
    expect(append.idempotencyKey).toBe('broker-authorization-session:session-1');
    expect(append.evidenceArtifactRef).toBe('evidence:poa');
    expect(append.verificationSource).toBe('BROKER_ATTESTATION');
  });

  it('非 VERIFIED 会话不得生成 POA 事实', () => {
    const created = createBrokerAuthorizationSession(base());
    expect(() => brokerAuthorizationSessionToPoaAppend(created)).toThrow(BrokerAuthorizationSessionError);
  });
});
