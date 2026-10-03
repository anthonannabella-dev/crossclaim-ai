/**
 * TRACK A / PC-09 — 同意闸门（fail-closed）单元回归（MSG-20261003-96 ⑬）。
 * 纯内存：断言「未登记能力不拦截」「已登记但缺少接受 → CONSENT_REQUIRED」以及 registry fail-closed 语义。
 */

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { ConsentRequiredError, requireConsentFor } from '../services/commercial/policy-acceptance';
import { CONSENT_GATED_CAPABILITIES } from '../services/commercial/policy-registry';

const actor = { organizationId: 'org-1', actorUserId: 'user-1', role: 'OWNER' };

function fakePrisma(rows: Array<{ documentKey: string; documentVersion: string }>): PrismaClient {
  return {
    policyAcceptance: {
      findMany: vi.fn(async () => rows.map((row, index) => ({
        id: String(index),
        documentKey: row.documentKey,
        documentVersion: row.documentVersion,
        acceptedAt: new Date(0),
        source: 'API',
        evidenceRef: null,
      }))),
    },
  } as unknown as PrismaClient;
}

describe('PC-09 — consent gate', () => {
  it('未登记的能力不拦截（显式 no-op，不猜测准入）', async () => {
    await expect(requireConsentFor(fakePrisma([]), actor, 'claim.package.view')).resolves.toBeUndefined();
  });

  it('registry 已登记能力时：缺少 CURRENT 版本接受 → fail-closed（CONSENT_REQUIRED）', async () => {
    expect(Object.keys(CONSENT_GATED_CAPABILITIES)).toEqual([]);
    // 通过临时登记验证闸门语义（不改变仓库默认配置）
    (CONSENT_GATED_CAPABILITIES as Record<string, readonly string[]>)['test.capability'] = ['terms-of-service'];
    try {
      await expect(requireConsentFor(fakePrisma([]), actor, 'test.capability')).rejects.toBeInstanceOf(ConsentRequiredError);

      await expect(requireConsentFor(fakePrisma([{ documentKey: 'terms-of-service', documentVersion: '2026-09-01' }]), actor, 'test.capability')).rejects.toBeInstanceOf(ConsentRequiredError);

      await expect(requireConsentFor(fakePrisma([{ documentKey: 'terms-of-service', documentVersion: '2026-10-01' }]), actor, 'test.capability')).resolves.toBeUndefined();
    } finally {
      delete (CONSENT_GATED_CAPABILITIES as Record<string, readonly string[]>)['test.capability'];
    }
  });
});
