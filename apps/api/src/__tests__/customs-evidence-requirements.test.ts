// CUSTOMS / DUTY RECOVERY — slice B-S5 — Customs 证据链接入回归
// ---------------------------------------------------------------------------
// 覆盖：需求目录结构与标签筛选、逐项解析接入 A-S5、证据链四态汇总（COMPLETE/PARTIAL/INSUFFICIENT/BLOCKED）、
// 「材料齐备 ≠ 可申报」不变量、tenant/account 隔离、边界断言、确定性摘要。

import { describe, expect, it } from 'vitest';

import * as providerSupport from '../services/provider-support';
import {
  CUSTOMS_EVIDENCE_BOUNDARY,
  CUSTOMS_EVIDENCE_REQUIREMENTS,
  CUSTOMS_EVIDENCE_REQUIREMENT_IDS,
  CUSTOMS_EVIDENCE_TAGS,
  CustomsEvidenceChainError,
  assertChainDoesNotAuthorize,
  createInMemoryEvidenceSource,
  requirementToRequest,
  requirementsForTag,
  resolveCustomsEvidenceChain,
  type CustomsEvidenceRequirementId,
  type EvidenceCandidate,
} from '../services/provider-support';

const NOW = new Date('2026-10-06T17:00:00.000Z');
const SCOPE = { organizationId: 'org-cus-1', platformAccountId: 'acct-cus-a' } as const;
const ENTRY = 'ABC-123456';
const TRACKING = '1Z999AA10123456784';
const INVOICE = 'INV-2026-0001';

function candidate(overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    evidenceId: 'ev-1',
    organizationId: SCOPE.organizationId,
    platformAccountId: SCOPE.platformAccountId,
    kind: 'CUSTOMS_DOC',
    title: 'Entry summary ' + ENTRY,
    reliability: 0.95,
    capturedAt: '2026-10-05T00:00:00.000Z',
    fileAssetId: 'fa-1',
    keyValues: { entryNumber: ENTRY },
    lineage: ['fileAsset:fa-1'],
    sourceRef: 'fileAsset:fa-1',
    ...overrides,
  };
}

/** 覆盖全部 10 项需求的证据集合 */
function fullEvidence(): EvidenceCandidate[] {
  return [
    candidate({ evidenceId: 'ev-entry', kind: 'CUSTOMS_DOC', keyValues: { entryNumber: ENTRY, hts: '8471.30.01' } }),
    candidate({ evidenceId: 'ev-invoice', kind: 'INVOICE', title: 'Commercial invoice ' + INVOICE, keyValues: { invoiceNo: INVOICE } }),
    candidate({ evidenceId: 'ev-pod', kind: 'POD', title: 'POD ' + TRACKING, keyValues: { trackingNumber: TRACKING } }),
    candidate({ evidenceId: 'ev-destruction', kind: 'EMAIL', title: 'Destruction certificate ' + TRACKING, keyValues: { trackingNumber: TRACKING } }),
    candidate({ evidenceId: 'ev-carrier', kind: 'TRACKING', title: 'Carrier delivery confirmation ' + TRACKING, keyValues: { trackingNumber: TRACKING } }),
    candidate({ evidenceId: 'ev-broker', kind: 'BROKER_CORRESPONDENCE', title: 'Broker case ' + ENTRY, keyValues: { entryNumber: ENTRY } }),
  ];
}

function chain(
  candidates: readonly EvidenceCandidate[],
  extra: Partial<Parameters<typeof resolveCustomsEvidenceChain>[0]> = {},
) {
  return resolveCustomsEvidenceChain({
    scope: SCOPE,
    expected: { entryNumber: ENTRY, trackingNumber: TRACKING, invoiceNo: INVOICE, hts: '8471.30.01' },
    source: createInMemoryEvidenceSource(candidates),
    now: NOW,
    ...extra,
  });
}

describe('B-S5 Customs 证据链 — 需求目录', () => {
  it('10 项需求结构完整：文档种类 / 证据 kind / 核对键 / 标签齐备', () => {
    expect(CUSTOMS_EVIDENCE_REQUIREMENT_IDS).toHaveLength(10);
    for (const id of CUSTOMS_EVIDENCE_REQUIREMENT_IDS) {
      const requirement = CUSTOMS_EVIDENCE_REQUIREMENTS[id];
      expect(requirement.id).toBe(id);
      expect(requirement.label.length).toBeGreaterThan(0);
      expect(requirement.documentKinds.length).toBeGreaterThan(0);
      expect(requirement.acceptableEvidenceKinds.length).toBeGreaterThan(0);
      expect(requirement.requiredKeys.length).toBeGreaterThan(0);
      expect(requirement.appliesTo.length).toBeGreaterThan(0);
      for (const tag of requirement.appliesTo) {
        expect(CUSTOMS_EVIDENCE_TAGS).toContain(tag);
      }
    }
  });

  it('按用途标签筛选需求（Return / Drawback / Broker handoff 各自集合）', () => {
    const returnIds = requirementsForTag('RETURN').map((r) => r.id);
    expect(returnIds).toContain('RETURN_RECORD');
    expect(returnIds).toContain('POD');
    expect(returnIds).not.toContain('DUTY_PAYMENT');

    const drawbackIds = requirementsForTag('DRAWBACK').map((r) => r.id);
    expect(drawbackIds).toEqual(
      expect.arrayContaining(['ENTRY_RECORD', 'COMMERCIAL_INVOICE', 'EXPORT_RECORD', 'DESTRUCTION_RECORD', 'DUTY_PAYMENT']),
    );

    const brokerIds = requirementsForTag('BROKER_HANDOFF').map((r) => r.id);
    expect(brokerIds).toContain('BROKER_CASE');
  });

  it('requirementToRequest 只传调用方提供的 expected（不猜缺失键）', () => {
    const request = requirementToRequest('ENTRY_LINE', { entryNumber: ENTRY });
    expect(request.requirement.kind).toBe('ENTRY_LINE');
    expect(request.requirement.acceptableKinds).toEqual(['CUSTOMS_DOC']);
    expect(request.requirement.requiredKeys).toEqual(['entryNumber', 'hts']);
    expect(request.expected).toEqual({ entryNumber: ENTRY });
  });
});

describe('B-S5 — 证据链四态汇总', () => {
  it('全部齐备 → COMPLETE，允许进入材料准备（但仍不代表可申报）', async () => {
    const result = await chain(fullEvidence());
    expect(result.kind).toBe('CUSTOMS_EVIDENCE_CHAIN');
    expect(result.chainStatus).toBe('COMPLETE');
    expect(result.missing).toEqual([]);
    expect(result.blockedBy).toEqual([]);
    expect(result.mayProceedToClaimPreparation).toBe(true);
    expect(result.evidenceCompleteDoesNotImplyEligibility).toBe(true);
    expect(result.requiresManualReview).toBe(false);
    expect(result.chainDigest).toHaveLength(64);
  });

  it('缺关键材料 → INSUFFICIENT（列出缺失需求，不允许进入准备）', async () => {
    const withoutPod = fullEvidence().filter((c) => c.evidenceId !== 'ev-pod');
    const result = await chain(withoutPod);
    expect(result.chainStatus).toBe('INSUFFICIENT');
    expect(result.missing).toContain('POD');
    expect(result.mayProceedToClaimPreparation).toBe(false);
    expect(result.requiresManualReview).toBe(true);
    expect(result.reasons.some((r) => r.startsWith('MISSING:'))).toBe(true);
  });

  it('部分匹配（缺 HTS 键）→ PARTIAL', async () => {
    const evidence = fullEvidence().map((c) =>
      c.evidenceId === 'ev-entry' ? { ...c, keyValues: { entryNumber: ENTRY } } : c,
    );
    const result = await chain(evidence);
    expect(result.chainStatus).toBe('PARTIAL');
    expect(result.partial).toContain('ENTRY_LINE');
    expect(result.mayProceedToClaimPreparation).toBe(false);
  });

  it('同 entry 不同值 → BLOCKED（冲突不自动择优）', async () => {
    const evidence = [
      ...fullEvidence(),
      candidate({ evidenceId: 'ev-entry-b', kind: 'CUSTOMS_DOC', title: 'Entry summary ' + ENTRY, keyValues: { entryNumber: 'XYZ-999999' } }),
    ];
    const result = await chain(evidence);
    expect(result.chainStatus).toBe('BLOCKED');
    expect(result.blockedBy).toContain('ENTRY_RECORD');
    expect(result.mayProceedToClaimPreparation).toBe(false);
    expect(result.reasons.some((r) => r.startsWith('CONFLICT_OR_AMBIGUOUS:'))).toBe(true);
  });

  it('低可靠性证据 → LOW_CONFIDENCE，同样不得进入准备', async () => {
    const evidence = fullEvidence().map((c) =>
      c.evidenceId === 'ev-entry' ? { ...c, reliability: 0.4 } : c,
    );
    const result = await chain(evidence);
    expect(result.chainStatus).toBe('PARTIAL');
    expect(result.lowConfidence).toContain('ENTRY_LINE');
    expect(result.mayProceedToClaimPreparation).toBe(false);
  });

  it('只解析指定需求（tag 过滤后的子集）', async () => {
    const ids = requirementsForTag('RETURN').map((r) => r.id);
    const result = await chain(fullEvidence(), { requirementIds: ids, tag: 'RETURN' });
    expect(result.tag).toBe('RETURN');
    expect(result.outcomes.map((o) => o.id).sort()).toEqual([...ids].sort());
    expect(result.outcomes.some((o) => o.id === 'DUTY_PAYMENT')).toBe(false);
  });

  it('任何一条未齐备都要求人工复核（fail-closed）', async () => {
    const result = await chain([candidate()]);
    expect(result.chainStatus).not.toBe('COMPLETE');
    expect(result.requiresManualReview).toBe(true);
    expect(result.mayProceedToClaimPreparation).toBe(false);
  });
});

describe('B-S5 — 隔离、边界与确定性', () => {
  it('跨 account / 跨 tenant 的证据不可见（不借道提升证据链状态）', async () => {
    const foreign = [
      candidate({ evidenceId: 'ev-other-acct', platformAccountId: 'acct-cus-b' }),
      candidate({ evidenceId: 'ev-other-org', organizationId: 'org-cus-2' }),
    ];
    const result = await chain(foreign);
    expect(result.chainStatus).toBe('INSUFFICIENT');
    expect(result.outcomes.every((o) => o.evidenceReferences.length === 0)).toBe(true);
  });

  it('证据链结论不判定 eligibility、不写证据、不代表可申报', async () => {
    const result = await chain(fullEvidence());
    expect(result.decidesEligibility).toBe(false);
    expect(result.mutatesEvidence).toBe(false);
    expect(result.evidenceCompleteDoesNotImplyEligibility).toBe(true);
    expect(() => assertChainDoesNotAuthorize(result)).not.toThrow();
    expect(() => assertChainDoesNotAuthorize({ decidesEligibility: true as never })).toThrowError(
      CustomsEvidenceChainError,
    );
    expect(() =>
      assertChainDoesNotAuthorize({ mayProceedToClaimPreparation: true, chainStatus: 'PARTIAL' }),
    ).toThrowError(CustomsEvidenceChainError);
  });

  it('边界常量：只读、不写 Customs Truth、不算金额、不判佣金、跨租户禁止', () => {
    expect(CUSTOMS_EVIDENCE_BOUNDARY.readOnly).toBe(true);
    expect(CUSTOMS_EVIDENCE_BOUNDARY.mutatesEvidence).toBe(false);
    expect(CUSTOMS_EVIDENCE_BOUNDARY.writesCustomsTruth).toBe(false);
    expect(CUSTOMS_EVIDENCE_BOUNDARY.decidesEligibility).toBe(false);
    expect(CUSTOMS_EVIDENCE_BOUNDARY.computesRecoverableAmount).toBe(false);
    expect(CUSTOMS_EVIDENCE_BOUNDARY.determinesSuccessFeeEligibility).toBe(false);
    expect(CUSTOMS_EVIDENCE_BOUNDARY.evidenceCompleteMeansEligible).toBe(false);
    expect(CUSTOMS_EVIDENCE_BOUNDARY.crossTenantOrAccountForbidden).toBe(true);
    expect(CUSTOMS_EVIDENCE_BOUNDARY.forbidden).toContain(
      'treating an evidence-complete chain as filing eligibility',
    );
  });

  it('确定性：同证据同 now → 同 chainDigest；缺一件 → 摘要变', async () => {
    const a = await chain(fullEvidence());
    const b = await chain(fullEvidence());
    const c = await chain(fullEvidence().filter((x) => x.evidenceId !== 'ev-pod'));
    expect(a.chainDigest).toBe(b.chainDigest);
    expect(a.chainDigest).not.toBe(c.chainDigest);
    expect(a.evaluatedAt).toBe(NOW.toISOString());
  });

  it('模块不导出任何创建证据 / 判定权利 / 计算金额的入口', () => {
    for (const name of Object.keys(providerSupport)) {
      expect(name).not.toMatch(/createCustomsEvidence|decideCustomsEligibility|computeDrawbackAmount|authorizeFiling/i);
    }
  });

  it('需求 id 类型集合与目录键一致（防止漏配）', () => {
    const ids = Object.keys(CUSTOMS_EVIDENCE_REQUIREMENTS) as CustomsEvidenceRequirementId[];
    expect(ids.sort()).toEqual([...CUSTOMS_EVIDENCE_REQUIREMENT_IDS].sort());
  });
});
