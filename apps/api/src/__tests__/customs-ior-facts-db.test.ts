/**
 * BG-013 — ENTERPRISE IOR RECOVERY LAYER **真实 PostgreSQL 验收**（MSG-20261003-136 APPROVED）。
 * ---------------------------------------------------------------
 * 断言（架构方逐条要求）：
 *   同 fact 重放 exactly-one；corrected fact 追加历史；UPDATE / DELETE 拒绝；
 *   跨租户 lineage 拒绝；raw EIN 拒绝；numeric importer number 拒绝；credential/自由文本拒绝；
 *   CBP_FORM_4811 作 Broker POA → DB 写入失败；VERIFIED + source NONE 拒绝；
 *   VERIFIED + 缺 evidence 拒绝；过期窗口形状非法拒绝；scope 空拒绝；
 *   latest 查询返回新 fact 且历史保留；organizationId 隔离。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();
const ORG = 'cc230000-0000-4000-8000-000000000001';
const ORG_B = 'cc230000-0000-4000-8000-000000000002';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const NOW = '2026-10-04T00:00:00.000Z';
const LATER = '2026-10-04T01:00:00.000Z';

const insertIdentity = async (opts: {
  id: string;
  organizationId?: string;
  iorRef?: string;
  digest?: string;
  status?: string;
  source?: string;
  observedAt?: string;
  verifiedAt?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}) => {
  const org = opts.organizationId ?? ORG;
  const iorRef = opts.iorRef ?? 'ior_acct_1';
  const digest = opts.digest ?? DIGEST_A;
  const status = opts.status ?? 'VERIFIED';
  const source = opts.source ?? 'ACE_LOOKUP';
  const observedAt = opts.observedAt ?? NOW;
  const verifiedAt = opts.verifiedAt === undefined ? NOW : opts.verifiedAt;
  const from = opts.effectiveFrom === undefined ? '2026-01-01T00:00:00.000Z' : opts.effectiveFrom;
  const to = opts.effectiveTo === undefined ? null : opts.effectiveTo;
  return prisma.$executeRawUnsafe(
    'INSERT INTO "CustomsIorIdentityFact" ("id","organizationId","jurisdiction","principalType","importerOfRecordRef","legalEntityRef","aceAccountRef","verificationStatus","verificationSource","verifiedAt","effectiveFrom","effectiveTo","contentDigest","sourceReference","observedAt") ' +
      'VALUES ($1,$2,$3,$4::"CustomsIorPrincipalType",$5,$6,$7,$8::"CustomsIorVerificationStatus",$9::"CustomsIorVerificationSource",$10::timestamp,$11::timestamp,$12::timestamp,$13,$14,$15::timestamp)',
    opts.id,
    org,
    'US',
    'IMPORTER_OF_RECORD',
    iorRef,
    'legal_entity_1',
    'ace:acct:1',
    status,
    source,
    verifiedAt,
    from,
    to,
    digest,
    'ace:source:1',
    observedAt,
  );
};

const insertLineage = async (opts: { id: string; organizationId?: string; iorRef?: string; digest?: string; observedAt?: string; filingAuthorized?: boolean }) =>
  prisma.$executeRawUnsafe(
    'INSERT INTO "CustomsRightLineageFact" ("id","organizationId","entryReference","importerOfRecordRef","claimantRef","remedyRoute","iorRightsForRemedy","claimantRightsForRemedy","filingAuthorized","outcome","reasonCodes","evidenceKinds","contentDigest","observedAt") ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::"CustomsRightLineageOutcome",$11::jsonb,$12::jsonb,$13,$14::timestamp)',
    opts.id,
    opts.organizationId ?? ORG,
    'entry:1',
    opts.iorRef ?? 'ior_acct_1',
    'claimant:1',
    'DRAWBACK',
    'CONFIRMED',
    'CONFIRMED',
    opts.filingAuthorized ?? true,
    'COMPLETE',
    JSON.stringify(['OK']),
    JSON.stringify(['ENTRY_RECORD']),
    opts.digest ?? DIGEST_A,
    opts.observedAt ?? NOW,
  );

const insertPoa = async (opts: {
  id: string;
  organizationId?: string;
  principalRef?: string;
  authorizationType?: string;
  scope?: string;
  effectiveAt?: string;
  expiresAt?: string | null;
  evidenceArtifactRef?: string | null;
  status?: string;
  source?: string;
  digest?: string;
}) =>
  prisma.$executeRawUnsafe(
    'INSERT INTO "CustomsBrokerPoaFact" ("id","organizationId","principalRef","brokerRef","jurisdiction","authorizationType","scope","effectiveAt","expiresAt","evidenceArtifactRef","verificationStatus","verificationSource","contentDigest","observedAt") ' +
      'VALUES ($1,$2,$3,$4,$5,$6::"CustomsBrokerAuthorizationType",$7::jsonb,$8::timestamp,$9::timestamp,$10,$11::"CustomsIorVerificationStatus",$12::"CustomsIorVerificationSource",$13,$14::timestamp)',
    opts.id,
    opts.organizationId ?? ORG,
    opts.principalRef ?? 'ior_acct_1',
    'broker:1',
    'US',
    opts.authorizationType ?? 'CBP_FORM_5291',
    opts.scope ?? JSON.stringify(['DRAWBACK']),
    opts.effectiveAt ?? '2026-01-01T00:00:00.000Z',
    opts.expiresAt === undefined ? null : opts.expiresAt,
    opts.evidenceArtifactRef === undefined ? 'poa:1' : opts.evidenceArtifactRef,
    opts.status ?? 'VERIFIED',
    opts.source ?? 'MANUAL_REVIEW',
    opts.digest ?? DIGEST_A,
    NOW,
  );

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "CustomsBrokerPoaFact", "CustomsRightLineageFact", "CustomsIorIdentityFact", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'IOR 租户', slug: 'ior-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'IOR 租户B', slug: 'ior-org-b' } });
});

describe('BG-013 — Enterprise IOR facts（真实 PostgreSQL，DB 级不变量）', () => {
  it('同 fact 重放 → UNIQUE(organizationId, contentDigest) exactly-one；corrected fact 追加历史且 latest 为新', async () => {
    await insertIdentity({ id: 'idf-1', digest: DIGEST_A, observedAt: NOW });
    await expect(insertIdentity({ id: 'idf-dup', digest: DIGEST_A })).rejects.toThrow();
    await insertIdentity({ id: 'idf-2', digest: DIGEST_B, observedAt: LATER });
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      'SELECT "id" FROM "CustomsIorIdentityFact" WHERE "organizationId" = $1 AND "importerOfRecordRef" = $2 ORDER BY "observedAt" DESC, "id" DESC',
      ORG,
      'ior_acct_1',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('idf-2');
  });

  it('UPDATE / DELETE 被 append-only 触发器拒绝', async () => {
    await insertIdentity({ id: 'idf-1' });
    await expect(
      prisma.$executeRawUnsafe('UPDATE "CustomsIorIdentityFact" SET "jurisdiction" = $1 WHERE "id" = $2', 'CA', 'idf-1'),
    ).rejects.toThrow(/APPEND_ONLY/);
    await expect(prisma.$executeRawUnsafe('DELETE FROM "CustomsIorIdentityFact" WHERE "id" = $1', 'idf-1')).rejects.toThrow(/APPEND_ONLY/);
  });

  it('裸 EIN / numeric importer number / credential 自由文本 → DB CHECK 拒绝', async () => {
    await expect(insertIdentity({ id: 'idf-ein', iorRef: '12-3456789' })).rejects.toThrow();
    await expect(insertIdentity({ id: 'idf-num', iorRef: '123456789' })).rejects.toThrow();
    await expect(insertIdentity({ id: 'idf-txt', iorRef: 'Bearer sk_live_abc123' })).rejects.toThrow();
  });

  it('跨租户 lineage → 拒绝（引用的 IOR 身份事实必须同租户）', async () => {
    await insertIdentity({ id: 'idf-a', organizationId: ORG });
    await expect(insertLineage({ id: 'lin-b', organizationId: ORG_B, iorRef: 'ior_acct_1' })).rejects.toThrow(/LINEAGE_TENANT/);
    await expect(insertPoa({ id: 'poa-b', organizationId: ORG_B, principalRef: 'ior_acct_1' })).rejects.toThrow(/LINEAGE_TENANT/);
  });

  it('CBP_FORM_4811 作 Broker POA → DB 枚举写入失败（不是 service 返回 unusable）', async () => {
    await insertIdentity({ id: 'idf-1' });
    await expect(insertPoa({ id: 'poa-4811', authorizationType: 'CBP_FORM_4811' })).rejects.toThrow();
  });

  it('Broker POA：VERIFIED 必须带 evidence 且 source ≠ NONE；scope 空 / 过期窗口非法 → 拒绝', async () => {
    await insertIdentity({ id: 'idf-1' });
    await expect(insertPoa({ id: 'poa-no-evidence', evidenceArtifactRef: null })).rejects.toThrow();
    await expect(insertPoa({ id: 'poa-no-source', source: 'NONE' })).rejects.toThrow();
    await expect(insertPoa({ id: 'poa-empty-scope', scope: JSON.stringify([]) })).rejects.toThrow();
    await expect(insertPoa({ id: 'poa-bad-window', effectiveAt: '2026-06-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z' })).rejects.toThrow();
  });

  it('权利链：iorRights 只能是三态（自由文本拒绝）', async () => {
    await insertIdentity({ id: 'idf-1' });
    await expect(
      prisma.$executeRawUnsafe(
        'INSERT INTO "CustomsRightLineageFact" ("id","organizationId","entryReference","importerOfRecordRef","claimantRef","remedyRoute","iorRightsForRemedy","claimantRightsForRemedy","filingAuthorized","outcome","reasonCodes","evidenceKinds","contentDigest","observedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::"CustomsRightLineageOutcome",$11::jsonb,$12::jsonb,$13,$14::timestamp)',
        'lin-bad',
        ORG,
        'entry:1',
        'ior_acct_1',
        'claimant:1',
        'DRAWBACK',
        'MAYBE',
        'CONFIRMED',
        true,
        'COMPLETE',
        JSON.stringify(['OK']),
        JSON.stringify([]),
        'c'.repeat(64),
        NOW,
      ),
    ).rejects.toThrow();
  });


  it('CHANGE A（MSG-20261003-137）：IOR 身份的 VERIFIED 不变量由 DB 保证，且不过度约束', async () => {
    // VERIFIED + source = NONE → 拒绝
    await expect(insertIdentity({ id: 'idf-v-none', source: 'NONE' })).rejects.toThrow();
    // VERIFIED + verifiedAt = NULL → 拒绝
    await expect(insertIdentity({ id: 'idf-v-no-time', verifiedAt: null })).rejects.toThrow();
    // 非 VERIFIED（PENDING / UNVERIFIED）+ verifiedAt = NULL → 可接受（证明不是过度约束）
    await insertIdentity({ id: 'idf-pending', status: 'PENDING', source: 'CUSTOMER_DOCUMENT', verifiedAt: null });
    await insertIdentity({ id: 'idf-unverified', status: 'UNVERIFIED', source: 'NONE', verifiedAt: null, digest: DIGEST_B });
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>('SELECT "id" FROM "CustomsIorIdentityFact" WHERE "organizationId" = $1 ORDER BY "id"', ORG);
    expect(rows.map((row) => row.id)).toEqual(['idf-pending', 'idf-unverified']);
  });

  it('organizationId 隔离：B 租户看不到 A 租户事实', async () => {
    await insertIdentity({ id: 'idf-a', organizationId: ORG });
    await insertLineage({ id: 'lin-a', organizationId: ORG });
    const bRows = await prisma.$queryRawUnsafe<{ id: string }[]>('SELECT "id" FROM "CustomsIorIdentityFact" WHERE "organizationId" = $1', ORG_B);
    const bLineage = await prisma.$queryRawUnsafe<{ id: string }[]>('SELECT "id" FROM "CustomsRightLineageFact" WHERE "organizationId" = $1', ORG_B);
    expect(bRows).toHaveLength(0);
    expect(bLineage).toHaveLength(0);
  });
});
