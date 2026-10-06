// PROVIDER FOLLOW-UP INTELLIGENCE / P3（A-S4）—— 解读落库 真实 PostgreSQL 验收

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  interpretProviderContact,
  listCaseResponseInterpretations,
  persistCaseResponseInterpretation,
  type CaseResponseClassifierPort,
  type ProviderContact,
} from '../services/provider-support';

const prisma = new PrismaClient();
const NOW = new Date('2026-10-06T08:30:00.000Z');
const SCOPE = { organizationId: 'org-ai-1', platformAccountId: 'acct-A' } as const;

function contact(): ProviderContact {
  return {
    contactId: 'ct-ai-1',
    providerCaseId: 'case-1001',
    kind: 'EMAIL',
    direction: 'INBOUND',
    occurredAt: '2026-10-05T09:00:00.000Z',
    bodyText: 'Please provide proof of delivery for the shipment.',
    bodyDigest: 'body-digest-ai-1',
    attachments: [],
    source: {
      platform: 'AMAZON',
      adapterId: 'amazon-support-read',
      adapterVersion: 'amazon-support-read/v1',
      fetchedAt: NOW.toISOString(),
      credentialRef: 'cred-ref',
    },
  };
}

const classifier: CaseResponseClassifierPort = {
  async classify() {
    return { classification: 'NEED_POD', confidenceBp: 9_200 };
  },
};

async function interpret() {
  return interpretProviderContact({
    scope: SCOPE,
    contact: contact(),
    classifier,
    model: 'local-mock-classifier',
    promptVersion: 'prompt-v1',
    createdAt: NOW,
  });
}

async function truncate(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE "ProviderCaseResponseInterpretation" RESTART IDENTITY CASCADE');
}

beforeEach(async () => {
  await truncate();
});

afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

describe('A-S4 解读落库', () => {
  it('PG-AI1 首次写入 APPENDED；重复同输入 → REUSED（不产生第二条）', async () => {
    const first = await persistCaseResponseInterpretation(prisma, { interpretation: await interpret(), now: NOW });
    expect(first.kind).toBe('APPENDED');
    const second = await persistCaseResponseInterpretation(prisma, {
      interpretation: await interpret(),
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(second.kind).toBe('REUSED');
    expect(second.interpretationId).toBe(first.interpretationId);
    expect(await prisma.providerCaseResponseInterpretation.count()).toBe(1);
  });

  it('PG-AI2 不同 promptVersion → 新解读事实（历史保留），并可读取分类/建议/需求', async () => {
    await persistCaseResponseInterpretation(prisma, { interpretation: await interpret(), now: NOW });
    const v2 = await interpretProviderContact({
      scope: SCOPE,
      contact: contact(),
      classifier,
      model: 'local-mock-classifier',
      promptVersion: 'prompt-v2',
      createdAt: NOW,
    });
    const second = await persistCaseResponseInterpretation(prisma, { interpretation: v2, now: NOW });
    expect(second.kind).toBe('APPENDED');
    const list = await listCaseResponseInterpretations(prisma, { ...SCOPE, providerCaseId: 'case-1001' });
    expect(list).toHaveLength(2);
    expect(list[0].classification).toBe('NEED_POD');
    expect(list[0].requiredEvidence).toEqual(['POD']);
    expect(list[0].recommendedNextAction).toBe('EVIDENCE_RESOLUTION');
    expect(list[0].disposition).toBe('AUTO');
  });

  it('PG-AI3 解读 append-only：UPDATE / DELETE 一律拒绝', async () => {
    await persistCaseResponseInterpretation(prisma, { interpretation: await interpret(), now: NOW });
    await expect(
      prisma.$executeRawUnsafe('UPDATE "ProviderCaseResponseInterpretation" SET "classification" = $1', 'APPROVED'),
    ).rejects.toThrow(/PROVIDER_INTERPRETATION_APPEND_ONLY/);
    await expect(prisma.$executeRawUnsafe('DELETE FROM "ProviderCaseResponseInterpretation"')).rejects.toThrow(
      /PROVIDER_INTERPRETATION_APPEND_ONLY/,
    );
  });

  it('PG-AI4 归属隔离：其它 tenant / account 看不到解读；跨租户改写被拒', async () => {
    const saved = await persistCaseResponseInterpretation(prisma, { interpretation: await interpret(), now: NOW });
    expect(
      await listCaseResponseInterpretations(prisma, { ...SCOPE, platformAccountId: 'acct-B', providerCaseId: 'case-1001' }),
    ).toHaveLength(0);
    expect(
      await listCaseResponseInterpretations(prisma, { ...SCOPE, organizationId: 'org-other', providerCaseId: 'case-1001' }),
    ).toHaveLength(0);
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "ProviderCaseResponseInterpretation" SET "organizationId" = $1 WHERE "id" = $2',
        'org-other',
        saved.interpretationId,
      ),
    ).rejects.toThrow(/APPEND_ONLY|tenant/i);
  });

  it('PG-AI5 数据库兜底：非法 classification / 越界 confidence 被 CHECK 拒绝', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "ProviderCaseResponseInterpretation"
         ("id","organizationId","platformAccountId","platform","providerCaseId","sourceContactId","classification",
          "confidenceBp","requiredEvidence","extractedRequirements","recommendedNextAction","disposition",
          "dispositionReasons","model","promptVersion","classifierVersion","interpretationDigest","createdAt","recordedAt")
         VALUES ('x1','org-ai-1','acct-A','AMAZON','case-1001','ct-x','NOT_A_CLASS',9000,'[]','[]','WAIT','AUTO','[]',
                 'm','p','v','d',$1,$1)`,
        NOW,
      ),
    ).rejects.toThrow(/classification_chk|check/i);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "ProviderCaseResponseInterpretation"
         ("id","organizationId","platformAccountId","platform","providerCaseId","sourceContactId","classification",
          "confidenceBp","requiredEvidence","extractedRequirements","recommendedNextAction","disposition",
          "dispositionReasons","model","promptVersion","classifierVersion","interpretationDigest","createdAt","recordedAt")
         VALUES ('x2','org-ai-1','acct-A','AMAZON','case-1001','ct-x','NEED_POD',99999,'[]','[]','EVIDENCE_RESOLUTION','AUTO','[]',
                 'm','p','v','d',$1,$1)`,
        NOW,
      ),
    ).rejects.toThrow(/confidence_chk|check/i);
  });
});
