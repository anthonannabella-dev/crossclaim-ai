/**
 * Gate 7 / ② RUNTIME BUSINESS BLOCKING · appeal.submit（Appeal 人工提交 · 真实 HTTP + PostgreSQL）
 * 依据 MSG-20261001-14 §5：独立动作（审批不得与 claim.submit 通用）；审批绑定具体 Appeal/案件；
 * 共用案件锁 + Appeal 行锁；锁后重验主体/权限/审批生命周期/载荷；内部提交记录 + 业务审计 + 审批消费同事务；
 * 拒绝零推进；仅登记内部结果（NEEDS_MANUAL / platformWriteExecuted=false），不调用平台写入面。
 */

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
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
import { createAppActionGuard, staticControlPlaneConfig } from '../services/action-guard/runtime-guard-composition';
import type { RuntimeActionGuard } from '../services/action-guard/runtime-guard';
import { handleWorkflowRequest, type WorkflowRouteDeps } from '../services/workflow/http-routes';
import { SESSION_COOKIE } from '../services/auth/http-routes';
import { submitRecoveryReview } from '../services/workflow/recovery-review';
import { APPEAL_SUBMIT_ACTION, CLAIM_SUBMIT_ACTION } from '../services/action-guard/approval-verifier';
import { buildAppealSubmissionSnapshot, appealSubmissionDigest } from '../services/appeals/appeal-snapshot';

const prisma = new PrismaClient();
let ORG = '';
const SALT = 'appeal-submit-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'appeal-submit-pass-1';
let EMAIL = '';
const NOW = new Date(Date.now() - 60_000);

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-appeal-submit-'));
const storage = new LocalFileSystemStorage({ rootDir: storageRoot, secret: SALT, publicBaseUrl: 'http://localhost:3000' });

let ownerId = '';
let caseId = '';
let appealId = '';
let claimId = '';
const liveServers: Array<{ close: (cb: () => void) => void }> = [];
let base = '';

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
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((r) => '"' + r.tablename + '"').join(', ')} CASCADE;`);
  }
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  ORG = randomUUID();
  EMAIL = `appeal-submit-${suffix}@example.com`;
  await prisma.organization.create({ data: { id: ORG, name: 'appeal.submit 租户', slug: `appeal-submit-${suffix}` } });
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
  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: `AS-${suffix}`,
      title: 'appeal.submit 用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('5000.0000'),
      currency: 'USD',
    },
  });
  caseId = kase.id;
  const claim = await prisma.claim.create({
    data: { organizationId: ORG, caseId, round: 1, status: 'REJECTED', target: 'CARRIER', aiDraftText: 'draft' },
  });
  claimId = claim.id;
  const appeal = await prisma.appeal.create({
    data: { organizationId: ORG, claimId, caseId, round: 2, status: 'DRAFT', finalText: 'appeal body (final)' },
  });
  appealId = appeal.id;
});

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
      platformEnabled: { [APPEAL_SUBMIT_ACTION]: true },
      tenantFeatureEnabled: { [APPEAL_SUBMIT_ACTION]: true },
      hostApprovalGranted: true,
    }),
  });
}

async function baseFor(): Promise<string> {
  if (base) return base;
  const server = createServer({ prisma, log, audit, storage, actionGuard: guard() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  liveServers.push(server);
  return base;
}

async function login(target: string): Promise<string> {
  const res = await fetch(`${target}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function submit(target: string, cookie: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${target}/cases/${caseId}/appeal/submit`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: target },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** 经既有服务播种操作级审批（动作 + 载荷依据由调用方指定） */
/** 当前服务端快照摘要（审批必须绑定它；CHANGE A） */
async function currentSnapshotDigest(): Promise<string> {
  const appeal = await prisma.appeal.findUniqueOrThrow({
    where: { id: appealId },
    select: { id: true, caseId: true, claimId: true, round: true, finalText: true, aiDraftText: true },
  });
  const snapshot = buildAppealSubmissionSnapshot({
    appealId: appeal.id,
    caseId: appeal.caseId,
    claimId: appeal.claimId,
    round: appeal.round,
    finalText: appeal.finalText,
    aiDraftText: appeal.aiDraftText,
  });
  if (!snapshot) throw new Error('SNAPSHOT_NULL');
  return appealSubmissionDigest(snapshot);
}

async function seedApproval(basisReference: string, boundAction: string = APPEAL_SUBMIT_ACTION): Promise<string> {
  await submitRecoveryReview(
    prisma,
    { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', caseId, decision: 'REQUEST', recoveredAmount: null, currency: null } as never,
    () => NOW,
  );
  const approved = (await submitRecoveryReview(
    prisma,
    {
      organizationId: ORG,
      actorUserId: ownerId,
      role: 'OWNER',
      caseId,
      decision: 'APPROVE',
      boundAction,
      boundPayload: { basisReference: basisReference === 'SNAPSHOT' ? await currentSnapshotDigest() : basisReference },
    } as never,
    () => new Date(NOW.getTime() + 1000),
  )) as { approvalId?: string };
  if (!approved.approvalId) throw new Error('APPROVAL_NOT_CREATED');
  return approved.approvalId;
}

async function sideEffects() {
  const appeal = await prisma.appeal.findUniqueOrThrow({ where: { id: appealId } });
  return {
    appealStatus: appeal.status,
    submittedAt: appeal.submittedAt,
    submittedAudits: await prisma.auditLog.count({ where: { organizationId: ORG, action: 'appeal.submitted_by_human' } }),
    rejectedAudits: await prisma.auditLog.count({ where: { organizationId: ORG, action: 'appeal.submit_rejected' } }),
    consumedAudits: await prisma.auditLog.count({ where: { organizationId: ORG, action: { contains: 'consumed' } } }),
    // 真实口径：库内 BillingInvoice 行数（不是平台调用计数）；零外写由实现路径 + 静态探针证明
    billingInvoices: await prisma.billingInvoice.count({ where: { organizationId: ORG } }),
  };
}

const caseLockKey = () => `cc-recovery-case:${caseId}`;

async function advisoryLockCount(key: string, granted: boolean): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM pg_locks l
      WHERE l.locktype = 'advisory' AND l.granted = ${granted ? 'true' : 'false'}
        AND (l.objid::text = ((hashtext($1)::bigint & 4294967295))::text
             OR l.classid::text = ((hashtext($1)::bigint & 4294967295))::text)`,
    key,
  );
  return Number(rows[0]?.n ?? 0n);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`CONTROL_POINT_TIMEOUT:${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function holdCaseLock(): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  void prisma
    .$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', caseLockKey());
        await gate;
      },
      { timeout: 30_000, maxWait: 30_000 },
    )
    .catch(() => undefined);
  await waitFor(async () => (await advisoryLockCount(caseLockKey(), true)) >= 1, 10_000, 'CASE_LOCK_NOT_GRANTED');
  return release;
}

async function callWorkflowDirect() {
  const req = Readable.from([Buffer.from(JSON.stringify({ approvalId: 'any' }))]) as unknown as IncomingMessage;
  const reqAny = req as unknown as { url?: string; method?: string; headers?: Record<string, string> };
  reqAny.url = `/cases/${caseId}/appeal/submit`;
  reqAny.method = 'POST';
  reqAny.headers = { cookie: `${SESSION_COOKIE}=direct`, 'content-type': 'application/json', origin: 'http://127.0.0.1' };
  let status = 0;
  let payload: Record<string, unknown> | null = null;
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(data?: string) {
      payload = data ? (JSON.parse(data) as Record<string, unknown>) : null;
    },
  } as unknown as ServerResponse;
  const deps: WorkflowRouteDeps = {
    prisma,
    session: {
      sessions: {
        create: async () => ({ id: 'appeal-direct' }),
        findByTokenHash: async () => ({
          id: 'appeal-direct',
          organizationId: ORG,
          userId: ownerId,
          createdAt: new Date(),
          lastSeenAt: new Date(),
          expiresAt: new Date(Date.now() + 3_600_000),
          revokedAt: null,
        }),
        touch: async () => undefined,
        revoke: async () => undefined,
        revokeAllForUser: async () => 0,
      },
      memberships: {
        findActive: async () => ({ organizationId: ORG, userId: ownerId, role: 'OWNER' }),
        listActiveForUser: async () => [{ organizationId: ORG, userId: ownerId, role: 'OWNER' }],
      },
      audit,
      ipSalt: SALT,
    },
  };
  await handleWorkflowRequest(req, res, deps);
  return { status, body: payload as Record<string, unknown> | null };
}

/** 独立执行人（ADMIN）：角色可在测试中被降级 */
async function createMember(role: 'OWNER' | 'ADMIN' | 'FINANCE' | 'OPS'): Promise<{ userId: string; email: string }> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const email = `appeal-submit-${role.toLowerCase()}-${suffix}@example.com`;
  const user = await prisma.user.create({
    data: { email, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: role, status: 'ACTIVE', emailVerified: true },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: user.id, role, isActive: true } });
  return { userId: user.id, email };
}

async function loginAs(target: string, email: string): Promise<string> {
  const res = await fetch(`${target}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

/** 独立连接持有 Appeal 行锁；返回释放函数与夹具后端 pid */
async function holdAppealRowLock(): Promise<{ release: () => void; pid: Promise<number> }> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolvePid: (value: number) => void = () => {};
  const pid = new Promise<number>((resolve) => {
    resolvePid = resolve;
  });
  void prisma
    .$transaction(
      async (tx) => {
        const pinned = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
        resolvePid(Number(pinned[0]?.pid ?? 0));
        await tx.$queryRawUnsafe('SELECT id FROM "Appeal" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE', appealId, ORG);
        await gate;
      },
      { timeout: 30_000, maxWait: 30_000 },
    )
    .catch(() => undefined);
  return { release, pid };
}

async function blockedByPidCount(pid: number): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    'SELECT count(*)::bigint AS n FROM pg_stat_activity a WHERE $1::int = ANY(pg_blocking_pids(a.pid))',
    pid,
  );
  return Number(rows[0]?.n ?? 0n);
}

async function withAuditActionBlocked<T>(action: string, run: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "AuditLog" ADD CONSTRAINT appeal_submit_block_audit CHECK (action <> '${action}') NOT VALID`,
  );
  try {
    return await run();
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS appeal_submit_block_audit');
  }
}

describe('② RUNTIME BUSINESS BLOCKING — appeal.submit（真实 HTTP + PostgreSQL）', () => {
  it('01 缺 approvalId → 409 ACTION_GUARD_HUMAN_APPROVAL_REQUIRED 且零推进', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const res = await submit(target, cookie, {});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ACTION_GUARD_HUMAN_APPROVAL_REQUIRED');
    const after = await sideEffects();
    expect(after).toMatchObject({ appealStatus: 'DRAFT', submittedAt: null, submittedAudits: 0, consumedAudits: 0 });
  }, 60_000);

  it('02 审批动作不通用：claim.submit 的审批不能用于 appeal.submit', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const approvalId = await seedApproval('SNAPSHOT', CLAIM_SUBMIT_ACTION);
    const res = await submit(target, cookie, { approvalId });
    expect(res.status).toBe(403);
    expect(res.body.error).not.toBe('');
    const after = await sideEffects();
    expect(after).toMatchObject({ appealStatus: 'DRAFT', submittedAt: null, submittedAudits: 0, consumedAudits: 0 });
  }, 60_000);

  it('03 合法提交 → SUBMITTED + 审计恰一次 + 消费恰一次 + 零平台外写', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const approvalId = await seedApproval('SNAPSHOT');
    const res = await submit(target, cookie, { approvalId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      caseId,
      appealId,
      status: 'SUBMITTED',
      externalSubmission: 'NEEDS_MANUAL',
      platformWriteExecuted: false,
      operationId: `approval:${approvalId}`,
    });
    const after = await sideEffects();
    expect(after.appealStatus).toBe('SUBMITTED');
    expect(after.submittedAt).not.toBeNull();
    expect(after.submittedAudits).toBe(1);
    expect(after.consumedAudits).toBe(1);
    expect(after.billingInvoices).toBe(0);
  }, 60_000);

  it('04 重复提交 → 不产生第二次副作用', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const approvalId = await seedApproval('SNAPSHOT');
    expect((await submit(target, cookie, { approvalId })).status).toBe(200);
    const replay = await submit(target, cookie, { approvalId });
    expect(replay.status).toBe(403);
    expect(String(replay.body.error)).not.toBe('');
    const after = await sideEffects();
    expect(after.submittedAudits).toBe(1);
    expect(after.consumedAudits).toBe(1);
  }, 60_000);

  it('05 缺 Action Guard 装配 → 403 ACTION_GUARD_NOT_CONFIGURED 且零推进', async () => {
    const res = await callWorkflowDirect();
    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('ACTION_GUARD_NOT_CONFIGURED');
    const after = await sideEffects();
    expect(after).toMatchObject({ appealStatus: 'DRAFT', submittedAudits: 0, consumedAudits: 0 });
  }, 60_000);

  it('06 等案件锁期间审批被撤销 → 锁后 403 APPROVAL_REVOKED 且零推进', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const approvalId = await seedApproval('SNAPSHOT');
    const release = await holdCaseLock();
    const pending = submit(target, cookie, { approvalId });
    try {
      await waitFor(async () => (await advisoryLockCount(caseLockKey(), false)) >= 1, 10_000, 'SUBMIT_WAITING_ON_CASE_LOCK');
      await prisma.auditLog.create({
        data: {
          organizationId: ORG,
          actorType: 'USER',
          actorUserId: ownerId,
          action: 'recovery.review_rejected',
          entityType: 'Case',
          entityId: caseId,
          changes: { reason: '等锁期间撤销' } as never,
          createdAt: new Date(),
        },
      });
    } finally {
      release();
    }
    const res = await pending;
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('APPROVAL_REVOKED');
    const after = await sideEffects();
    expect(after).toMatchObject({ appealStatus: 'DRAFT', submittedAt: null, submittedAudits: 0, consumedAudits: 0 });
  }, 60_000);

  it('07 CHANGE B：轮次与对象选择 —— 仅 round=2 可提交（round=3 → 404；多条 round=2 → 409）', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    // 把既有 appeal 改为 round=3：路由不接受，且不得任意取一条
    await prisma.appeal.update({ where: { id: appealId }, data: { round: 3 } });
    const notTwo = await submit(target, cookie, {});
    expect(notTwo.status).toBe(404);
    expect(notTwo.body.error).toBe('NOT_FOUND');
    // 建立两条 round=2：必须失败关闭（不任意选一条）
    await prisma.appeal.create({ data: { organizationId: ORG, claimId, caseId, round: 2, status: 'DRAFT' } });
    await prisma.appeal.create({ data: { organizationId: ORG, claimId, caseId, round: 2, status: 'DRAFT' } });
    const ambiguous = await submit(target, cookie, {});
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error).toBe('ILLEGAL_TRANSITION');
    // 不得产生任何推进或审计
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'appeal.submitted_by_human' } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: { contains: 'consumed' } } })).toBe(0);
  }, 60_000);

  it('08 CHANGE A：Appeal 正文为空 → 409 APPEAL_BODY_REQUIRED（失败关闭，零推进）', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    await prisma.appeal.update({ where: { id: appealId }, data: { finalText: '   ', aiDraftText: null } });
    const res = await submit(target, cookie, { approvalId: 'any' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('APPEAL_BODY_REQUIRED');
    const after = await sideEffects();
    expect(after).toMatchObject({ appealStatus: 'DRAFT', submittedAt: null, submittedAudits: 0, consumedAudits: 0 });
  }, 60_000);

  it('09 CHANGE A：审批后正文变化 → 快照摘要不匹配，精确拒绝且零推进', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const approvalId = await seedApproval('SNAPSHOT');
    // 审批后正文被改写：锁后重算快照摘要与审批绑定不一致，必须拒绝
    await prisma.appeal.update({ where: { id: appealId }, data: { finalText: 'appeal body (mutated)' } });
    const res = await submit(target, cookie, { approvalId });
    expect(res.status).toBe(403);
    expect(String(res.body.error)).not.toBe('');
    const after = await sideEffects();
    expect(after).toMatchObject({ appealStatus: 'DRAFT', submittedAt: null, submittedAudits: 0, consumedAudits: 0 });
  }, 60_000);

  it('10 CHANGE C：独立 OWNER 审批人 + ADMIN 执行人；等 Appeal 行锁期间降为 FINANCE → 403 FORBIDDEN', async () => {
    const target = await baseFor();
    const executor = await createMember('ADMIN');
    const cookie = await loginAs(target, executor.email);
    const approvalId = await seedApproval('SNAPSHOT'); // 审批人 = 既有 OWNER，全程有效
    const holder = await holdAppealRowLock();
    const blockerPid = await holder.pid;
    const pending = submit(target, cookie, { approvalId });
    try {
      await waitFor(async () => (await blockedByPidCount(blockerPid)) >= 1, 10_000, 'APPEAL_WAITING_ON_ROW_LOCK');
      await prisma.membership.updateMany({ where: { organizationId: ORG, userId: executor.userId }, data: { role: 'FINANCE' } });
    } finally {
      holder.release();
    }
    const res = await pending;
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    const after = await sideEffects();
    expect(after).toMatchObject({ appealStatus: 'DRAFT', submittedAt: null, submittedAudits: 0, consumedAudits: 0 });
  }, 60_000);

  it('11 CHANGE C：同审批并发提交 → 至多一次状态推进/成功审计/消费', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const approvalId = await seedApproval('SNAPSHOT');
    const [a, b] = await Promise.all([submit(target, cookie, { approvalId }), submit(target, cookie, { approvalId })]);
    const ok = [a, b].filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const after = await sideEffects();
    expect(after.appealStatus).toBe('SUBMITTED');
    expect(after.submittedAudits).toBe(1);
    expect(after.consumedAudits).toBe(1);
  }, 60_000);

  it('12 CHANGE C：成功业务审计写入失败 → 整笔提交事务回滚', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const approvalId = await seedApproval('SNAPSHOT');
    const res = await withAuditActionBlocked('appeal.submitted_by_human', () => submit(target, cookie, { approvalId }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await sideEffects();
    expect(after).toMatchObject({ appealStatus: 'DRAFT', submittedAt: null, submittedAudits: 0, consumedAudits: 0 });
  }, 60_000);

  it('13 CHANGE C：错误绑定（审批绑定其他 Appeal 的快照）→ 拒绝且零推进', async () => {
    const target = await baseFor();
    const cookie = await login(target);
    const other = await prisma.appeal.create({ data: { organizationId: ORG, claimId, caseId, round: 2, status: 'DRAFT', finalText: 'other body' } });
    const otherSnapshot = buildAppealSubmissionSnapshot({
      appealId: other.id,
      caseId,
      claimId,
      round: 2,
      finalText: 'other body',
      aiDraftText: null,
    })!;
    const approvalId = await seedApproval(appealSubmissionDigest(otherSnapshot));
    const res = await submit(target, cookie, { approvalId });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await sideEffects();
    expect(after).toMatchObject({ appealStatus: 'DRAFT', submittedAt: null, submittedAudits: 0, consumedAudits: 0 });
  }, 60_000);
});
