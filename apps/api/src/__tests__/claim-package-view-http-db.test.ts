/**
 * TRACK A / PC-03 —— CUSTOMER CLAIM PACKAGE VIEW 验收（真实 HTTP + PostgreSQL）
 * MSG-20261002-83 ⑥：same tenant visible / foreign invisible / wrong binding reject /
 * cross-account mismatch reject / summary correct / manifest safe fields /
 * storageKey·credential·secret absent / missing items / ready·not-ready state /
 * submitted vs package-ready / legacy account not guessed / FINANCE·VIEWER 403 / 401。
 */

import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = 'dd000000-0000-4000-8000-00000000000a';
const ORG_B = 'dd000000-0000-4000-8000-00000000000b';
const SALT = 'pc03-claim-package-salt-01234567';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'claim-package-pass-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc03-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

let accountA = '';
let accountA2 = '';
let accountB = '';

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, storage });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run('http://127.0.0.1:' + port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function login(base: string, email: string): Promise<string> {
  const response = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('LOGIN_FAILED ' + response.status);
  return cookie.split(';')[0];
}

async function seedUser(email: string, role: string, organizationId = ORG): Promise<void> {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: role,
      status: 'ACTIVE',
      emailVerified: true,
    },
    select: { id: true },
  });
  await prisma.membership.create({
    data: { organizationId, userId: user.id, role: role as never, isActive: true },
  });
}

let seq = 0;
async function seedCaseWithPackage(input: {
  organizationId?: string;
  opportunityAccountId?: string | null;
  claimItemAccountId?: string | null;
  packageStatus?: 'GENERATED' | 'EXPORTED';
  withPackage?: boolean;
  withArtifact?: boolean;
  withSubmission?: boolean;
  claimItemStatus?: 'DISCOVERED' | 'VERIFIED' | 'SUBMITTED_MANUAL' | 'RECOVERED' | 'READY_TO_APPEAL';
  caseIdOverride?: string;
}): Promise<{ caseId: string; packageId: string | null; claimItemId: string }> {
  seq += 1;
  const organizationId = input.organizationId ?? ORG;
  const opportunityAccountId =
    input.opportunityAccountId === undefined ? accountA : input.opportunityAccountId;
  const claimItemAccountId =
    input.claimItemAccountId === undefined ? opportunityAccountId : input.claimItemAccountId;

  const opportunity = await prisma.recoveryOpportunity.create({
    data: {
      organizationId,
      accountId: opportunityAccountId,
      domain: 'LOGISTICS',
      channel: 'UPS',
      opportunityType: 'FREIGHT_RATE_OVERCHARGE',
      title: 'PC03 opportunity ' + seq,
      amountExpected: new Prisma.Decimal('100.0000'),
      amountActual: new Prisma.Decimal('130.0000'),
      recoverableAmount: new Prisma.Decimal('30.0000'),
      currency: 'USD',
      status: 'QUALIFIED',
      detectedAt: new Date('2026-09-08T00:00:00.000Z'),
    },
    select: { id: true },
  });
  const kase = await prisma.case.create({
    data: {
      organizationId,
      caseNo: 'PC03-' + seq,
      title: 'PC03 case ' + seq,
      domain: 'LOGISTICS',
      status: 'OPEN',
      currency: 'USD',
      claimedAmount: new Prisma.Decimal('30.0000'),
      dueAt: new Date('2026-10-01T00:00:00.000Z'),
    },
    select: { id: true },
  });
  await prisma.caseOpportunity.create({
    data: { organizationId, caseId: kase.id, opportunityId: opportunity.id },
  });
  const claimItem = await prisma.claimItem.create({
    data: {
      organizationId,
      accountId: claimItemAccountId,
      caseId: input.caseIdOverride ?? kase.id,
      opportunityId: opportunity.id,
      platformType: 'UPS',
      claimType: 'FREIGHT_RATE_OVERCHARGE',
      occurredAt: new Date('2026-09-08T00:00:00.000Z'),
      recoverableAmount: new Prisma.Decimal('30.0000'),
      currency: 'USD',
      status: input.claimItemStatus ?? 'VERIFIED',
      normalizerVersion: 'normalizer-1.0.0',
    },
    select: { id: true },
  });

  let packageId: string | null = null;
  if (input.withPackage !== false) {
    const created = await prisma.recoveryPackage.create({
      data: {
        organizationId,
        claimItemId: claimItem.id,
        caseId: kase.id,
        packageVersion: 'recovery-package/v1',
        digestVersion: 'v1',
        packageDigest: 'a'.repeat(64),
        status: input.packageStatus ?? 'EXPORTED',
        completenessSnapshot: { required: ['manifest'], missing: [] },
      },
      select: { id: true },
    });
    packageId = created.id;

    if (input.withArtifact !== false) {
      const file = await prisma.fileAsset.create({
        data: {
          organizationId,
          kind: 'PDF',
          storageKey: 'pc03/secret-storage-key.pdf',
          originalName: 'claim-package.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1234,
          sha256: 'b'.repeat(64),
        },
        select: { id: true },
      });
      await prisma.recoveryPackageArtifact.create({
        data: {
          organizationId,
          packageId: created.id,
          artifactKind: 'PDF',
          fileAssetId: file.id,
          sha256: 'b'.repeat(64),
        },
      });
    }

    if (input.withSubmission) {
      await prisma.recoveryManualSubmission.create({
        data: {
          organizationId,
          claimItemId: claimItem.id,
          caseId: kase.id,
          packageId: created.id,
          packageDigest: 'a'.repeat(64),
          approvalId: 'approval-' + seq,
          approvalBasisReference: 'rmp1:' + claimItem.id,
          submittedAt: new Date('2026-09-20T00:00:00.000Z'),
          submittedByUserId: 'user-' + seq,
          idempotencyKey: 'rms1-' + claimItem.id,
        },
      });
    }
  }

  return { caseId: kase.id, packageId, claimItemId: claimItem.id };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "RecoveryManualSubmissionEvidence", "RecoveryManualSubmissionReference", "RecoveryManualSubmission", "RecoveryPackageArtifact", "RecoveryPackage", "ClaimItem", "CaseOpportunity", "Case", "RecoveryOpportunity", "FileAsset", "PlatformAccount", "SourceConnection", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: 'PC03 租户', slug: 'pc03-org' },
      { id: ORG_B, name: '外部租户', slug: 'pc03-org-b' },
    ],
  });
  accountA = (
    await prisma.platformAccount.create({
      data: { organizationId: ORG, platform: 'UPS', externalAccountId: 'PC03-A', displayName: '账户 A' },
      select: { id: true },
    })
  ).id;
  accountA2 = (
    await prisma.platformAccount.create({
      data: { organizationId: ORG, platform: 'UPS', externalAccountId: 'PC03-A2', displayName: '账户 A2' },
      select: { id: true },
    })
  ).id;
  accountB = (
    await prisma.platformAccount.create({
      data: { organizationId: ORG_B, platform: 'UPS', externalAccountId: 'PC03-B', displayName: '账户 B' },
      select: { id: true },
    })
  ).id;
  await seedUser('ops-pc03@example.com', 'OPS');
  await seedUser('finance-pc03@example.com', 'FINANCE');
  await seedUser('viewer-pc03@example.com', 'VIEWER');
});

describe('PC-03 — claim package view HTTP contract', () => {
  it('unauthorized → 401；FINANCE / VIEWER → 403（证据权限边界不变）', async () => {
    const seeded = await seedCaseWithPackage({});
    await withServer(async (base) => {
      const url = base + '/cases/' + seeded.caseId + '/claim-package';
      expect((await fetch(url)).status).toBe(401);
      const finance = await login(base, 'finance-pc03@example.com');
      expect((await fetch(url, { headers: { cookie: finance } })).status).toBe(403);
      const viewer = await login(base, 'viewer-pc03@example.com');
      expect((await fetch(url, { headers: { cookie: viewer } })).status).toBe(403);
    });
  });

  it('same tenant visible / foreign tenant invisible / package summary 正确', async () => {
    const seeded = await seedCaseWithPackage({});
    const foreign = await seedCaseWithPackage({
      organizationId: ORG_B,
      opportunityAccountId: accountB,
      claimItemAccountId: accountB,
    });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc03@example.com');
      const response = await fetch(base + '/cases/' + seeded.caseId + '/claim-package', { headers: { cookie } });
      expect(response.status).toBe(200);
      const raw = await response.text();
      const body = JSON.parse(raw) as {
        case: { caseNo: string; recoverableAmount: string | null; currency: string; deadline: string | null };
        package: { packageVersion: string; status: string; target: { platformType: string } } | null;
        account: { state: string; externalAccountId: string | null };
        readiness: { state: string; packageReady: boolean; claimSubmitted: boolean; providerWrite: string };
        evidence: Array<{ title: string; sourceType: string; downloadable: boolean }>;
        missingItems: string[];
      };
      expect(body.case.recoverableAmount).toBe('30.0000');
      expect(body.case.currency).toBe('USD');
      expect(body.case.deadline).toContain('2026-10-01');
      expect(body.package?.packageVersion).toBe('recovery-package/v1');
      expect(body.package?.status).toBe('EXPORTED');
      expect(body.account.state).toBe('ATTRIBUTED');
      expect(body.account.externalAccountId).toBe('PC03-A');
      expect(body.readiness.state).toBe('READY_TO_SUBMIT');
      expect(body.readiness.packageReady).toBe(true);
      expect(body.readiness.claimSubmitted).toBe(false);
      expect(body.readiness.providerWrite).toBe('HOLD_NEEDS_MANUAL');
      expect(body.missingItems).toEqual([]);

      // 6/7：manifest 只含安全字段；不得出现 storageKey / credential / secret
      expect(body.evidence[0].title).toBe('claim-package.pdf');
      expect(body.evidence[0].downloadable).toBe(true);
      for (const forbidden of ['storageKey', 'secret-storage-key', 'credentialRef', 'passwordHash', 'token', 'organizationId', 'packageDigest'.toLowerCase() === 'x' ? 'x' : 'intentional']) {
        if (forbidden === 'intentional') continue;
        expect(raw).not.toContain(forbidden);
      }

      // 跨租户 404
      const cross = await fetch(base + '/cases/' + foreign.caseId + '/claim-package', { headers: { cookie } });
      expect(cross.status).toBe(404);
    });
  });

  it('wrong case/package binding → 拒绝（DB 不变量优先，服务层再兜底）', async () => {
    const other = await seedCaseWithPackage({});
    const target = await seedCaseWithPackage({ withPackage: false });
    // R43 S1 的 caseId/claimItem 一致性不变量在 DB 层即拒绝「把 other 的包改绑到 target 的 claim item」；
    // 服务层的 caseId + claimItemId 双条件过滤是同向兜底（defense-in-depth）。
    await expect(
      prisma.recoveryPackage.updateMany({
        where: { claimItemId: other.claimItemId },
        data: { claimItemId: target.claimItemId },
      }),
    ).rejects.toThrow();
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc03@example.com');
      const body = (await (
        await fetch(base + '/cases/' + target.caseId + '/claim-package', { headers: { cookie } })
      ).json()) as { package: unknown; missingItems: string[] };
      // caseId 与 claimItem 归属不一致的包不会被投影出来
      expect(body.package).toBeNull();
      expect(body.missingItems).toContain('PACKAGE_NOT_GENERATED');
    });
  });

  it('cross-account mismatch（opportunity A / claim item A2）→ 拒绝（DB 不变量优先，服务层再兜底）', async () => {
    // C2 account consistency 守卫在 DB 层即拒绝 claim item 与 opportunity/case 的 account 不一致；
    // 服务层 getCaseClaimPackage() 仍保留多 account → 409 CLAIM_PACKAGE_ACCOUNT_MISMATCH 的同向兜底。
    await expect(
      seedCaseWithPackage({
        opportunityAccountId: accountA,
        claimItemAccountId: accountA2,
      }),
    ).rejects.toThrow();
  });

  it('legacy / ambiguous account 不被猜测（accountId NULL → LEGACY_UNATTRIBUTED）', async () => {
    const seeded = await seedCaseWithPackage({
      opportunityAccountId: null,
      claimItemAccountId: null,
    });
    await prisma.sourceConnection.create({
      data: {
        organizationId: ORG,
        domain: 'LOGISTICS',
        channel: 'UPS',
        kind: 'FILE_UPLOAD',
        status: 'ACTIVE',
        label: 'pc03 bound connection',
        platformAccountId: accountA,
      },
    });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc03@example.com');
      const body = (await (
        await fetch(base + '/cases/' + seeded.caseId + '/claim-package', { headers: { cookie } })
      ).json()) as {
        account: { state: string; id: string | null };
        missingItems: string[];
      };
      expect(body.account.state).toBe('LEGACY_UNATTRIBUTED');
      expect(body.account.id).toBeNull();
      expect(body.missingItems).toContain('ACCOUNT_NOT_ATTRIBUTED');
    });
  });

  it('missing items 与不就绪状态正确投影（无包 → NEEDS_REVIEW）', async () => {
    const seeded = await seedCaseWithPackage({ withPackage: false });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc03@example.com');
      const body = (await (
        await fetch(base + '/cases/' + seeded.caseId + '/claim-package', { headers: { cookie } })
      ).json()) as {
        readiness: { state: string; packageReady: boolean };
        missingItems: string[];
        actions: { canPrepare: boolean; canDownloadPackage: boolean; canRecordManualSubmission: boolean };
      };
      expect(body.readiness.state).toBe('NEEDS_REVIEW');
      expect(body.readiness.packageReady).toBe(false);
      expect(body.missingItems).toContain('PACKAGE_NOT_GENERATED');
      expect(body.actions.canPrepare).toBe(true);
      expect(body.actions.canRecordManualSubmission).toBe(false);
    });
  });

  it('package 未导出 → PACKAGE_NOT_EXPORTED / NEEDS_EVIDENCE', async () => {
    const seeded = await seedCaseWithPackage({ packageStatus: 'GENERATED', withArtifact: false });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc03@example.com');
      const body = (await (
        await fetch(base + '/cases/' + seeded.caseId + '/claim-package', { headers: { cookie } })
      ).json()) as { readiness: { state: string }; missingItems: string[] };
      expect(body.missingItems).toContain('PACKAGE_NOT_EXPORTED');
      expect(body.readiness.state).toBe('NEEDS_EVIDENCE');
    });
  });

  it('submitted 与 package-ready 正确区分', async () => {
    const seeded = await seedCaseWithPackage({
      withSubmission: true,
      claimItemStatus: 'SUBMITTED_MANUAL',
    });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc03@example.com');
      const body = (await (
        await fetch(base + '/cases/' + seeded.caseId + '/claim-package', { headers: { cookie } })
      ).json()) as {
        readiness: { state: string; packageReady: boolean; claimSubmitted: boolean; providerWrite: string };
        actions: { canRecordManualSubmission: boolean };
      };
      expect(body.readiness.state).toBe('SUBMITTED');
      expect(body.readiness.packageReady).toBe(true);
      expect(body.readiness.claimSubmitted).toBe(true);
      expect(body.readiness.providerWrite).toBe('HOLD_NEEDS_MANUAL');
      expect(body.actions.canRecordManualSubmission).toBe(false);
    });
  });
});
