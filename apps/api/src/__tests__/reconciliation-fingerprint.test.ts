/**
 * R45 S2 —— provider/source event identity v1（纯函数单测，无数据库、无 IO）
 * 依据：MSG-20261001-45/46 CHANGE B + MSG-20261001-47 Q3。
 */

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_EVENT_FINGERPRINT_VERSION,
  ProviderEventIdentityError,
  providerEventFingerprintV1,
} from '../services/reconciliation/fingerprint';

const base = {
  provider: 'AMAZON',
  sourceResource: 'finances/reimbursements',
  eventKind: 'OBSERVED' as const,
  providerEventId: 'evt-1',
};

describe('R45 S2 · providerEventFingerprintV1', () => {
  it('同一输入 → 确定性 64 hex + v1', () => {
    const a = providerEventFingerprintV1(base);
    const b = providerEventFingerprintV1({ ...base });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.version).toBe(PROVIDER_EVENT_FINGERPRINT_VERSION);
    expect(a.parts[0]).toBe('v1');
  });

  it('provider / resource 大小写与空白不影响身份；event kind 归一为大写', () => {
    const canonical = providerEventFingerprintV1(base);
    const noisy = providerEventFingerprintV1({
      ...base,
      provider: '  amazon ',
      sourceResource: ' Finances/Reimbursements  ',
      eventKind: 'observed' as never,
    });
    expect(noisy.fingerprint).toBe(canonical.fingerprint);
  });

  it('同一 providerEventId + 不同 resource → 不同身份（不误去重）', () => {
    const reimbursements = providerEventFingerprintV1(base);
    const inventory = providerEventFingerprintV1({ ...base, sourceResource: 'fba/inventory' });
    expect(inventory.fingerprint).not.toBe(reimbursements.fingerprint);
  });

  it('不同 event kind（ACCEPTED vs ACCEPTANCE_REVOKED）→ 不同身份', () => {
    const accepted = providerEventFingerprintV1({ ...base, eventKind: 'ACCEPTED' });
    const revoked = providerEventFingerprintV1({ ...base, eventKind: 'ACCEPTANCE_REVOKED' });
    expect(accepted.fingerprint).not.toBe(revoked.fingerprint);
  });

  it('无 providerEventId 时可用 canonicalSourceIdentity；两者都缺失 → fail-closed', () => {
    const viaIdentity = providerEventFingerprintV1({
      provider: 'AMAZON',
      sourceResource: 'finances/reimbursements',
      eventKind: 'OBSERVED',
      canonicalSourceIdentity: 'case:123|amount:10.0000|2026-09-04',
    });
    expect(viaIdentity.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    expect(() =>
      providerEventFingerprintV1({
        provider: 'AMAZON',
        sourceResource: 'finances/reimbursements',
        eventKind: 'OBSERVED',
      }),
    ).toThrowError(ProviderEventIdentityError);
    try {
      providerEventFingerprintV1({ provider: 'AMAZON', sourceResource: 'x', eventKind: 'OBSERVED' });
    } catch (error) {
      expect((error as ProviderEventIdentityError).code).toBe('MISSING_EVENT_IDENTITY');
    }
  });

  it('分隔符中和：不会因拼接产生跨字段碰撞', () => {
    const a = providerEventFingerprintV1({
      provider: 'amazon|evt',
      sourceResource: 'res',
      eventKind: 'OBSERVED',
      providerEventId: 'x',
    });
    const b = providerEventFingerprintV1({
      provider: 'amazon',
      sourceResource: 'evt|res',
      eventKind: 'OBSERVED',
      providerEventId: 'x',
    });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('缺失必填维度（provider / resource / kind）→ 明确错误码', () => {
    const codes: string[] = [];
    for (const bad of [
      { ...base, provider: '   ' },
      { ...base, sourceResource: '' },
      { ...base, eventKind: ' ' as never },
    ]) {
      try {
        providerEventFingerprintV1(bad);
      } catch (error) {
        codes.push((error as ProviderEventIdentityError).code);
      }
    }
    expect(codes).toEqual(['PROVIDER_REQUIRED', 'SOURCE_RESOURCE_REQUIRED', 'EVENT_KIND_REQUIRED']);
  });
});
