/**
 * R44-A —— Manual Recovery Approval Creation Boundary（MSG-20261001-41 NEXT · 真实 HTTP + PostgreSQL）
 * -------------------------------------------------------------------------------------------
 * 只创建审批事实：不执行提交、不改变 ClaimItem、不产生 Submission、不消费 approval。
 * creation 与 execution 使用**同一个** server-side package/basis builder（resolveManualSubmissionTarget）。
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
const SALT = 'r44a-http-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'r44a-pass-1234';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-r44a-'));
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
  for (const server of liveServers) await new Promise<void>((resolve) => server.close(() => resolve()));
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')",
  );
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE ' + tables.map((row) => '"' + row.tablename + '"').join(', ') + ' CASCADE;');
  }
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

async function seedCaseWithPackage(org: string, suffix: string, digest: string) {
  const kase = await prisma.case.create({
    data: { organizationId: org, caseNo: 'R44A-' + suffix, title: 'R44-A fixture', domain: 'PLATFORM', currency: 'USD', openedAt: new Date('2026-09-01T00:00:00.000Z') },
  });
  const claim = await prisma.claimItem.create({
    data: {
      organizationId: org,
      caseId: kase.id,
      platformType: 'AMAZON',
      claimType: 'ORDER_DISCREPANCY',
      platformRef: 'AMZ-R44A-' + suffix,
      sourceFingerprint: (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64),
      fingerprintVersion: 'v1',
      occurredAt: new Date('2026-09-02T00:00:00.000Z'),
      currency: 'USD',
      status: 'READY_TO_APPEAL',
      normalizerVersion: 'amazon-sp-normalizer/v1',
    },
  });
  const pkg = await prisma.recoveryPackage.create({
    data: { organizationId: org, claimItemId: claim.id, caseId: kase.id, packageVersion: 'recovery-package/v1', digestVersion: 'v1', packageDigest: digest },
  });
  return { caseId: kase.id, claimItemId: claim.id, packageId: pkg.id };
}

beforeEach(async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  EMAIL = 'r44a-' + suffix + '@example.com';
  ORG = randomUUID();
  await prisma.organization.create({ data: { id: ORG, name: 'r44a 租户', slug: 'r44a-' + suffix } });
  const owner = await prisma.user.create({
    data: { email: EMAIL, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'OWNER', status: 'ACTIVE', emailVerified: true },
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

async function login(target: string, email = EMAIL, password = PASSWORD): Promise<string> {
  const res = await fetch(target + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function post(target: string, cookie: string, urlPath: string, body: Record<string, unknown>) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: target };
  if (cookie !== '') headers.cookie = cookie;
  const res = await fetch(target + urlPath, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

const approvalPath = () => '/cases/' + caseId + '/recovery/manual-submit-approval';
const executionPath = () => '/cases/' + caseId + '/recovery/manual-submit';
const basisA = () => buildRecoveryPackageBasisReference({ claimItemId, caseId, packageVersion: 'recovery-package/v1', digestVersion: 'v1', packageDigest: DIGEST_A });

async function counters() {
  const [claim, submissions, references, consumed, reviewApproved, settlements, billing] = await Promise.all([
    prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId }, select: { status: true } }),
    prisma.recoveryManualSubmission.count({ where: { organizationId: ORG } }),
    prisma.recoveryManualSubmissionReference.count({ where: { organizationId: ORG } }),
    prisma.auditLog.count({ where: { organizationId: ORG, action: 'recovery.approval_consumed' } }),
    prisma.auditLog.count({ where: { organizationId: ORG, action: 'recovery.review_approved' } }),
    prisma.settlement.count({ where: { organizationId: ORG } }),
    prisma.billingInvoice.count({ where: { organizationId: ORG } }),
  ]);
  return { claimStatus: claim.status, submissions, references, consumed, reviewApproved, settlements, billing };
}

describe('R44-A — Manual Recovery Approval Creation Boundary（真实 HTTP + PostgreSQL）', () => {
  it('A-01 未认证 → 401 且零副作用', async () => {
    const target = await baseFor();
    const before = await counters();
    const res = await post(target, '', approvalPath(), { claimItemId, decision: 'APPROVE' });
    expect(res.status).toBe(401);
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('A-02 非法角色（VIEWER）→ 403 且零副作用', async () => {
    const target = await baseFor();
    const viewerEmail = 'r44a-viewer-' + randomUUID().slice(0, 8) + '@example.com';
    const viewer = await prisma.user.create({
      data: { email: viewerEmail, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'VIEWER', status: 'ACTIVE', emailVerified: true },
    });
    await prisma.membership.create({ data: { organizationId: ORG, userId: viewer.id, role: 'VIEWER', isActive: true } });
    const cookie = await login(target, viewerEmail);
    const before = await counters();
    const res = await post(target, cookie, approvalPath(), { claimItemId, decision: 'APPROVE' });
    expect([403, 401]).toContain(res.status);
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('A-03 跨租户案件路径 / 同租户错案件 → 404 且零副作用', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const otherOrg = randomUUID();
    await prisma.organization.create({ data: { id: otherOrg, name: 'r44a 他租户', slug: 'r44a-x-' + randomUUID().slice(0, 8) } });
    const foreign = await seedCaseWithPackage(otherOrg, randomUUID().replace(/-/g, '').slice(0, 8), DIGEST_B);
    const before = await counters();
    const cross = await post(target, cookie, '/cases/' + foreign.caseId + '/recovery/manual-submit-approval', { claimItemId, decision: 'APPROVE' });
    expect(cross.status).toBe(404);
    const wrongCase = await post(target, cookie, '/cases/' + otherCaseId + '/recovery/manual-submit-approval', { claimItemId, decision: 'APPROVE' });
    expect(wrongCase.status).toBe(404);
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('A-04 package 与 ClaimItem/Case 错绑定（他案 packageId）→ 404', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const before = await counters();
    const res = await post(target, cookie, approvalPath(), { claimItemId, packageId: otherPackageId, decision: 'APPROVE' });
    expect(res.status).toBe(404);
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('A-05 客户端伪造 digest / basis / version → 400 且零副作用', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const before = await counters();
    for (const field of ['packageDigest', 'approvalBasisReference', 'packageVersion', 'digestVersion']) {
      const res = await post(target, cookie, approvalPath(), { claimItemId, decision: 'APPROVE', [field]: 'forged' });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('CLIENT_ASSERTION');
    }
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('A-06 package 终态 → 409 不得创建新 approval', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    await prisma.recoveryPackage.update({
      where: { id: packageId },
      data: { status: 'WITHDRAWN', transitionReason: 'R44-A test', transitionActorUserId: ownerId },
    });
    const before = await counters();
    const res = await post(target, cookie, approvalPath(), { claimItemId, packageId, decision: 'APPROVE' });
    expect([409, 404]).toContain(res.status);
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('A-07/A-13/A-14 REQUEST → PENDING；不改 ClaimItem / 不产生 Submission / 不消费 approval / 资金域 0', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const res = await post(target, cookie, approvalPath(), { claimItemId, decision: 'REQUEST' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ decision: 'REQUEST', state: 'PENDING', claimItemId, packageId, platformWriteExecuted: false });
    expect(String(res.body.approvalBasisReference)).toBe(basisA());
    expect(await counters()).toMatchObject({ claimStatus: 'READY_TO_APPEAL', submissions: 0, references: 0, consumed: 0, reviewApproved: 0, settlements: 0, billing: 0 });
  }, 60_000);

  it('A-09/A-10 APPROVE 创建审批 → 可被 R44 execution endpoint 消费（端到端贯通）', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    expect((await post(target, cookie, approvalPath(), { claimItemId, decision: 'REQUEST' })).status).toBe(200);
    const approved = await post(target, cookie, approvalPath(), { claimItemId, decision: 'APPROVE' });
    expect(approved.status).toBe(200);
    const approvalId = String(approved.body.approvalId);
    expect(approvalId).not.toBe('');
    expect(String(approved.body.approvalBasisReference)).toBe(basisA());
    // creation 不消费 approval
    expect((await counters()).consumed).toBe(0);
    const executed = await post(target, cookie, executionPath(), { claimItemId, approvalId });
    expect(executed.status).toBe(200);
    expect(executed.body).toMatchObject({ status: 'SUBMITTED_MANUAL', externalSubmission: 'NEEDS_MANUAL', platformWriteExecuted: false });
    expect(await counters()).toMatchObject({ claimStatus: 'SUBMITTED_MANUAL', submissions: 1, consumed: 1, settlements: 0, billing: 0 });
  }, 60_000);

  it('A-08 相同 package/basis 重复 APPROVE → 幂等复用同一 approvalId（不重复建事件）', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    await post(target, cookie, approvalPath(), { claimItemId, decision: 'REQUEST' });
    const first = await post(target, cookie, approvalPath(), { claimItemId, decision: 'APPROVE' });
    expect(first.status).toBe(200);
    const approvedCount = (await counters()).reviewApproved;
    const second = await post(target, cookie, approvalPath(), { claimItemId, decision: 'APPROVE' });
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(String(second.body.approvalId)).toBe(String(first.body.approvalId));
    expect((await counters()).reviewApproved).toBe(approvedCount);
  }, 60_000);

  it('A-11 创建后 package 变为终态 → R44 execution fail-closed 且零副作用', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    await post(target, cookie, approvalPath(), { claimItemId, decision: 'REQUEST' });
    const approved = await post(target, cookie, approvalPath(), { claimItemId, decision: 'APPROVE' });
    const approvalId = String(approved.body.approvalId);
    await prisma.recoveryPackage.update({
      where: { id: packageId },
      data: { status: 'WITHDRAWN', transitionReason: 'R44-A package change', transitionActorUserId: ownerId },
    });
    const before = await counters();
    const res = await post(target, cookie, executionPath(), { claimItemId, approvalId });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('A-12 approval 过期 → execution 拒绝且零副作用', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    await post(target, cookie, approvalPath(), { claimItemId, decision: 'REQUEST' });
    const approved = await post(target, cookie, approvalPath(), { claimItemId, decision: 'APPROVE', approvalTtlMs: 1 });
    expect(approved.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const before = await counters();
    const res = await post(target, cookie, executionPath(), { claimItemId, approvalId: String(approved.body.approvalId) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('A-15 非法 decision → 400 且零副作用', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const before = await counters();
    const res = await post(target, cookie, approvalPath(), { claimItemId, decision: 'DELETE_EVERYTHING' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('RECOVERY_MANUAL_APPROVAL_INVALID_DECISION');
    expect(await counters()).toEqual(before);
  }, 60_000);
});
