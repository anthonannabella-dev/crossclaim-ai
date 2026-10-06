// PROVIDER FOLLOW-UP INTELLIGENCE / P4（A-S5）—— Evidence Resolver 纯决策回归

import { describe, expect, it } from 'vitest';

import * as providerSupport from '../services/provider-support';
import {
  EVIDENCE_RESOLVER_VERSION,
  createInMemoryEvidenceSource,
  extractEvidenceKeyValues,
  resolveEvidence,
  resolveRequiredEvidence,
  type EvidenceCandidate,
  type EvidenceResolutionRequest,
} from '../services/provider-support';

const SCOPE = { organizationId: 'org-1', platformAccountId: 'acct-A' } as const;
const POD_REQUIREMENT: EvidenceResolutionRequest = {
  requirement: { kind: 'POD', acceptableKinds: ['POD'], requiredKeys: ['trackingNumber', 'orderId'] },
  expected: { trackingNumber: '1Z999AA10123456784', orderId: '123-4567890-1234567' },
};

function candidate(overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    evidenceId: 'ev-1',
    organizationId: 'org-1',
    platformAccountId: 'acct-A',
    kind: 'POD',
    title: 'POD 1Z999AA10123456784 123-4567890-1234567',
    reliability: 0.95,
    capturedAt: '2026-10-05T00:00:00.000Z',
    fileAssetId: 'fa-1',
    keyValues: { trackingNumber: '1Z999AA10123456784', orderId: '123-4567890-1234567' },
    lineage: ['fileAsset:fa-1'],
    sourceRef: 'fileAsset:fa-1',
    ...overrides,
  };
}

describe('A-S5 Evidence Resolver · 六态判定', () => {
  it('唯一完整匹配 → FOUND（含引用/血缘/置信度/摘要）', () => {
    const result = resolveEvidence({ scope: SCOPE, candidates: [candidate()], request: POD_REQUIREMENT });
    expect(result.kind).toBe('EVIDENCE_RESOLUTION');
    expect(result.version).toBe(EVIDENCE_RESOLVER_VERSION);
    expect(result.status).toBe('FOUND');
    expect(result.evidenceReferences).toEqual(['ev-1']);
    expect(result.matchedFacts[0]).toMatchObject({ evidenceId: 'ev-1', kind: 'POD' });
    expect(result.matchedFacts[0].matchedKeys.sort()).toEqual(['orderId', 'trackingNumber']);
    expect(result.lineage).toContain('fileAsset:fa-1');
    expect(result.confidenceBp).toBe(9_500);
    expect(result.missingEvidence).toHaveLength(0);
    expect(result.resultDigest).toHaveLength(64);
  });

  it('没有候选 / 没有兼容 kind → MISSING（并给出缺失键）', () => {
    const empty = resolveEvidence({ scope: SCOPE, candidates: [], request: POD_REQUIREMENT });
    expect(empty.status).toBe('MISSING');
    expect(empty.reasons).toContain('NO_EVIDENCE_IN_SCOPE');
    expect(empty.missingEvidence[0].missingKeys).toEqual(['trackingNumber', 'orderId']);

    const wrongKind = resolveEvidence({
      scope: SCOPE,
      candidates: [candidate({ kind: 'COMMERCIAL_INVOICE' })],
      request: POD_REQUIREMENT,
    });
    expect(wrongKind.status).toBe('MISSING');
    expect(wrongKind.reasons).toContain('NO_KIND_COMPATIBLE_EVIDENCE');
  });

  it('只匹配部分键 → PARTIAL（列出缺失键）', () => {
    const result = resolveEvidence({
      scope: SCOPE,
      candidates: [candidate({ keyValues: { trackingNumber: '1Z999AA10123456784' } })],
      request: POD_REQUIREMENT,
    });
    expect(result.status).toBe('PARTIAL');
    expect(result.missingEvidence[0].missingKeys).toEqual(['orderId']);
  });

  it('同一需求下同键出现不同值 → CONFLICT（禁止 last-write-wins）', () => {
    const result = resolveEvidence({
      scope: SCOPE,
      candidates: [
        candidate(),
        candidate({
          evidenceId: 'ev-2',
          keyValues: { trackingNumber: '1Z999AA10123456784', orderId: '123-9999999-9999999' },
        }),
      ],
      request: POD_REQUIREMENT,
    });
    expect(result.status).toBe('CONFLICT');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].key).toBe('orderId');
    expect(result.conflicts[0].values.sort()).toEqual(['123-4567890-1234567', '123-9999999-9999999']);
    expect(result.evidenceReferences.sort()).toEqual(['ev-1', 'ev-2']);
  });

  it('多个候选都完整匹配同一键 → AMBIGUOUS（交 HITL）', () => {
    const result = resolveEvidence({
      scope: SCOPE,
      candidates: [candidate(), candidate({ evidenceId: 'ev-3', fileAssetId: 'fa-3' })],
      request: POD_REQUIREMENT,
    });
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.reasons).toContain('MULTIPLE_FULL_MATCHES');
  });

  it('同 kind 但没有任何可核对键 → LOW_CONFIDENCE（绝不猜 FOUND）', () => {
    const result = resolveEvidence({
      scope: SCOPE,
      candidates: [candidate({ keyValues: {}, reliability: 0.99 })],
      request: POD_REQUIREMENT,
    });
    expect(result.status).toBe('LOW_CONFIDENCE');
    expect(result.reasons).toContain('EVIDENCE_WITHOUT_VERIFIABLE_KEYS');
  });

  it('完整匹配但可靠性低于门限 → LOW_CONFIDENCE', () => {
    const result = resolveEvidence({
      scope: SCOPE,
      candidates: [candidate({ reliability: 0.4 })],
      request: POD_REQUIREMENT,
    });
    expect(result.status).toBe('LOW_CONFIDENCE');
    expect(result.reasons).toContain('BELOW_CONFIDENCE_THRESHOLD');
  });
});

describe('A-S5 Evidence Resolver · 隔离与安全', () => {
  it('跨 tenant / 跨 account 候选被拒（记录在 rejectedForScope，不参与匹配）', () => {
    const result = resolveEvidence({
      scope: SCOPE,
      candidates: [
        candidate({ organizationId: 'org-2' }),
        candidate({ evidenceId: 'ev-other-acct', platformAccountId: 'acct-B' }),
      ],
      request: POD_REQUIREMENT,
    });
    expect(result.status).toBe('MISSING');
    expect(result.rejectedForScope.sort()).toEqual(['ev-1', 'ev-other-acct']);
    expect(result.evidenceReferences).toHaveLength(0);
  });

  it('错误的 tracking / order 值不会匹配（不会把别人的包裹当成证据）', () => {
    const result = resolveEvidence({
      scope: SCOPE,
      candidates: [
        candidate({
          keyValues: { trackingNumber: '1Z999AA10123456784', orderId: '123-0000000-0000000' },
        }),
      ],
      request: POD_REQUIREMENT,
    });
    expect(result.status).toBe('PARTIAL');
    expect(result.missingEvidence[0].missingKeys).toEqual(['orderId']);
  });

  it('同 evidenceId 重复候选去重（不会因重复行变成 AMBIGUOUS）', () => {
    const result = resolveEvidence({
      scope: SCOPE,
      candidates: [candidate(), candidate()],
      request: POD_REQUIREMENT,
    });
    expect(result.status).toBe('FOUND');
    expect(result.evidenceReferences).toEqual(['ev-1']);
  });

  it('确定性：同输入 → 同 resultDigest；状态不同 → 摘要不同', () => {
    const a = resolveEvidence({ scope: SCOPE, candidates: [candidate()], request: POD_REQUIREMENT });
    const b = resolveEvidence({ scope: SCOPE, candidates: [candidate()], request: POD_REQUIREMENT });
    const missing = resolveEvidence({ scope: SCOPE, candidates: [], request: POD_REQUIREMENT });
    expect(a.resultDigest).toBe(b.resultDigest);
    expect(a.resultDigest).not.toBe(missing.resultDigest);
  });

  it('批量解析保持请求顺序，并复用同一只读端口', async () => {
    const source = createInMemoryEvidenceSource([
      candidate(),
      candidate({ evidenceId: 'ev-inv', kind: 'COMMERCIAL_INVOICE', keyValues: { invoiceNo: 'INV-2026-0001' } }),
    ]);
    const results = await resolveRequiredEvidence({
      scope: SCOPE,
      requirements: [
        POD_REQUIREMENT,
        {
          requirement: { kind: 'COMMERCIAL_INVOICE', acceptableKinds: ['COMMERCIAL_INVOICE'], requiredKeys: ['invoiceNo'] },
          expected: { invoiceNo: 'INV-2026-0001' },
        },
      ],
      source,
    });
    expect(results.map((r) => r.requirementKind)).toEqual(['POD', 'COMMERCIAL_INVOICE']);
    expect(results[0].status).toBe('FOUND');
    expect(results[1].status).toBe('FOUND');
  });

  it('best-effort 键抽取只取强模式；抽不到留空', () => {
    expect(
      extractEvidenceKeyValues('POD for 1Z999AA10123456784 order 123-4567890-1234567', [
        'trackingNumber',
        'orderId',
      ]),
    ).toEqual({ trackingNumber: '1Z999AA10123456784', orderId: '123-4567890-1234567' });
    expect(extractEvidenceKeyValues('POD scan, no reference', ['trackingNumber'])).toEqual({});
  });

  it('解析器只读：模块不导出任何证据创建 / 写入入口', () => {
    const names = Object.keys(providerSupport);
    for (const name of names) {
      expect(name).not.toMatch(/createEvidence|uploadEvidence|persistEvidence|mutateEvidence/i);
    }
  });
});
