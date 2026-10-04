/** CA-3 单元验收：append-only 生命周期（GRANT/RENEW/REVOKE）+ server-derived 校验 + 读模型。 */

import { describe, expect, it } from 'vitest';

import {
  AuthorizationLifecycleError,
  appendAuthorizationLifecycle,
  authorizationContentDigest,
  readAuthorizationState,
  type AuthorizationLifecycleStores,
  type PoaFactInsert,
  type SignerFactInsert,
} from '../services/customs/authorization-lifecycle';
import type { AuthorizedSignerRow, BrokerPoaRow } from '../services/customs/customs-authorization-route';

const AT = new Date('2026-10-04T00:00:00.000Z');

function harness() {
  const poa: PoaFactInsert[] = [];
  const signer: SignerFactInsert[] = [];
  let counter = 0;
  const stores: AuthorizationLifecycleStores = {
    async appendPoa(row) {
      counter += 1;
      poa.push(row);
      return { id: 'poa-' + counter };
    },
    async appendSigner(row) {
      counter += 1;
      signer.push(row);
      return { id: 'signer-' + counter };
    },
    async listPoa(organizationId, principalRef, brokerRef): Promise<BrokerPoaRow[]> {
      return poa
        .filter((row) => row.organizationId === organizationId && row.principalRef === principalRef)
        .filter((row) => (brokerRef ? row.brokerRef === brokerRef : true))
        .map((row, index) => ({
          id: 'poa-' + (index + 1),
          principalRef: row.principalRef,
          brokerRef: row.brokerRef,
          jurisdiction: row.jurisdiction,
          authorizationType: row.authorizationType,
          scopeRemedies: row.scopeRemedies,
          effectiveAt: row.effectiveAt,
          expiresAt: row.expiresAt,
          verificationStatus: row.verificationStatus,
          observedAt: row.observedAt,
          contentDigest: row.contentDigest,
        }));
    },
    async listSigner(organizationId, principalRef): Promise<AuthorizedSignerRow[]> {
      return signer
        .filter((row) => row.organizationId === organizationId && row.principalRef === principalRef)
        .map((row, index) => ({
          id: 'signer-' + (index + 1),
          principalRef: row.principalRef,
          signerRef: row.signerRef,
          signerType: row.signerType,
          authorityBasis: row.authorityBasis,
          scopeRemedies: row.scopeRemedies,
          jurisdiction: row.jurisdiction,
          effectiveAt: row.effectiveAt,
          expiresAt: row.expiresAt,
          verificationStatus: row.verificationStatus,
          observedAt: row.observedAt,
          revokedAt: row.revokedAt,
          supersededAt: null,
          contentDigest: row.contentDigest,
        }));
    },
  };
  const clock = { at: AT };
  return {
    stores,
    poa,
    signer,
    deps: { stores, now: () => clock.at },
    advance(ms: number) {
      clock.at = new Date(clock.at.getTime() + ms);
    },
  };
}

const context = {
  customsAgreementSigned: true,
  iorConfirmed: true,
  claimantConfirmed: true,
  recoveryRightForRemedy: true,
  filingPermissionValid: true,
  providerCapabilityReady: true,
  payeeIdentityConfirmed: true,
  refundDestinationVerified: true,
  aceEnrollmentReady: true,
  brokerConnected: true,
};

describe('CA-3 — authorization lifecycle（unit）', () => {
  it('GRANT：追加一条 server-derived VERIFIED 事实（不 UPDATE 历史）', async () => {
    const h = harness();
    const result = await appendAuthorizationLifecycle(
      {
        organizationId: 'org-1',
        actorUserId: 'user-1',
        subject: 'AUTHORIZED_SIGNER',
        action: 'GRANT',
        principalRef: 'ior:acme',
        signerRef: 'person:cfo',
        signerType: 'LEGAL_REPRESENTATIVE',
        authorityBasis: 'board:resolution',
        scope: ['DUTY_REFUND'],
        jurisdiction: 'US',
        evidenceArtifactRef: 'evidence:poa',
        verificationSource: 'CUSTOMER_DOCUMENT',
      },
      h.deps,
    );
    expect(result.lifecycleStatus).toBe('VERIFIED');
    expect(result.serverDerivedFields).toBe(true);
    expect(h.signer).toHaveLength(1);
    expect(h.signer[0]!.observedAt.toISOString()).toBe(AT.toISOString());
    expect(h.signer[0]!.contentDigest).toBe(result.contentDigest);
    expect(authorizationContentDigest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('client 自报授权字段（verificationStatus / contentDigest / observedAt）→ fail-closed', async () => {
    const h = harness();
    for (const field of ['verificationStatus', 'contentDigest', 'observedAt', 'organizationId']) {
      await expect(
        appendAuthorizationLifecycle(
          {
            organizationId: 'org-1',
            actorUserId: 'user-1',
            subject: 'BROKER_POA',
            action: 'GRANT',
            principalRef: 'ior:acme',
            brokerRef: 'broker:1',
            scope: ['DUTY_REFUND'],
            jurisdiction: 'US',
            evidenceArtifactRef: 'evidence:poa',
            verificationSource: 'BROKER_ATTESTATION',
            clientPayload: { [field]: 'CLIENT' },
          },
          h.deps,
        ),
      ).rejects.toBeInstanceOf(AuthorizationLifecycleError);
    }
    expect(h.poa).toHaveLength(0);
  });

  it('scope 非法 / 缺证据 → fail-closed；NONE source → PENDING（不得伪造 VERIFIED）', async () => {
    const h = harness();
    const base = {
      organizationId: 'org-1',
      actorUserId: 'user-1',
      subject: 'BROKER_POA' as const,
      action: 'GRANT' as const,
      principalRef: 'ior:acme',
      brokerRef: 'broker:1',
      jurisdiction: 'US',
      verificationSource: 'BROKER_ATTESTATION' as const,
    };
    await expect(
      appendAuthorizationLifecycle({ ...base, scope: ['lowercase'] as never }, h.deps),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    // 无证据 → 记为 PENDING（不可用，但事实可留痕）
    const pendingNoEvidence = await appendAuthorizationLifecycle({ ...base, scope: ['DUTY_REFUND'] }, h.deps);
    expect(pendingNoEvidence.lifecycleStatus).toBe('PENDING');
    // 无证据 + source=NONE → 自相矛盾，fail-closed
    await expect(
      appendAuthorizationLifecycle({ ...base, scope: ['DUTY_REFUND'], verificationSource: 'NONE' }, h.deps),
    ).rejects.toMatchObject({ code: 'EVIDENCE_REQUIRED' });

    const pending = await appendAuthorizationLifecycle(
      {
        ...base,
        scope: ['DUTY_REFUND'],
        evidenceArtifactRef: 'evidence:attestation',
        verificationSource: 'NONE',
      },
      h.deps,
    );
    expect(pending.lifecycleStatus).toBe('PENDING');
  });

  it('RENEW：追加新事实取代旧事实（旧行保持不动，新行生效）', async () => {
    const h = harness();
    const base = {
      organizationId: 'org-1',
      actorUserId: 'user-1',
      subject: 'BROKER_POA' as const,
      principalRef: 'ior:acme',
      brokerRef: 'broker:1',
      scope: ['DUTY_REFUND'],
      jurisdiction: 'US',
      evidenceArtifactRef: 'evidence:poa',
      verificationSource: 'BROKER_ATTESTATION' as const,
    };
    await appendAuthorizationLifecycle({ ...base, action: 'GRANT' }, h.deps);
    h.advance(60_000);
    await appendAuthorizationLifecycle({ ...base, action: 'RENEW' }, h.deps);
    expect(h.poa).toHaveLength(2);
    // 历史行未被 UPDATE：第一条 observedAt 仍是旧时间
    expect(h.poa[0]!.observedAt.toISOString()).toBe(AT.toISOString());
    const state = await readAuthorizationState(
      { organizationId: 'org-1', principalRef: 'ior:acme', remedy: 'DUTY_REFUND', route: 'BROKER_FILED', at: new Date(AT.getTime() + 120_000), context: { ...context, brokerRef: 'broker:1' } },
      h.deps,
    );
    expect(state.brokerPoa.status).toBe('VERIFIED');
    expect(state.brokerPoa.supersedesId).toBe('poa-1');
    expect(state.readiness.READY_TO_FILE).toBe(true);
  });

  it('REVOKE：追加 REVOKED 事实（带 revokedAt），读模型立即 fail-closed', async () => {
    const h = harness();
    const base = {
      organizationId: 'org-1',
      actorUserId: 'user-1',
      subject: 'AUTHORIZED_SIGNER' as const,
      principalRef: 'ior:acme',
      signerRef: 'person:cfo',
      signerType: 'LEGAL_REPRESENTATIVE' as const,
      authorityBasis: 'board:resolution',
      scope: ['DUTY_REFUND'],
      jurisdiction: 'US',
      evidenceArtifactRef: 'evidence:poa',
      verificationSource: 'CUSTOMER_DOCUMENT' as const,
    };
    await appendAuthorizationLifecycle({ ...base, action: 'GRANT' }, h.deps);
    const before = await readAuthorizationState(
      { organizationId: 'org-1', principalRef: 'ior:acme', remedy: 'DUTY_REFUND', route: 'SELF_FILED', context },
      h.deps,
    );
    expect(before.readiness.READY_TO_FILE).toBe(true);

    h.advance(60_000);
    const revoked = await appendAuthorizationLifecycle(
      { ...base, action: 'REVOKE', evidenceArtifactRef: null },
      h.deps,
    );
    expect(revoked.lifecycleStatus).toBe('REVOKED');
    expect(h.signer).toHaveLength(2);
    expect(h.signer[1]!.revokedAt).not.toBeNull();

    const after = await readAuthorizationState(
      { organizationId: 'org-1', principalRef: 'ior:acme', remedy: 'DUTY_REFUND', route: 'SELF_FILED', context },
      h.deps,
    );
    expect(after.signer.status).toBe('REVOKED');
    expect(after.readiness.READY_TO_FILE).toBe(false);
    expect(after.readiness.file.blockers).toContain('SIGNER_NOT_USABLE');
  });

  it('BROKER_FILED：POA 撤销后 READY_TO_FILE=false（BROKER_POA_NOT_USABLE）', async () => {
    const h = harness();
    const base = {
      organizationId: 'org-1',
      actorUserId: 'user-1',
      subject: 'BROKER_POA' as const,
      principalRef: 'ior:acme',
      brokerRef: 'broker:1',
      scope: ['*'],
      jurisdiction: 'US',
      evidenceArtifactRef: 'evidence:poa',
      verificationSource: 'BROKER_ATTESTATION' as const,
    };
    await appendAuthorizationLifecycle({ ...base, action: 'GRANT' }, h.deps);
    h.advance(60_000);
    await appendAuthorizationLifecycle({ ...base, action: 'REVOKE', evidenceArtifactRef: null }, h.deps);
    const state = await readAuthorizationState(
      { organizationId: 'org-1', principalRef: 'ior:acme', remedy: 'DUTY_REFUND', route: 'BROKER_FILED', context: { ...context, brokerRef: 'broker:1' } },
      h.deps,
    );
    expect(state.readiness.READY_TO_FILE).toBe(false);
    expect(state.readiness.file.blockers).toContain('BROKER_POA_NOT_USABLE');
  });
});
