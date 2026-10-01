/**
 * R44 —— Manual Recovery HTTP/API Boundary（MSG-20261001-39 NEXT · 真实 HTTP + PostgreSQL）
 * -------------------------------------------------------------------------------------
 * 本批次**只新增入口边界**，业务执行完全复用 R43 S3/S4 服务：
 *   · 身份 / 租户来自会话与路径；跨租户 / 错案件一律 404（不泄露存在性）；
 *   · 客户端不得自证 packageDigest / basis / packageVersion / digestVersion（一律 400）；
 *   · 幂等键由服务端派生（rms1-<claimItemId>），客户端声明不一致 → 409；
 *   · Action Guard（humanApproval）先于任何副作用；缺审批 → 409 且零推进；
 *   · 成功提交 = S3 语义（ClaimItem→SUBMITTED_MANUAL + submission + approval consumption 同事务）；
 *   · 补录 = S4 语义（独立动作 / 独立 binding / append-only），providerAccepted=false。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { LocalFileSystemStorage } from '../services/storage';
import { createAppActionGuard, staticControlPlaneConfig } from '../services/action-guard/runtime-guard-composition';
import type { RuntimeActionGuard } from '../services/action-guard/runtime-guard';
import {
  RECOVERY_MANUAL_REFERENCE_ACTION,
  RECOVERY_MANUAL_SUBMIT_ACTION,
} from '../services/action-guard/approval-verifier';
import { buildRecoveryPackageBasisReference } from '../services/recovery/recovery-package';

const prisma = new PrismaClient();
const SALT = 'r44-http-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'r44-http-pass-1';
const NOW = new Date(Date.now() - 120_000);
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-r44-http-'));
const storage = new LocalFileSystemStorage({ rootDir: storageRoot, secret: SALT, publicBaseUrl: 'http://localhost:3000' });

let ORG = '';
let EMAIL = '';
let ownerId = '';
let caseId = '';
let claimItemId = '';
let packageId = '';
let otherCaseId = '';
let otherPackageId = '';
const liveServers: Array<{ close: (cb: () => void) => void }> = [];
let base = '';

function guard(): RuntimeActionGuard {
  return createAppActionGuard({
    prisma,
    killSwitchResolver: {
      async resolve(scope: string) {
        return { scope, value: 'enabled' as const, degraded: false, stale: false };
      },
    },
    audit: { write: () => {} },
    config: staticControlPlaneConfig({
      globalDisabled: false,
      mode: 'WRITE_ENABLED',
      productionGate: 'SATISFIED',
      platformEnabled: { [RECOVERY_MANUAL_SUBMIT_ACTION]: true, [RECOVERY_MANUAL_REFERENCE_ACTION]: true },
      tenantFeatureEnabled: { [RECOVERY_MANUAL_SUBMIT_ACTION]: true, [RECOVERY_MANUAL_REFERENCE_ACTION]: true },
      hostApprovalGranted: true,
    }),
  });
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  for (const server of liveServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')",
  );
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE ' + tables.map((row) => '"' + row.tablename + '"').join(', ') + ' CASCADE;',
    );
  }
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

async function seedOrganization(suffix: string, label: string): Promise<string> {
  const org = randomUUID();
  await prisma.organization.create({ data: { id: org, name: label, slug: label + '-' + suffix } });
  return org;
}

async function seedCaseWithPackage(org: string, suffix: string, digest: string) {
  const kase = await prisma.case.create({
    data: {
      organizationId: org,
      caseNo: 'R44-' + suffix,
      title: 'R44 fixture',
      domain: 'PLATFORM',
      currency: 'USD',
      openedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  const claim = await prisma.claimItem.create({
    data: {
      organizationId: org,
      caseId: kase.id,
      platformType: 'AMAZON',
      claimType: 'ORDER_DISCREPANCY',
      platformRef: 'AMZ-R44-' + suffix,
      sourceFingerprint: (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64),
      fingerprintVersion: 'v1',
      occurredAt: new Date('2026-09-02T00:00:00.000Z'),
      currency: 'USD',
      status: 'READY_TO_APPEAL',
      normalizerVersion: 'amazon-sp-normalizer/v1',
    },
  });
  const pkg = await prisma.recoveryPackage.create({
    data: {
      organizationId: org,
      claimItemId: claim.id,
      caseId: kase.id,
      packageVersion: 'recovery-package/v1',
      digestVersion: 'v1',
      packageDigest: digest,
    },
  });
  const basisReference = buildRecoveryPackageBasisReference({
    claimItemId: claim.id,
    caseId: kase.id,
    packageVersion: 'recovery-package/v1',
    digestVersion: 'v1',
    packageDigest: digest,
  });
  return { caseId: kase.id, claimItemId: claim.id, packageId: pkg.id, basisReference };
}

beforeEach(async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  EMAIL = 'r44-http-' + suffix + '@example.com';
  ORG = await seedOrganization(suffix, 'r44-http');
  const owner = await prisma.user.create({
    data: {
      email: EMAIL,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  ownerId = owner.id;
  await prisma.membership.create({ data: { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true } });

  const primary = await seedCaseWithPackage(ORG, suffix + 'a', DIGEST_A);
  caseId = primary.caseId;
  claimItemId = primary.claimItemId;
  packageId = primary.packageId;

  const other = await seedCaseWithPackage(ORG, suffix + 'b', DIGEST_B);
  otherCaseId = other.caseId;
  otherPackageId = other.packageId;
});

async function baseFor(): Promise<string> {
  if (base) return base;
  const server = createServer({ prisma, log, audit, storage, actionGuard: guard() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = 'http://127.0.0.1:' + port;
  liveServers.push(server);
  return base;
}

async function login(target: string): Promise<string> {
  const res = await fetch(target + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function post(target: string, cookie: string, path: string, body: Record<string, unknown>) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: target };
  if (cookie !== '') headers.cookie = cookie;
  const res = await fetch(target + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

const submitPath = () => '/cases/' + caseId + '/recovery/manual-submit';
const referencePath = () => '/cases/' + caseId + '/recovery/manual-reference';

/**
 * 播种操作级审批（recovery.review_required → recovery.review_approved）。
 * 说明：R44 只暴露**提交入口**；`recovery.manual_submit` 的审批**创建**入口尚未暴露
 * （现有 reviewRecovery 服务不接受该 boundAction），因此按审批事件的真实结构直接播种，
 * 以便验证入口层与既有 HITL 校验（动作 / 目标 / 载荷 / 五元 extra / 有效期）完全一致。
 */
async function seedApproval(
  basisReference: string,
  boundAction: string = RECOVERY_MANUAL_SUBMIT_ACTION,
  extra: Record<string, unknown> = {},
): Promise<string> {
  await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      action: 'recovery.review_required',
      entityType: 'Case',
      entityId: caseId,
      createdAt: NOW,
      changes: { claimItemId },
    },
  });
  const approved = await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      action: 'recovery.review_approved',
      entityType: 'Case',
      entityId: caseId,
      createdAt: new Date(NOW.getTime() + 1000),
      changes: {
        boundAction,
        boundPayload: {
          recoveredAmount: null,
          currency: null,
          basisReference,
          evidenceArtifactId: null,
          fingerprintVersion: 'v1',
          ...extra,
        },
        expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      },
    },
  });
  return approved.id;
}

/** S3 执行时绑定要求审批同时携带五元 extra（claimItemId/caseId/packageVersion/digestVersion/packageDigest） */
const submitExtra = () => ({
  claimItemId,
  caseId,
  packageVersion: 'recovery-package/v1',
  digestVersion: 'v1',
  packageDigest: DIGEST_A,
});

async function sideEffects() {
  return {
    claimStatus: (await prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId } })).status,
    submissions: await prisma.recoveryManualSubmission.count({ where: { organizationId: ORG } }),
    references: await prisma.recoveryManualSubmissionReference.count({ where: { organizationId: ORG } }),
    manualSubmittedAudits: await prisma.auditLog.count({
      where: { organizationId: ORG, action: 'recovery.manual_submitted' },
    }),
    consumedAudits: await prisma.auditLog.count({
      where: { organizationId: ORG, action: 'recovery.approval_consumed' },
    }),
    settlement: await prisma.settlement.count({ where: { organizationId: ORG } }),
    billingInvoices: await prisma.billingInvoice.count({ where: { organizationId: ORG } }),
  };
}

describe('R44 — Manual Recovery HTTP/API Boundary（真实 HTTP + PostgreSQL）', () => {
  it('R44-01 未认证 → 401 且零推进', async () => {
    const target = await baseFor();
    const res = await post(target, '', submitPath(), { claimItemId, packageId });
    expect(res.status).toBe(401);
    expect(await sideEffects()).toMatchObject({ claimStatus: 'READY_TO_APPEAL', submissions: 0, consumedAudits: 0 });
  }, 60_000);

  it('R44-02 客户端自证服务端事实（packageDigest / basis）→ 400 且零推进', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const res = await post(target, cookie, submitPath(), {
      claimItemId,
      packageId,
      packageDigest: DIGEST_A,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('CLIENT_ASSERTION');
    expect(await sideEffects()).toMatchObject({ claimStatus: 'READY_TO_APPEAL', submissions: 0 });
  }, 60_000);

  it('R44-03 他案件 package → 404（不泄露存在性）且零推进', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const res = await post(target, cookie, submitPath(), { claimItemId, packageId: otherPackageId });
    expect(res.status).toBe(404);
    expect(await sideEffects()).toMatchObject({ claimStatus: 'READY_TO_APPEAL', submissions: 0 });
    expect(otherCaseId).not.toBe(caseId);
  }, 60_000);

  it('R44-04 缺审批 → 409 ACTION_GUARD_HUMAN_APPROVAL_REQUIRED 且零推进', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const res = await post(target, cookie, submitPath(), { claimItemId, packageId });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ACTION_GUARD_HUMAN_APPROVAL_REQUIRED');
    expect(await sideEffects()).toMatchObject({ claimStatus: 'READY_TO_APPEAL', submissions: 0, consumedAudits: 0 });
  }, 60_000);

  it('R44-05 幂等键不一致 → 409 且零推进（服务端派生 rms1-<claimItemId>）', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const res = await post(target, cookie, submitPath(), { claimItemId, packageId, idempotencyKey: 'client-made-key' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('RECOVERY_MANUAL_IDEMPOTENCY_KEY_MISMATCH');
    expect(await sideEffects()).toMatchObject({ claimStatus: 'READY_TO_APPEAL', submissions: 0 });
  }, 60_000);

  it('R44-06 合法提交 → 200 / SUBMITTED_MANUAL / submission + 消费恰一次 / 零平台外写与零资金副作用', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const basis = buildRecoveryPackageBasisReference({
      claimItemId,
      caseId,
      packageVersion: 'recovery-package/v1',
      digestVersion: 'v1',
      packageDigest: DIGEST_A,
    });
    const approvalId = await seedApproval(basis, RECOVERY_MANUAL_SUBMIT_ACTION, submitExtra());
    const res = await post(target, cookie, submitPath(), { claimItemId, approvalId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      claimItemId,
      caseId,
      status: 'SUBMITTED_MANUAL',
      externalSubmission: 'NEEDS_MANUAL',
      platformWriteExecuted: false,
    });
    const after = await sideEffects();
    expect(after).toMatchObject({
      claimStatus: 'SUBMITTED_MANUAL',
      submissions: 1,
      manualSubmittedAudits: 1,
      consumedAudits: 1,
      settlement: 0,
      billingInvoices: 0,
    });
    // 服务端重算的 versioned basis 必须与审批绑定一致（响应回显）
    expect(String(res.body.approvalBasisReference)).toBe(basis);
  }, 60_000);

  it('R44-07 重复提交 → 拒绝且 submission 仍为 1（不产生第二次副作用）', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const basis = buildRecoveryPackageBasisReference({
      claimItemId,
      caseId,
      packageVersion: 'recovery-package/v1',
      digestVersion: 'v1',
      packageDigest: DIGEST_A,
    });
    const approvalId = await seedApproval(basis, RECOVERY_MANUAL_SUBMIT_ACTION, submitExtra());
    expect((await post(target, cookie, submitPath(), { claimItemId, approvalId })).status).toBe(200);
    const replay = await post(target, cookie, submitPath(), { claimItemId, approvalId });
    expect([403, 409]).toContain(replay.status);
    const after = await sideEffects();
    expect(after).toMatchObject({ submissions: 1, consumedAudits: 1 });
  }, 60_000);

  it('R44-08 补录 provider case reference → 200 / canonical 由服务端计算 / providerAccepted=false', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const basis = buildRecoveryPackageBasisReference({
      claimItemId,
      caseId,
      packageVersion: 'recovery-package/v1',
      digestVersion: 'v1',
      packageDigest: DIGEST_A,
    });
    const approvalId = await seedApproval(basis, RECOVERY_MANUAL_SUBMIT_ACTION, submitExtra());
    const submitted = await post(target, cookie, submitPath(), { claimItemId, approvalId });
    expect(submitted.status).toBe(200);
    const submissionId = String(submitted.body.submissionId);

    const referenceBasis = 'rmr1:' + submissionId + ':' + claimItemId + ':CASE-44';
    const refApprovalId = await seedApproval(referenceBasis, RECOVERY_MANUAL_REFERENCE_ACTION, {
      submissionId,
      claimItemId,
      providerCaseRefCanonical: 'CASE-44',
    });
    const res = await post(target, cookie, referencePath(), {
      submissionId,
      providerCaseRefRaw: '  CASE-44  ',
      approvalId: refApprovalId,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      submissionId,
      providerCaseRefRaw: '  CASE-44  ',
      providerCaseRefCanonical: 'CASE-44',
      providerAccepted: false,
      platformWriteExecuted: false,
    });
    const after = await sideEffects();
    expect(after).toMatchObject({ claimStatus: 'SUBMITTED_MANUAL', submissions: 1, references: 1 });
  }, 60_000);

  it('R44-09 补录边界：空 reference → 400；客户端自证 canonical → 400', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const empty = await post(target, cookie, referencePath(), { submissionId: randomUUID(), providerCaseRefRaw: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('RECOVERY_MANUAL_REFERENCE_REQUIRED');
    const asserted = await post(target, cookie, referencePath(), {
      submissionId: randomUUID(),
      providerCaseRefRaw: 'CASE-44',
      providerCaseRefCanonical: 'CASE-44',
    });
    expect(asserted.status).toBe(400);
    expect(String(asserted.body.error)).toContain('CLIENT_ASSERTION');
    expect(await sideEffects()).toMatchObject({ submissions: 0, references: 0 });
  }, 60_000);

  it('R44-10 入口层不复制事务逻辑（静态探针：无 $transaction / FOR UPDATE / updateMany）', async () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'services', 'recovery', 'http-request.ts'),
      'utf8',
    );
    for (const forbidden of ['$transaction', 'FOR UPDATE', 'updateMany', 'pg_advisory']) {
      expect(source.includes(forbidden)).toBe(false);
    }
    // 入口层必须复用 S3/S4 服务与唯一 basis builder
    expect(source).toContain('submitManualRecoveryWithApproval');
    expect(source).toContain('recordManualRecoveryReference');
    expect(source).toContain('buildRecoveryPackageBasisReference');
    expect(source).toContain('buildRecoveryReferenceBasisReference');
  });
});
