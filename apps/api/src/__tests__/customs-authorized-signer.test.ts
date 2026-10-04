/** CA-2 单元验收：AuthorizedSignerFact latest-usable 解析（scope / revoked / superseded / expired / principal）。 */

import { describe, expect, it } from 'vitest';

import {
  resolveAuthorizedSignerFacts,
  type AuthorizedSignerRow,
} from '../services/customs/customs-authorization-route';

const AT = new Date('2026-10-04T00:00:00.000Z');

const row = (overrides: Partial<AuthorizedSignerRow> = {}): AuthorizedSignerRow => ({
  id: 'signer-1',
  principalRef: 'ior:acme',
  signerRef: 'person:cfo',
  signerType: 'LEGAL_REPRESENTATIVE',
  authorityBasis: 'board:resolution-2026',
  scopeRemedies: ['*'],
  jurisdiction: 'US',
  effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
  expiresAt: new Date('2027-09-01T00:00:00.000Z'),
  verificationStatus: 'VERIFIED',
  observedAt: new Date('2026-09-01T00:00:00.000Z'),
  revokedAt: null,
  supersededAt: null,
  contentDigest: 'a'.repeat(64),
  ...overrides,
});

describe('CA-2 — authorized signer resolution（unit）', () => {
  it('VERIFIED 且 scope 覆盖 → 可用', () => {
    const resolved = resolveAuthorizedSignerFacts([row()], { at: AT, remedy: 'DUTY_REFUND', principalRef: 'ior:acme' });
    expect(resolved.status).toBe('VERIFIED');
    expect(resolved.scopeCoversRemedy).toBe(true);
    expect(resolved.source).toBe('SIGNER_AUTHORITY_FACT');
    expect(resolved.signerType).toBe('LEGAL_REPRESENTATIVE');
  });

  it('scope 不覆盖 remedy → scopeCoversRemedy=false（fail-closed）', () => {
    const resolved = resolveAuthorizedSignerFacts([row({ scopeRemedies: ['OTHER'] })], {
      at: AT,
      remedy: 'DUTY_REFUND',
      principalRef: 'ior:acme',
    });
    expect(resolved.status).toBe('VERIFIED');
    expect(resolved.scopeCoversRemedy).toBe(false);
  });

  it('revoked / expired / superseded 一律不可用', () => {
    expect(
      resolveAuthorizedSignerFacts([row({ verificationStatus: 'REVOKED', revokedAt: AT })], {
        at: AT,
        remedy: 'DUTY_REFUND',
      }).status,
    ).toBe('REVOKED');
    expect(
      resolveAuthorizedSignerFacts([row({ expiresAt: new Date('2026-06-01T00:00:00.000Z') })], {
        at: AT,
        remedy: 'DUTY_REFUND',
      }).status,
    ).toBe('EXPIRED');
    expect(
      resolveAuthorizedSignerFacts([row({ supersededAt: new Date('2026-09-30T00:00:00.000Z') })], {
        at: AT,
        remedy: 'DUTY_REFUND',
      }).status,
    ).toBe('SUPERSEDED');
  });

  it('最新事实覆盖旧事实（旧 fact 不可用，新 fact 可用）', () => {
    const older = row({ id: 'signer-old', observedAt: new Date('2026-08-01T00:00:00.000Z'), contentDigest: 'b'.repeat(64) });
    const newer = row({
      id: 'signer-new',
      observedAt: new Date('2026-09-20T00:00:00.000Z'),
      contentDigest: 'c'.repeat(64),
      signerType: 'AUTHORIZED_EMPLOYEE',
    });
    const resolved = resolveAuthorizedSignerFacts([older, newer], { at: AT, remedy: 'DUTY_REFUND' });
    expect(resolved.rowId).toBe('signer-new');
    expect(resolved.supersededById).toBe('signer-old');
    expect(resolved.signerType).toBe('AUTHORIZED_EMPLOYEE');
  });

  it('PENDING / 未知状态不可用；无 principal 匹配 → MISSING', () => {
    expect(resolveAuthorizedSignerFacts([row({ verificationStatus: 'PENDING' })], { at: AT, remedy: 'DUTY_REFUND' }).status).toBe(
      'PENDING',
    );
    expect(
      resolveAuthorizedSignerFacts([row({ principalRef: 'ior:other' })], { at: AT, remedy: 'DUTY_REFUND', principalRef: 'ior:acme' })
        .status,
    ).toBe('MISSING');
  });
});
