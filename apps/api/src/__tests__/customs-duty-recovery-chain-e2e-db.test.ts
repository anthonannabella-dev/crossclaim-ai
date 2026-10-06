// CUSTOMS / DUTY RECOVERY — slice B-S12 — 全链 PG E2E + 长期安全断言
// ---------------------------------------------------------------------------
// 链路：真实 PostgreSQL 证据资产 → B-S5 证据链 → B-S6 匹配 → B-S7 规则包/期限 →
//       B-S8 Drawback 路由（含 LEGAL_VERIFIED 期限政策）→ B-S9 报关就绪 15 门槛 →
//       B-S10 Claim-Ready Package vNext（复用既有确定性装配器）→ B-S11 成功费资格。
// 安全断言：tenant/account 隔离、证据只读、无 Canonical 写入、不申报、不计费、9801/9802 ≠ drawback。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CUSTOMS_CLASSIFICATION_BOUNDARY,
  classifyCustomsDocument,
  createPrismaEvidenceSource,
  extractCustoms7501Fields,
  matchImportLineToCounterparts,
  reconcileCustomsFields,
  resolveCustomsEvidenceChain,
  type CustomsEvidenceRequirementId,
} from '../services/provider-support';
import { resolveFeePolicy } from '../services/commercial/fee-policy';
import {
  assembleCustomsClaimReadyPackage,
  type CustomsClaimReadyPackage,
} from '../services/customs/customs-claim-ready-package';
import {
  assembleClaimReadyPackageVNext,
} from '../services/customs/claim-ready-package-vnext';
import { evaluateBrokerFilingReadiness } from '../services/customs/broker-filing-readiness';
import { evaluateCustomsSuccessFeeGuard } from '../services/customs/customs-success-fee-guard';
import { evaluateDrawbackCandidateRoute } from '../services/customs/drawback/drawback-candidate-route';
import {
  evaluateUsRemedyDeadline,
  resolveJurisdictionRulePack,
} from '../services/customs/rule-pack/us-rule-pack-v1';

const prisma = new PrismaClient();
const NOW = new Date('2026-10-06T23:00:00.000Z');
const ORG = 'org-b12-e2e';
const ORG_OTHER = 'org-b12-e2e-other';
const ACCT_A = 'acct-b12-a';
const ACCT_B = 'acct-b12-b';
const ENTRY = 'ABC-123456';
const TRACKING = '1Z999AA10123456784';
const INVOICE = 'INV-2026-0001';
const SCOPE = { organizationId: ORG, platformAccountId: ACCT_A };

beforeAll(async () => {
  await prisma.organization.create({ data: { id: ORG, name: 'b12-e2e', slug: 'b12-e2e' } });
  await prisma.organization.create({ data: { id: ORG_OTHER, name: 'b12-e2e-2', slug: 'b12-e2e-2' } });
  await prisma.platformAccount.create({
    data: { id: ACCT_A, organizationId: ORG, platform: 'AMAZON', externalAccountId: 'B12A', displayName: 'B12 A' },
  });
  await prisma.platformAccount.create({
    data: { id: ACCT_B, organizationId: ORG, platform: 'AMAZON', externalAccountId: 'B12B', displayName: 'B12 B' },
  });

  // 完整证据链（本 account）
  await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG,
      accountId: ACCT_A,
      kind: 'CUSTOMS_DOC',
      title: `CBP Form 7501 entry summary ${ENTRY}`,
      description: 'HTS 8471.30.01 entry summary',
      reliability: 0.95,
    },
  });
  await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG,
      accountId: ACCT_A,
      kind: 'INVOICE',
      title: `Commercial invoice ${INVOICE}`,
      reliability: 0.95,
    },
  });
  await prisma.evidenceArtifact.create({
    data: { organizationId: ORG, accountId: ACCT_A, kind: 'POD', title: `POD ${TRACKING}`, reliability: 0.95 },
  });
  await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG,
      accountId: ACCT_A,
      kind: 'EMAIL',
      title: `Destruction certificate ${TRACKING}`,
      reliability: 0.95,
    },
  });
  await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG,
      accountId: ACCT_A,
      kind: 'TRACKING',
      title: `Carrier delivery confirmation ${TRACKING}`,
      reliability: 0.95,
    },
  });
  await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG,
      accountId: ACCT_A,
      kind: 'BROKER_CORRESPONDENCE',
      title: `Broker case ${ENTRY}`,
      reliability: 0.95,
    },
  });

  // 其它 account / 其它 tenant 的干扰证据（必须不可见）
  await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG,
      accountId: ACCT_B,
      kind: 'CUSTOMS_DOC',
      title: `CBP Form 7501 entry summary ${ENTRY} other-account`,
      reliability: 0.99,
    },
  });
  await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG_OTHER,
      accountId: null,
      kind: 'CUSTOMS_DOC',
      title: `CBP Form 7501 entry summary ${ENTRY} other-tenant`,
      reliability: 0.99,
    },
  });
});

afterAll(async () => {
  await prisma.evidenceArtifact.deleteMany({ where: { organizationId: { in: [ORG, ORG_OTHER] } } });
  await prisma.platformAccount.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG, ORG_OTHER] } } });
  await prisma.$disconnect();
});

const REQUIRED_IDS: readonly CustomsEvidenceRequirementId[] = [
  'ENTRY_RECORD',
  'ENTRY_LINE',
  'COMMERCIAL_INVOICE',
  'POD',
  'RETURN_RECORD',
  'EXPORT_RECORD',
  'DESTRUCTION_RECORD',
  'CARRIER_PROOF',
  'BROKER_CASE',
  'DUTY_PAYMENT',
];

async function chain() {
  return resolveCustomsEvidenceChain({
    scope: SCOPE,
    expected: { entryNumber: ENTRY, trackingNumber: TRACKING, invoiceNo: INVOICE, hts: '8471.30.01' },
    source: createPrismaEvidenceSource(prisma),
    requirementIds: REQUIRED_IDS,
    now: NOW,
  });
}

describe('B-S12 全链 E2E（真实 PostgreSQL）', () => {
  it('E2E-01 证据链（真实 DB，本 account 齐备）→ COMPLETE 且仅在 COMPLETE 时允许进入准备', async () => {
    const result = await chain();
    expect(result.chainStatus).toBe('COMPLETE');
    expect(result.mayProceedToClaimPreparation).toBe(true);
    expect(result.evidenceCompleteDoesNotImplyEligibility).toBe(true);
    expect(result.mutatesEvidence).toBe(false);
    expect(result.decidesEligibility).toBe(false);
  });

  it('E2E-02 文书分类 + 7501 候选抽取 + 跨源对账（OCR 不得独占）', () => {
    const classification = classifyCustomsDocument({
      filename: 'entry-summary-7501.pdf',
      text: 'CBP Form 7501 Entry Summary',
      now: NOW,
    });
    expect(classification.documentKind).toBe('CBP_7501');
    expect(classification.customsTruthEligible).toBe(false);
    expect(CUSTOMS_CLASSIFICATION_BOUNDARY.classificationOnly).toBe(true);

    const extraction = extractCustoms7501Fields({
      text: [
        'Entry Number: ' + ENTRY,
        'Entry Date: 2026-08-01',
        'HTS: 8471.30.01',
        'Customs Value: 1,000.00',
        'Duty Paid: 150.00',
        'Currency: USD',
      ].join('\n'),
      sourceFileSha256: 'a'.repeat(64),
      sourceKind: 'NATIVE_TEXT',
      provider: 'pdf:mock',
      providerVersion: 'mock/v1',
      now: NOW,
    });
    expect(extraction.status).toBe('EXTRACTED');
    expect(extraction.canonicalWriteAllowed).toBe(false);

    const reconciliation = reconcileCustomsFields({
      candidates: [
        ...extraction.candidates,
        {
          field: 'entryNumber',
          rawValue: ENTRY,
          normalizedValue: ENTRY,
          page: 1,
          boundingBox: null,
          confidenceBp: 9_800,
          sourceKind: 'OCR_DERIVED',
          provider: 'ocr:mock',
          providerVersion: 'mock/v1',
          sourceFileSha256: 'b'.repeat(64),
          lineNumber: null,
        },
      ],
      fields: ['entryNumber', 'hts', 'currency'],
      now: NOW,
    });
    expect(reconciliation.fields.find((f) => f.field === 'entryNumber')?.status).toBe('AGREED');
    expect(reconciliation.canonicalWritePerformed).toBe(false);
    expect(reconciliation.ocrNeverSufficientAlone).toBe(true);
  });

  it('E2E-03 Import ↔ Export 匹配（EXACT）→ 规则包 → Drawback 路由 CLAIM_READY（需法务核验期限）', async () => {
    const matchResult = matchImportLineToCounterparts({
      scope: SCOPE,
      importLine: {
        lineId: 'line-1',
        trackingNumber: TRACKING,
        entryNumber: ENTRY,
        hts: '8471.30.01',
        currency: 'USD',
        jurisdiction: 'US',
        customsValue: 1_000,
      },
      counterparts: [
        {
          recordId: 'exp-1',
          organizationId: ORG,
          platformAccountId: ACCT_A,
          recordKind: 'EXPORT',
          trackingNumber: TRACKING,
          entryNumber: ENTRY,
          hts: '8471.30.01',
          currency: 'USD',
          jurisdiction: 'US',
          customsValue: 1_000,
        },
      ],
      now: NOW,
    });
    expect(matchResult.status).toBe('EXACT');
    expect(matchResult.automaticSelectionPerformed).toBe(false);

    const pack = resolveJurisdictionRulePack('US');
    expect(pack?.ruleSetId).toBe('customs-us');
    const unverifiedDeadline = evaluateUsRemedyDeadline({
      jurisdiction: 'US',
      candidate: 'DRAWBACK_CANDIDATE',
      exportDate: '2026-09-01',
      now: NOW.toISOString(),
    });
    expect(unverifiedDeadline.status).toBe('INDETERMINATE');

    const route = evaluateDrawbackCandidateRoute({
      scope: SCOPE,
      entryNumber: ENTRY,
      hts: '8471.30.01',
      jurisdiction: 'US',
      exportDate: '2026-09-01',
      evidenceChain: await chain(),
      counterpartMatch: matchResult,
      now: NOW,
    });
    expect(route.disposition).toBe('NEEDS_MANUAL_REVIEW'); // 未核验期限 → 不得 CLAIM_READY
    expect(route.maxDisposition).toBe('CLAIM_READY');

    const withLegalPolicy = evaluateDrawbackCandidateRoute({
      scope: SCOPE,
      entryNumber: ENTRY,
      hts: '8471.30.01',
      jurisdiction: 'US',
      exportDate: '2026-09-01',
      evidenceChain: await chain(),
      counterpartMatch: matchResult,
      verifiedDeadlinePolicy: {
        policyId: 'legal:customs:drawback',
        policyVersion: 'v1',
        anchorField: 'exportDate',
        daysFromAnchor: 1_825,
        verification: 'LEGAL_VERIFIED',
      },
      now: NOW,
    });
    expect(withLegalPolicy.disposition).toBe('CLAIM_READY');
    expect(withLegalPolicy.filingPerformed).toBe(false);
    expect(withLegalPolicy.amount.estimatedRecoverableAmountUsd).toBeNull();

    // 9801 / 9802 不得进入 drawback
    const special = evaluateDrawbackCandidateRoute({
      scope: SCOPE,
      entryNumber: ENTRY,
      hts: '9801.00.10',
      jurisdiction: 'US',
      evidenceChain: await chain(),
      counterpartMatch: matchResult,
      now: NOW,
    });
    expect(special.disposition).toBe('NOT_CANDIDATE');
  });

  it('E2E-04 报关就绪（15 门槛）→ 缺 POA 时 BROKER_HANDOFF；齐备时 READY 但绝不申报', async () => {
    const facts = {
      customsAgreementSigned: true,
      iorConfirmed: true,
      claimantConfirmed: true,
      recoveryRightForRemedy: true,
      brokerConnected: true,
      filingPermissionValid: true,
      providerCapabilityReady: true,
      payeeIdentityConfirmed: true,
      refundDestinationVerified: true,
      aceEnrollmentReady: true,
    };
    const noPoa = evaluateBrokerFilingReadiness({
      scope: SCOPE,
      remedy: 'DRAWBACK',
      jurisdiction: 'US',
      facts,
      poa: null,
      evidenceChainStatus: 'COMPLETE',
      claimRoute: { disposition: 'CLAIM_READY' },
      now: NOW,
    });
    expect(noPoa.disposition).toBe('BROKER_HANDOFF');
    expect(noPoa.filingSubmitted).toBe(false);

    const ready = evaluateBrokerFilingReadiness({
      scope: SCOPE,
      remedy: 'DRAWBACK',
      jurisdiction: 'US',
      facts,
      poa: {
        organizationId: ORG,
        principalRef: 'principal-1',
        brokerRef: 'broker-1',
        jurisdiction: 'US',
        authorizationType: 'CBP_FORM_5291',
        scope: ['DRAWBACK'],
        effectiveAt: '2026-01-01',
        expiresAt: '2027-01-01',
        evidenceArtifactRef: 'ev-poa',
        verificationStatus: 'VERIFIED',
        verificationSource: 'BROKER_POA_FACT',
      },
      evidenceChainStatus: 'COMPLETE',
      claimRoute: { disposition: 'CLAIM_READY' },
      now: NOW,
    });
    expect(ready.disposition).toBe('READY_FOR_FILING_PROVIDER');
    expect(ready.readyCount).toBe(15);
    expect(ready.poa.reused).toBe(true);
    expect(ready.externalWritePerformed).toBe(false);
  });

  it('E2E-05 Claim-Ready Package vNext：高价值案件必须 OWNER/ADMIN 审批；不伪称 3PL', () => {
    const base = assembleCustomsClaimReadyPackage({
      fact: {
        entryNumber: ENTRY,
        entryDate: '2026-08-01',
        jurisdiction: 'US',
        portOfEntry: '2704',
        importerOfRecordRef: 'ior-1',
        source: 'BROKER_FEED',
        rawReference: 'raw-1',
        dutyLines: [],
        totalDutyAmountByCurrency: { USD: '150.00' },
        observedAt: NOW.toISOString(),
        readOnly: true,
        filingPerformed: false,
        paymentPerformed: false,
        productionCredentials: 'ABSENT',
      } as never,
      truth: {
        entryNumber: ENTRY,
        jurisdiction: 'US',
        currencies: [{ currency: 'USD', totalAmount: '150.00' }],
        dutyLineRefs: [],
        observations: [],
        calculationPerformed: true,
        adjudicationPerformed: false,
        recoverableAmountDerived: false,
        appliesFxConversion: false,
        filingPerformed: false,
        paymentPerformed: false,
        productionCredentials: 'ABSENT',
      } as never,
      discrepancy: {
        entryNumber: ENTRY,
        jurisdiction: 'US',
        expectationCount: 1,
        lineCount: 1,
        matchedLineCount: 1,
        items: [{ code: 'RATE_DIFF' } as never],
        discrepanciesFound: true,
        adjudicationPerformed: false,
        recoverableAmountDerived: false,
        appliesFxConversion: false,
        filingPerformed: false,
        paymentPerformed: false,
        productionCredentials: 'ABSENT',
      } as never,
      assessment: {
        entryNumber: ENTRY,
        policyId: 'customs-us',
        policyVersion: 'v1',
        status: 'ELIGIBLE',
        reasons: [],
        entryAgeDays: 60,
        signedDiscrepancyAmountByCurrency: { USD: '150.00' },
        overpaymentCandidateAmountByCurrency: { USD: '150.00' },
        examinedLineCount: 1,
      } as never,
      estimate: {
        entryNumber: ENTRY,
        policyId: 'customs-us',
        policyVersion: 'v1',
        status: 'ESTIMATED',
        reasons: [],
        byCurrency: [{ currency: 'USD', estimatedAmount: '150.00' }],
        estimateOnly: true,
        finalAmountDerived: false,
        billable: false,
        feeDerived: false,
      } as never,
      provenance: { policyId: 'customs-us', policyVersion: 'v1', algorithmVersion: 'customs-package/v1' },
      evidenceReferences: [{ kind: 'ENTRY_DOCUMENT', reference: 'evidence:ev-1', digest: null }],
      computedAt: NOW.toISOString(),
    }) as CustomsClaimReadyPackage;

    expect(base.readiness).toBe('READY');
    expect(base.billable).toBe(false);
    expect(base.filingPerformed).toBe(false);

    const vnext = assembleClaimReadyPackageVNext({
      scope: SCOPE,
      base,
      estimatedRecoverableAmountUsd: 5_000,
      now: NOW,
    });
    expect(vnext.disposition).toBe('NEEDS_HUMAN_APPROVAL');
    expect(vnext.hitl.role).toBe('OWNER');
    expect(vnext.thirdPartyLogistics.reconciliationPerformed).toBe(false);
    expect(vnext.nonExecution.filingPerformed).toBe(false);
  });

  it('E2E-06 成功费资格：只有 VERIFIED + CONFIRMED + RECONCILED 才 BILLABLE（不扣款）', () => {
    const policy = resolveFeePolicy('CUSTOMS_SUCCESS_15', '2026-10-06');
    const billable = evaluateCustomsSuccessFeeGuard({
      scope: SCOPE,
      moneyTruth: {
        settlementId: 'st-e2e-1',
        sourceLevel: 'AUTHORITY_VERIFIED',
        confirmationStatus: 'CONFIRMED',
        reconciliationStatus: 'RECONCILED',
        verifiedAmount: '1000.00',
        currency: 'USD',
      },
      policy,
      now: NOW,
    });
    expect(billable.decision).toBe('BILLABLE');
    expect(billable.fee?.feeAmount).toBe('150.00');
    expect(billable.autoChargePerformed).toBe(false);
    expect(billable.paymentCollectionPerformed).toBe(false);

    const userReported = evaluateCustomsSuccessFeeGuard({
      scope: SCOPE,
      moneyTruth: {
        settlementId: 'st-e2e-2',
        sourceLevel: 'USER_REPORTED',
        confirmationStatus: 'CONFIRMED',
        reconciliationStatus: 'RECONCILED',
        verifiedAmount: '1000.00',
        currency: 'USD',
      },
      policy,
      now: NOW,
    });
    expect(userReported.billable).toBe(false);
  });
});

describe('B-S12 长期安全断言（PG + 纯函数）', () => {
  it('SEC-1 tenant / account 隔离：跨 account 与跨 tenant 证据不可见，也不借道提升证据链', async () => {
    const source = createPrismaEvidenceSource(prisma);
    const otherAccount = await source.findCandidates({
      scope: { organizationId: ORG, platformAccountId: ACCT_B },
      acceptableKinds: ['CUSTOMS_DOC'],
      requiredKeys: ['entryNumber'],
    });
    expect(otherAccount.every((c) => c.platformAccountId !== ACCT_A)).toBe(true);

    const otherTenant = await source.findCandidates({
      scope: { organizationId: ORG_OTHER, platformAccountId: ACCT_A },
      acceptableKinds: ['CUSTOMS_DOC'],
      requiredKeys: ['entryNumber'],
    });
    expect(otherTenant.every((c) => c.organizationId === ORG_OTHER)).toBe(true);

    const foreignChain = await resolveCustomsEvidenceChain({
      scope: { organizationId: ORG_OTHER, platformAccountId: ACCT_A },
      expected: { entryNumber: ENTRY, trackingNumber: TRACKING, invoiceNo: INVOICE, hts: '8471.30.01' },
      source,
      requirementIds: REQUIRED_IDS,
      now: NOW,
    });
    expect(foreignChain.chainStatus).not.toBe('COMPLETE');
  });

  it('SEC-2 全链不修改证据（行集合前后一致），且不产生 Canonical 写入', async () => {
    const before = await prisma.evidenceArtifact.findMany({
      where: { organizationId: { in: [ORG, ORG_OTHER] } },
      select: { id: true, kind: true, title: true },
      orderBy: { id: 'asc' },
    });
    await chain();
    const after = await prisma.evidenceArtifact.findMany({
      where: { organizationId: { in: [ORG, ORG_OTHER] } },
      select: { id: true, kind: true, title: true },
      orderBy: { id: 'asc' },
    });
    expect(after).toEqual(before);
  });

  it('SEC-3 硬边界保持：不申报 / 不写外部 / 无生产凭据 / 不自动扣佣 / 9801·9802 ≠ drawback', () => {
    expect(CUSTOMS_CLASSIFICATION_BOUNDARY.ocrIsNotCustomsTruth).toBe(true);
    expect(CUSTOMS_CLASSIFICATION_BOUNDARY.llmCannotDecideEligibility).toBe(true);
    const pack = resolveJurisdictionRulePack('US');
    expect(pack?.exclusionRules.hts9801IsNotDrawback).toBe(true);
    expect(pack?.exclusionRules.hts9802IsNotDrawback).toBe(true);
    expect(pack?.remedies.DRAWBACK_CANDIDATE.routing.autoFilingAllowed).toBe(false);
  });
});
