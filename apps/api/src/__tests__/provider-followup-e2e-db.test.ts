// PROVIDER FOLLOW-UP INTELLIGENCE / P9+P10 — slice A-S10 — 真实 PostgreSQL 端到端 + 长期安全断言
// ---------------------------------------------------------------------------
// 全链：只读 adapter（fixture transport）→ append-only provider facts → projection →
//       Case Response Intelligence（advisory）→ Prisma 只读证据解析（FOUND / MISSING）→
//       Follow-up Package（只出草稿）→ 生命周期投影 → 客户可见状态契约。
// 安全断言：只读、tenant/account 隔离、不写证据、不发送、AI 不越权。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as providerSupport from '../services/provider-support';
import {
  buildFollowUpPackage,
  createAmazonSupportCaseAdapter,
  createAmazonSupportFixtureTransport,
  createPrismaEvidenceSource,
  createTemplateFollowUpComposer,
  defaultAmazonSupportFixture,
  interpretProviderContact,
  listProviderCaseFacts,
  projectCustomerRecoveryStatus,
  projectRecoveryCaseLifecycle,
  readProviderCaseProjection,
  recordProviderCaseSnapshot,
  resolveEvidence,
  type AmazonSupportTransportRequest,
  type CaseResponseClassifierPort,
  type ProviderContact,
  type EvidenceResolutionFact,
} from '../services/provider-support';

const prisma = new PrismaClient();
const NOW = new Date('2026-10-06T13:00:00.000Z');
const ORG = 'org-e2e-followup';
const ORG_OTHER = 'org-e2e-followup-other';
const ACCT_A = 'acct-e2e-a';
const ACCT_B = 'acct-e2e-b';
const TRACKING = '1Z999AA10123456784';

const SCOPE = { organizationId: ORG, platformAccountId: ACCT_A, credentialRef: 'cred-ref' } as const;

const calls: AmazonSupportTransportRequest[] = [];

function classifier(signal: { classification: string; confidenceBp: number }): CaseResponseClassifierPort {
  return {
    async classify() {
      return signal as never;
    },
  };
}

async function truncateProviderTables(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "ProviderCaseProjection", "ProviderContactFact", "ProviderCaseFact" RESTART IDENTITY CASCADE',
  );
}

beforeAll(async () => {
  await prisma.organization.create({ data: { id: ORG, name: 'followup-e2e', slug: 'followup-e2e' } });
  await prisma.organization.create({ data: { id: ORG_OTHER, name: 'followup-e2e-2', slug: 'followup-e2e-2' } });
  await prisma.platformAccount.create({
    data: {
      id: ACCT_A,
      organizationId: ORG,
      platform: 'AMAZON',
      externalAccountId: 'EXT-E2E-FOLLOWUP-A',
      displayName: 'E2E A',
    },
  });
  await prisma.platformAccount.create({
    data: {
      id: ACCT_B,
      organizationId: ORG,
      platform: 'AMAZON',
      externalAccountId: 'EXT-E2E-FOLLOWUP-B',
      displayName: 'E2E B',
    },
  });
  // 本 account 的可核对 POD（tracking 与 case-1001 期望值一致）
  await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG,
      accountId: ACCT_A,
      kind: 'POD',
      title: `POD ${TRACKING} delivery confirmation`,
      description: 'carrier proof of delivery',
      reliability: 0.95,
    },
  });
  // 同 org、不同 account 的 POD（必须不可见）
  await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG,
      accountId: ACCT_B,
      kind: 'POD',
      title: `POD ${TRACKING} other account`,
      reliability: 0.99,
    },
  });
  // 其它租户的 POD（必须不可见）
  await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG_OTHER,
      accountId: null,
      kind: 'POD',
      title: `POD ${TRACKING} other tenant`,
      reliability: 0.99,
    },
  });
});

beforeEach(async () => {
  await truncateProviderTables();
  calls.length = 0;
});

afterAll(async () => {
  await truncateProviderTables();
  await prisma.evidenceArtifact.deleteMany({ where: { organizationId: { in: [ORG, ORG_OTHER] } } });
  await prisma.platformAccount.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG, ORG_OTHER] } } });
  await prisma.$disconnect();
});

/** 默认 fixture 的 account id 映射到本测试的隔离 account，避免与其它套件共用字面量 account id */
function fixtureForScope(): ReturnType<typeof defaultAmazonSupportFixture> {
  const base = defaultAmazonSupportFixture();
  return {
    ...base,
    accounts: base.accounts.map((account) => ({
      ...account,
      platformAccountId:
        account.platformAccountId === 'acct-A'
          ? ACCT_A
          : account.platformAccountId === 'acct-B'
            ? ACCT_B
            : account.platformAccountId,
    })),
  };
}

function adapter() {
  return createAmazonSupportCaseAdapter({
    transport: createAmazonSupportFixtureTransport({ ...fixtureForScope(), calls }),
    now: () => NOW,
  });
}

async function readCase(caseId: string) {
  const port = adapter();
  const caseItem = (await port.listCases({ ...SCOPE, pageSize: 3 })).items.find(
    (c) => c.ref.providerCaseId === caseId,
  );
  if (!caseItem) throw new Error('fixture case 缺失：' + caseId);
  const contacts = (await port.listContacts({ ...SCOPE, caseId })).items;
  return { caseItem, contacts };
}

async function resolvePod(expected = TRACKING, scope = { organizationId: ORG, platformAccountId: ACCT_A }) {
  const source = createPrismaEvidenceSource(prisma);
  const candidates = await source.findCandidates({
    scope,
    acceptableKinds: ['POD'],
    requiredKeys: ['trackingNumber'],
  });
  return {
    candidates,
    result: resolveEvidence({
      scope,
      candidates,
      request: {
        requirement: { kind: 'POD', acceptableKinds: ['POD'], requiredKeys: ['trackingNumber'] },
        expected: { trackingNumber: expected },
      },
    }),
  };
}

function resolutionFact(
  kind: string,
  status: EvidenceResolutionFact['status'],
  evidenceReferences: readonly string[],
  resultDigest: string,
): EvidenceResolutionFact {
  return { kind, status, evidenceReferences, resultDigest };
}

/** case-1002 的主题是「缺商业发票」；库中没有任何该 kind 证据 → MISSING */
async function resolveInvoiceResult() {
  const scope = { organizationId: ORG, platformAccountId: ACCT_A };
  const source = createPrismaEvidenceSource(prisma);
  const candidates = await source.findCandidates({
    scope,
    acceptableKinds: ['INVOICE'],
    requiredKeys: ['invoiceNo'],
  });
  return resolveEvidence({
    scope,
    candidates,
    request: {
      requirement: { kind: 'COMMERCIAL_INVOICE', acceptableKinds: ['INVOICE'], requiredKeys: ['invoiceNo'] },
      expected: { invoiceNo: 'INV-2026-0001' },
    },
  });
}

describe('A-S10 PG E2E — 只读读取 → facts → 解释 → 证据解析 → 草稿 → 投影', () => {
  it('E2E-1 只读 adapter 读取（fixture）→ append-only facts → projection，全程只有 /support/ 只读路径', async () => {
    const { caseItem, contacts } = await readCase('case-1001');
    const recorded = await recordProviderCaseSnapshot(prisma, {
      scope: SCOPE,
      caseItem,
      contacts,
      now: NOW,
    });

    expect(recorded.caseFact.kind).toBe('APPENDED');
    expect(recorded.projection.providerCaseId).toBe('case-1001');
    expect(recorded.projection.contactCount).toBe(1);
    expect(recorded.projection.status).toBe('PENDING_MERCHANT_ACTION');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.path.startsWith('/support/')).toBe(true);
      expect(call.scope.platformAccountId).toBe(ACCT_A);
    }
  });

  it('E2E-2 平台联系内容 → 解释为 NEED_POD（advisory only，AI 不得授权执行）', async () => {
    const { contacts } = await readCase('case-1001');
    const interpretation = await interpretProviderContact({
      scope: { organizationId: ORG, platformAccountId: ACCT_A },
      contact: contacts[0],
      classifier: classifier({ classification: 'NEED_POD', confidenceBp: 9_200 }),
      model: 'test-model',
      promptVersion: 'p1',
      createdAt: NOW,
    });
    expect(interpretation.classification).toBe('NEED_POD');
    expect(interpretation.requiredEvidence).toEqual(['POD']);
    expect(interpretation.recommendedNextAction).toBe('EVIDENCE_RESOLUTION');
    expect(interpretation.advisoryOnly).toBe(true);
    expect(interpretation.canAuthorizeExecution).toBe(false);
    expect(interpretation.disposition).toBe('AUTO');
  });

  it('E2E-3 证据齐备：本 account POD 命中 tracking → FOUND（引用既有证据 id + 血缘）', async () => {
    const { result } = await resolvePod();
    expect(result.status).toBe('FOUND');
    expect(result.evidenceReferences).toHaveLength(1);
    expect(result.matchedFacts[0].matchedKeys).toEqual(['trackingNumber']);
    // 该证据行没有 fileAsset / connection 引用 → 血缘为空，但 sourceRef 必须可回溯
    expect(result.lineage).toEqual([]);
    expect(result.matchedFacts[0].sourceRef).toBe(`evidence:${result.evidenceReferences[0]}`);
    expect(result.resultDigest).toHaveLength(64);
  });

  it('E2E-4 证据缺失：期望 tracking 不存在 → MISSING（不猜、不借其它 account/tenant）', async () => {
    const { result, candidates } = await resolvePod('1Z00000000000000000');
    expect(result.status).not.toBe('FOUND');
    expect(['MISSING', 'PARTIAL', 'LOW_CONFIDENCE']).toContain(result.status);
    // 只有本 account 的 1 条 + org 级（此处 0 条）
    expect(candidates.every((c) => c.organizationId === ORG)).toBe(true);
    expect(candidates.some((c) => c.platformAccountId === ACCT_B)).toBe(false);
  });

  it('E2E-5 缺口 → Follow-up Package 只出草稿（不发、不附新证据、不授执行权）', async () => {
    const { contacts } = await readCase('case-1002');
    const missing = await resolveInvoiceResult();
    expect(missing.status).toBe('MISSING');

    const pkg = await buildFollowUpPackage({
      scope: { organizationId: ORG, platformAccountId: ACCT_A },
      providerCaseId: 'case-1002',
      caseRef: 'C-E2E-1',
      evidenceResolutions: [missing],
      amountUsd: 250,
      providerTextSource: contacts[0] as ProviderContact,
      composer: createTemplateFollowUpComposer(),
      createdAt: NOW,
    });

    expect(pkg.status).toBe('DRAFT');
    expect(pkg.draftOnly).toBe(true);
    expect(pkg.externalWrite).toBe(false);
    expect(pkg.transportEnabled).toBe(false);
    expect(pkg.grantsExecutionRights).toBe(false);
    expect(pkg.attachmentEvidenceIds).toEqual([]); // MISSING 不引用任何证据
    expect(pkg.missingEvidenceKinds).toEqual(['COMMERCIAL_INVOICE']);
    expect(pkg.approval.required).toBe(false); // 250 USD < 1000
    // 无任何既有证据可引用 → 附件为空
    expect(pkg.requestedEvidence[0].evidenceReferences).toEqual([]);
  });

  it('E2E-6 缺口 + 草稿 → 生命周期 FOLLOW_UP_DRAFTED → 客户可见 EVIDENCE_NEEDED', async () => {
    const missing = await resolveInvoiceResult();
    const lifecycle = projectRecoveryCaseLifecycle({
      scope: { organizationId: ORG },
      snapshot: {
        organizationId: ORG,
        caseId: 'case-1002',
        caseNo: 'C-E2E-1',
        domain: 'PLATFORM',
        caseStatus: 'COLLECTING_EVIDENCE',
        openedAt: '2026-09-25T02:00:00.000Z',
        requiredEvidenceKinds: ['COMMERCIAL_INVOICE'],
        evidenceResolutions: [
          resolutionFact(missing.requirementKind, 'MISSING', missing.evidenceReferences, missing.resultDigest),
        ],
        followUp: { status: 'DRAFT', approvalRequired: false, approvalRole: null, highValue: false },
      },
      observedAt: NOW,
    });
    const status = projectCustomerRecoveryStatus({
      scope: { organizationId: ORG },
      lifecycle,
      observedAt: NOW,
    });

    expect(lifecycle.stage).toBe('FOLLOW_UP_DRAFTED');
    expect(status.state).toBe('EVIDENCE_NEEDED');
    expect(status.facts.missingEvidenceKinds).toEqual(['COMMERCIAL_INVOICE']);
    expect(status.facts.sentToPlatform).toBe(false);
    expect(status.disclaimers).toContain('NO_PAYMENT_CONFIRMED_YET');
  });

  it('E2E-7 证据齐备（无缺口）→ EVIDENCE_COMPLETE → 客户可见 PREPARING（不得显示已提交）', async () => {
    const { result } = await resolvePod();
    const lifecycle = projectRecoveryCaseLifecycle({
      scope: { organizationId: ORG },
      snapshot: {
        organizationId: ORG,
        caseId: 'case-1001',
        caseNo: 'C-E2E-2',
        domain: 'PLATFORM',
        caseStatus: 'READY_TO_CLAIM',
        openedAt: '2026-09-20T01:00:00.000Z',
        requiredEvidenceKinds: ['POD'],
        evidenceResolutions: [
          {
            kind: 'POD',
            status: 'FOUND',
            evidenceReferences: result.evidenceReferences,
            resultDigest: result.resultDigest,
          },
        ],
      },
      observedAt: NOW,
    });
    const status = projectCustomerRecoveryStatus({
      scope: { organizationId: ORG },
      lifecycle,
      observedAt: NOW,
    });

    expect(lifecycle.stage).toBe('EVIDENCE_COMPLETE');
    expect(status.state).toBe('PREPARING');
    expect(status.facts.internalPrepared).toBe(false);
    expect(status.facts.sentToPlatform).toBe(false);
    expect(status.disclaimers).not.toContain('AWAITING_PLATFORM_ACKNOWLEDGEMENT');
  });

  it('E2E-8 高价值案件：草稿可出，但必须 OWNER 审批（不得绕过）', async () => {
    const missing = await resolveInvoiceResult();
    const pkg = await buildFollowUpPackage({
      scope: { organizationId: ORG, platformAccountId: ACCT_A },
      providerCaseId: 'case-1002',
      evidenceResolutions: [missing],
      amountUsd: 4_800,
      composer: createTemplateFollowUpComposer(),
      createdAt: NOW,
    });
    expect(pkg.highValue.isHighValue).toBe(true);
    expect(pkg.approval.required).toBe(true);
    expect(pkg.approval.role).toBe('OWNER');

    await expect(
      buildFollowUpPackage({
        scope: { organizationId: ORG, platformAccountId: ACCT_A },
        providerCaseId: 'case-1002',
        evidenceResolutions: [missing],
        amountUsd: 4_800,
        composer: createTemplateFollowUpComposer(),
        createdAt: NOW,
        requestBypassHighValueHitl: true,
      }),
    ).rejects.toMatchObject({ code: 'FOLLOW_UP_HIGH_VALUE_HITL_CANNOT_BE_BYPASSED' });
  });
});

describe('A-S10 长期安全断言（PG）', () => {
  it('SEC-1 tenant / account 隔离：跨 account 与跨 tenant 均不可见 provider 事实与投影', async () => {
    const { caseItem, contacts } = await readCase('case-1001');
    await recordProviderCaseSnapshot(prisma, { scope: SCOPE, caseItem, contacts, now: NOW });

    expect(
      await readProviderCaseProjection(prisma, { ...SCOPE, platformAccountId: ACCT_B, providerCaseId: 'case-1001' }),
    ).toBeNull();
    expect(
      await readProviderCaseProjection(prisma, {
        organizationId: ORG_OTHER,
        platformAccountId: ACCT_A,
        providerCaseId: 'case-1001',
      }),
    ).toBeNull();
    expect(
      await listProviderCaseFacts(prisma, { ...SCOPE, providerCaseId: 'case-1001' }),
    ).toHaveLength(1);
    expect(
      await listProviderCaseFacts(prisma, {
        organizationId: ORG_OTHER,
        platformAccountId: ACCT_A,
        providerCaseId: 'case-1001',
      }),
    ).toHaveLength(0);
  });

  it('SEC-2 只读边界：adapter 只有四个只读操作；任何写操作直接 fail-closed', async () => {
    const port = adapter();
    expect(Object.keys(port).sort()).toEqual(['getAttachmentMetadata', 'getCase', 'listCases', 'listContacts']);
    for (const forbidden of ['replyCase', 'createSellerSupportCase', 'uploadFollowUpEvidence', 'submitFbaReimbursementClaim']) {
      let code: string | null = null;
      try {
        providerSupport.assertAmazonSupportWriteForbidden(forbidden);
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
        expect(error).toBeInstanceOf(providerSupport.ProviderSupportError);
      }
      expect(code).toBe('PROVIDER_SUPPORT_WRITE_FORBIDDEN');
    }
  });

  it('SEC-3 全链不修改证据：证据行数与摘要保持不变，且不回传被拒来源 id', async () => {
    const before = await prisma.evidenceArtifact.findMany({
      where: { organizationId: { in: [ORG, ORG_OTHER] } },
      select: { id: true, kind: true, title: true },
      orderBy: { id: 'asc' },
    });

    const { caseItem, contacts } = await readCase('case-1001');
    await recordProviderCaseSnapshot(prisma, { scope: SCOPE, caseItem, contacts, now: NOW });
    const { result, candidates } = await resolvePod();
    await buildFollowUpPackage({
      scope: { organizationId: ORG, platformAccountId: ACCT_A },
      providerCaseId: 'case-1001',
      evidenceResolutions: [result],
      providerTextSource: contacts[0] as ProviderContact,
      composer: createTemplateFollowUpComposer(),
      createdAt: NOW,
    });

    const after = await prisma.evidenceArtifact.findMany({
      where: { organizationId: { in: [ORG, ORG_OTHER] } },
      select: { id: true, kind: true, title: true },
      orderBy: { id: 'asc' },
    });
    expect(after).toEqual(before);

    const foreignIds = before
      .filter((row) => row.title.includes('other account') || row.title.includes('other tenant'))
      .map((row) => row.id);
    expect(result.evidenceReferences.some((ref) => foreignIds.includes(ref))).toBe(false);
    expect(candidates.map((c) => c.evidenceId).some((id) => foreignIds.includes(id))).toBe(false);
  });

  it('SEC-4 AI 不得覆盖 provider truth，也不得产生执行能力', async () => {
    const { contacts } = await readCase('case-1001');
    const interpretation = await interpretProviderContact({
      scope: { organizationId: ORG, platformAccountId: ACCT_A },
      contact: contacts[0],
      classifier: classifier({ classification: 'NEED_POD', confidenceBp: 9_200 }),
      model: 'test-model',
      promptVersion: 'p1',
      createdAt: NOW,
    });
    providerSupport.assertInterpretationIsAdvisory(interpretation);
    expect(interpretation.advisoryOnly).toBe(true);
    expect(interpretation.canAuthorizeExecution).toBe(false);
    // 解释记录不得携带执行/批准/金额字段
    const keys = Object.keys(interpretation);
    for (const forbidden of ['executionRight', 'approvedAmount', 'paymentAuthorized', 'platformWrite']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('SEC-5 模块不导出任何平台写 / 通知 / 上传入口（防回归）', () => {
    for (const name of Object.keys(providerSupport)) {
      expect(name).not.toMatch(/replyCase|createCase|uploadEvidence|sendNotification|submitToPlatform|platformWrite/i);
    }
  });
});
