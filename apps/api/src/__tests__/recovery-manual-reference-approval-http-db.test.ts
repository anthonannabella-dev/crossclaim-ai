/**
 * R44-B —— Manual Recovery Reference Approval Creation Boundary（MSG-20261001-42 NEXT）
 * ----------------------------------------------------------------------------------
 * 只创建 reference 补录审批：canonical 恒服务端构造；不创建 Reference、不改 Submission/ClaimItem、
 * 不消费 approval、不产生 providerAccepted；与 S3 / R44-A 的 manual-submit 审批严格 action isolation。
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
import { buildRecoveryReferenceBasisReference, canonicalizeProviderCaseRef } from '../services/recovery/manual-reference';

const prisma = new PrismaClient();
const SALT = 'r44b-http-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'r44b-pass-1234';
const DIGEST = 'c'.repeat(64);

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-r44b-'));
const storage = new LocalFileSystemStorage({ rootDir: storageRoot, secret: SALT, publicBaseUrl: 'http://localhost:3000' });

let ORG = '';
let EMAIL = '';
let ownerId = '';
let caseId = '';
let claimItemId = '';
let submissionId = '';
let otherCaseId = '';
const liveServers: Array<{ close: (cb: () => void) => void }> = [];
let base = '';

function guard(): RuntimeActionGuard {
  return createAppActionGuard({
    prisma,
    killSwitchResolver: { async resolve(scope: string) { return { scope, value: 'enabled' as const, degraded: false, stale: false }; } },
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

beforeAll(async () => { await prisma.$connect(); });
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

/** 已提交事实夹具（reference 补录的前提是已存在 Submission） */
async function seedSubmitted(org: string, suffix: string) {
  const kase = await prisma.case.create({
    data: { organizationId: org, caseNo: 'R44B-' + suffix, title: 'R44-B fixture', domain: 'PLATFORM', currency: 'USD', openedAt: new Date('2026-09-01T00:00:00.000Z') },
  });
  const claim = await prisma.claimItem.create({
    data: {
      organizationId: org,
      caseId: kase.id,
      platformType: 'AMAZON',
      claimType: 'ORDER_DISCREPANCY',
      platformRef: 'AMZ-R44B-' + suffix,
      sourceFingerprint: (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64),
      fingerprintVersion: 'v1',
      occurredAt: new Date('2026-09-02T00:00:00.000Z'),
      currency: 'USD',
      status: 'SUBMITTED_MANUAL',
      normalizerVersion: 'amazon-sp-normalizer/v1',
    },
  });
  const pkg = await prisma.recoveryPackage.create({
    data: { organizationId: org, claimItemId: claim.id, caseId: kase.id, packageVersion: 'recovery-package/v1', digestVersion: 'v1', packageDigest: DIGEST },
  });
  const member = await prisma.membership.findFirst({ where: { organizationId: org, isActive: true }, select: { userId: true } });
  const submission = await prisma.recoveryManualSubmission.create({
    data: {
      organizationId: org,
      claimItemId: claim.id,
      caseId: kase.id,
      packageId: pkg.id,
      packageDigest: DIGEST,
      approvalId: randomUUID(),
      approvalBasisReference: buildRecoveryPackageBasisReference({ claimItemId: claim.id, caseId: kase.id, packageVersion: 'recovery-package/v1', digestVersion: 'v1', packageDigest: DIGEST }),
      submittedAt: new Date('2026-09-03T00:00:00.000Z'),
      submittedByUserId: member?.userId ?? ownerId,
      idempotencyKey: 'rms1-' + claim.id,
    },
    select: { id: true },
  });
  return { caseId: kase.id, claimItemId: claim.id, submissionId: submission.id };
}

beforeEach(async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  EMAIL = 'r44b-' + suffix + '@example.com';
  ORG = randomUUID();
  await prisma.organization.create({ data: { id: ORG, name: 'r44b 租户', slug: 'r44b-' + suffix } });
  const owner = await prisma.user.create({
    data: { email: EMAIL, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'OWNER', status: 'ACTIVE', emailVerified: true },
  });
  ownerId = owner.id;
  await prisma.membership.create({ data: { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true } });
  const primary = await seedSubmitted(ORG, suffix + 'a');
  caseId = primary.caseId;
  claimItemId = primary.claimItemId;
  submissionId = primary.submissionId;
  const other = await seedSubmitted(ORG, suffix + 'b');
  otherCaseId = other.caseId;
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

async function login(target: string, email = EMAIL): Promise<string> {
  const res = await fetch(target + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
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

const approvalPath = () => '/cases/' + caseId + '/recovery/manual-reference-approval';
const referenceExecPath = () => '/cases/' + caseId + '/recovery/manual-reference';
const submitExecPath = () => '/cases/' + caseId + '/recovery/manual-submit';
const basisFor = (canonical: string) => buildRecoveryReferenceBasisReference({ submissionId, claimItemId, providerCaseRefCanonical: canonical });

async function counters() {
  const [submission, references, consumed, reviewApproved, settlements, billing] = await Promise.all([
    prisma.recoveryManualSubmission.findUniqueOrThrow({ where: { id: submissionId }, select: { id: true, claimItemId: true, caseId: true, packageDigest: true } }),
    prisma.recoveryManualSubmissionReference.count({ where: { organizationId: ORG } }),
    prisma.auditLog.count({ where: { organizationId: ORG, action: 'recovery.approval_consumed' } }),
    prisma.auditLog.count({ where: { organizationId: ORG, action: 'recovery.review_approved' } }),
    prisma.settlement.count({ where: { organizationId: ORG } }),
    prisma.billingInvoice.count({ where: { organizationId: ORG } }),
  ]);
  const claim = await prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId }, select: { status: true } });
  return { claimStatus: claim.status, submissionDigest: submission.packageDigest, references, consumed, reviewApproved, settlements, billing };
}

describe('R44-B — Reference Approval Creation Boundary（真实 HTTP + PostgreSQL）', () => {
  it('B-01 未认证 → 401 零副作用', async () => {
    const target = await baseFor();
    const before = await counters();
    const res = await post(target, '', approvalPath(), { submissionId, providerCaseRefRaw: 'CASE-B1' });
    expect(res.status).toBe(401);
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('B-02 非法角色（VIEWER）→ 403/401 零副作用', async () => {
    const target = await baseFor();
    const viewerEmail = 'r44b-viewer-' + randomUUID().slice(0, 8) + '@example.com';
    const viewer = await prisma.user.create({ data: { email: viewerEmail, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'VIEWER', status: 'ACTIVE', emailVerified: true } });
    await prisma.membership.create({ data: { organizationId: ORG, userId: viewer.id, role: 'VIEWER', isActive: true } });
    const cookie = await login(target, viewerEmail);
    const before = await counters();
    const res = await post(target, cookie, approvalPath(), { submissionId, providerCaseRefRaw: 'CASE-B2' });
    expect([403, 401]).toContain(res.status);
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('B-03 跨租户 / 错案件 / 错 submission → 404 零副作用', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const before = await counters();
    const wrongCase = await post(target, cookie, '/cases/' + otherCaseId + '/recovery/manual-reference-approval', { submissionId, providerCaseRefRaw: 'CASE-B3' });
    expect(wrongCase.status).toBe(404);
    const wrongSubmission = await post(target, cookie, approvalPath(), { submissionId: randomUUID(), providerCaseRefRaw: 'CASE-B3' });
    expect(wrongSubmission.status).toBe(404);
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('B-04 raw reference 为空 → 400 零副作用', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const before = await counters();
    const res = await post(target, cookie, approvalPath(), { submissionId, providerCaseRefRaw: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('RECOVERY_MANUAL_APPROVAL_REFERENCE_REQUIRED');
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('B-05 客户端伪造 canonical reference → 400 零副作用', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const before = await counters();
    const res = await post(target, cookie, approvalPath(), { submissionId, providerCaseRefRaw: 'CASE-B5', providerCaseRefCanonical: 'FORGED' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('CLIENT_ASSERTION');
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('B-06 REQUEST → PENDING；canonical/basis 由服务端生成；creation 不创建 Reference / 不改 Submission·ClaimItem / 不消费 approval / 无 providerAccepted / 资金域 0', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const before = await counters();
    const res = await post(target, cookie, approvalPath(), { submissionId, decision: 'REQUEST', providerCaseRefRaw: '  CASE-B6  ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ decision: 'REQUEST', state: 'PENDING', submissionId, providerAccepted: false, platformWriteExecuted: false });
    expect(String(res.body.providerCaseRefCanonical)).toBe('CASE-B6');
    expect(String(res.body.approvalBasisReference)).toBe(basisFor('CASE-B6'));
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('B-07 APPROVE → 创建的 approval 可被 R44 reference execution 消费一次（端到端）', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    await post(target, cookie, approvalPath(), { submissionId, decision: 'REQUEST', providerCaseRefRaw: 'CASE-B7' });
    const approved = await post(target, cookie, approvalPath(), { submissionId, decision: 'APPROVE', providerCaseRefRaw: 'CASE-B7' });
    expect(approved.status).toBe(200);
    const approvalId = String(approved.body.approvalId);
    expect(approvalId).not.toBe('');
    expect((await counters()).references).toBe(0);
    const executed = await post(target, cookie, referenceExecPath(), { submissionId, providerCaseRefRaw: 'CASE-B7', approvalId });
    expect(executed.status).toBe(200);
    expect(executed.body).toMatchObject({ submissionId, providerCaseRefRaw: 'CASE-B7', providerCaseRefCanonical: 'CASE-B7', providerAccepted: false, platformWriteExecuted: false });
    const after = await counters();
    expect(after).toMatchObject({ claimStatus: 'SUBMITTED_MANUAL', references: 1, consumed: 1, settlements: 0, billing: 0 });
  }, 60_000);

  it('B-08 同 canonical 重复 APPROVE → 幂等复用同一 approvalId（事件数不增）', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    await post(target, cookie, approvalPath(), { submissionId, decision: 'REQUEST', providerCaseRefRaw: 'CASE-B8' });
    const first = await post(target, cookie, approvalPath(), { submissionId, decision: 'APPROVE', providerCaseRefRaw: ' CASE-B8 ' });
    const approvedCount = (await counters()).reviewApproved;
    const second = await post(target, cookie, approvalPath(), { submissionId, decision: 'APPROVE', providerCaseRefRaw: 'CASE-B8' });
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(String(second.body.approvalId)).toBe(String(first.body.approvalId));
    expect((await counters()).reviewApproved).toBe(approvedCount);
  }, 60_000);

  it('B-09 action isolation（双向）：manual-submit 审批不能用于 reference 补录，反之亦然', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    // reference 审批 → 不能用于 manual-submit execution（此刻 claim 已是 SUBMITTED_MANUAL，service 会先拒绝；关键是 action 不匹配亦 fail-closed）
    await post(target, cookie, approvalPath(), { submissionId, decision: 'REQUEST', providerCaseRefRaw: 'CASE-B9' });
    const refApproval = await post(target, cookie, approvalPath(), { submissionId, decision: 'APPROVE', providerCaseRefRaw: 'CASE-B9' });
    const misuse = await post(target, cookie, submitExecPath(), { claimItemId, approvalId: String(refApproval.body.approvalId) });
    expect(misuse.status).toBeGreaterThanOrEqual(400);
    // manual-submit 审批（R44-A 路径）不能用于 reference 补录
    await post(target, cookie, '/cases/' + caseId + '/recovery/manual-submit-approval', { claimItemId, decision: 'REQUEST' });
    const submitApproval = await post(target, cookie, '/cases/' + caseId + '/recovery/manual-submit-approval', { claimItemId, decision: 'APPROVE' });
    expect(submitApproval.status).toBe(200);
    const misuse2 = await post(target, cookie, referenceExecPath(), { submissionId, providerCaseRefRaw: 'CASE-B9', approvalId: String(submitApproval.body.approvalId) });
    expect(misuse2.status).toBeGreaterThanOrEqual(400);
    expect((await counters()).references).toBe(0);
  }, 60_000);

  it('B-10 canonical 变化：用不同 raw 的 execution 必须 fail-closed 且零副作用', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    await post(target, cookie, approvalPath(), { submissionId, decision: 'REQUEST', providerCaseRefRaw: 'CASE-B10-A' });
    const approved = await post(target, cookie, approvalPath(), { submissionId, decision: 'APPROVE', providerCaseRefRaw: 'CASE-B10-A' });
    const before = await counters();
    const res = await post(target, cookie, referenceExecPath(), { submissionId, providerCaseRefRaw: 'CASE-B10-B', approvalId: String(approved.body.approvalId) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('B-11 非法 decision → 400 零副作用', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const before = await counters();
    const res = await post(target, cookie, approvalPath(), { submissionId, providerCaseRefRaw: 'CASE-B11', decision: 'NOPE' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('RECOVERY_MANUAL_APPROVAL_INVALID_DECISION');
    expect(await counters()).toEqual(before);
  }, 60_000);

  it('B-12 canonical 化规则：NFKC / 去零宽 / 折叠空白 / 不 lower-case（服务端生成）', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const rawWithZeroWidth = '  case-b12' + String.fromCharCode(0x200b) + '   X  ';
    const res = await post(target, cookie, approvalPath(), { submissionId, decision: 'REQUEST', providerCaseRefRaw: rawWithZeroWidth });
    expect(res.status).toBe(200);
    expect(String(res.body.providerCaseRefCanonical)).toBe(canonicalizeProviderCaseRef(rawWithZeroWidth));
    expect(String(res.body.providerCaseRefCanonical)).toBe('case-b12 X');
  }, 60_000);
});
