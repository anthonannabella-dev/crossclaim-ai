/**
 * ② R3 CHANGE C/D — 有控制点的真实竞争验收（HTTP + PostgreSQL）
 * ------------------------------------------------------------------
 * 与 R2 的「顺序失效」用例不同，本套件在**核验通过之后、最终资金写入之前**插入真实控制点
 * （持有案件 advisory lock，使执行阻塞在锁等待上），在此期间改变外部事实，再放行：
 *   · 01 等待案件锁期间撤销审批 → 403 APPROVAL_REVOKED，零新增资金/消费 + 最终拒绝审计
 *   · 02 等待案件锁期间审批到期 → 403 APPROVAL_EXPIRED（锁后重读服务端时间），零资金
 *   · 03 等待案件锁期间成员停用 → 403 APPROVAL_ACTOR_MISMATCH，零资金
 *   · 04 同案件不同审批并发 → 最多一条完整资金链（1 Settlement/Ledger/Fee/Billing）
 *   · 05 既有资金链缺项 → 409 ILLEGAL_TRANSITION，不新增对象、不消费审批
 *   · 06 审批指纹版本异常 → 403 APPROVAL_VERSION_UNSUPPORTED，零资金
 *   · 07 受保护入口缺 approvalId（兼容路径隔离）→ 4xx 且零资金
 *   · 08 成功/失败审计真实落库（执行主体、approvalId、operationId、Settlement 关联）
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
import { createAppActionGuard, staticControlPlaneConfig } from '../services/action-guard/runtime-guard-composition';
import type { RuntimeActionGuard } from '../services/action-guard/runtime-guard';
import { createHitlSubmissionBoundary } from '../services/action-guard/hitl-submission';
import { confirmRecoveryOutcome } from '../services/workflow/recovery-outcome';

const prisma = new PrismaClient();
const ORG = 'cf000000-0000-4000-8000-0000000000e1';
const SALT = 'hitl-race-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'hitl-race-pass-1';
const EMAIL = 'hitl-race-owner@example.com';
const RATE = '0.1500';
/** CI 修复：审批有效期按真实时钟判定；固定 NOW 会在 NOW + TTL 之后必然失败，故以真实时钟（-60s）为基准，断言语义不变。 */
const NOW = new Date(Date.now() - 60_000);
const AMOUNT = '3000.0000';
const BASIS = 'race-basis';
const ACTION = 'commission.charge';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-hitl-race-'));
const storage = new LocalFileSystemStorage({ rootDir: storageRoot, secret: SALT, publicBaseUrl: 'http://localhost:3000' });

let ownerId = '';
let caseId = '';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization", "KillSwitchRequest" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'HITL 竞争 租户', slug: 'hitl-race-org' } });
  const owner = await prisma.user.create({
    data: { email: EMAIL, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'OWNER', status: 'ACTIVE', emailVerified: true },
  });
  ownerId = owner.id;
  await prisma.membership.create({ data: { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true } });

  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'RACE-1',
      title: 'R3 竞争用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('5000.0000'),
      currency: 'USD',
    },
  });
  caseId = kase.id;
  await prisma.claim.create({ data: { organizationId: ORG, caseId, round: 1, status: 'APPROVED', target: 'CARRIER', aiDraftText: 'draft' } });
  await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      action: 'commercial_terms.created',
      entityType: 'Case',
      entityId: caseId,
      changes: { successFeeRate: RATE, source: 'manual_input', reConfirmed: false } as never,
      createdAt: NOW,
    },
  });
});

const permissiveGuard = (): RuntimeActionGuard =>
  createAppActionGuard({
    prisma,
    killSwitchResolver: { async resolve(scope: string) { return { scope, value: 'enabled' as const, degraded: false, stale: false }; } },
    audit: { write: () => {} },
    config: staticControlPlaneConfig({
      globalDisabled: false,
      mode: 'WRITE_ENABLED',
      productionGate: 'SATISFIED',
      platformEnabled: { [ACTION]: true },
      tenantFeatureEnabled: { [ACTION]: true },
      hostApprovalGranted: true,
    }),
  });

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, storage, actionGuard: permissiveGuard() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function login(base: string): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function confirm(base: string, cookie: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/cases/${caseId}/recovery-outcome`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ recoveredAmount: AMOUNT, currency: 'USD', basisReference: BASIS, ...body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function counts() {
  return {
    settlement: await prisma.settlement.count({ where: { organizationId: ORG } }),
    ledger: await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } }),
    fee: await prisma.feeCalculation.count({ where: { organizationId: ORG } }),
    billing: await prisma.billingInvoice.count({ where: { organizationId: ORG } }),
    consumed: await prisma.auditLog.count({ where: { organizationId: ORG, action: 'recovery.approval_consumed' } }),
  };
}

const ZERO = { settlement: 0, ledger: 0, fee: 0, billing: 0, consumed: 0 };

/**
 * 夹具：直接落库一条「操作级审批」（等价于 REQUEST + APPROVE 的结果）。
 * 返回 approvalId（= recovery.review_approved 审计行的 id）。
 */
async function grantApproval(options: { expiresAt?: Date; fingerprintVersion?: string; suffix?: string } = {}) {
  const suffix = options.suffix ?? '1';
  await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      action: 'recovery.review_required',
      entityType: 'Case',
      entityId: caseId,
      changes: { caseNo: 'RACE-1', threshold: '1000.0000', recoveredAmount: AMOUNT, currency: 'USD' } as never,
      createdAt: NOW,
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
      changes: {
        caseNo: 'RACE-1',
        threshold: '1000.0000',
        boundAction: ACTION,
        boundPayload: {
          amount: AMOUNT,
          currency: 'USD',
          basisReference: BASIS,
          evidenceArtifactId: null,
          fingerprintVersion: options.fingerprintVersion ?? 'v1',
        },
        expiresAt: (options.expiresAt ?? new Date(NOW.getTime() + 24 * 60 * 60 * 1000)).toISOString(),
        nonce: suffix,
      } as never,
      createdAt: new Date(NOW.getTime() + 1000),
    },
  });
  return approved.id;
}

/** 控制点：在独立连接上持有案件 advisory lock，直到 release()。 */
async function holdCaseLock(): Promise<{ release: () => void; pending: Promise<unknown> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-recovery-case:${caseId}`);
      await gate;
    },
    { timeout: 30_000 },
  );
  await waitCaseLockHeld();
  return { release, pending };
}

/** 轮询直到案件锁确实被持有（用 try-lock 探测，不依赖 pg_locks 布局）。 */
async function waitCaseLockHeld(): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const rows = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok',
      `cc-recovery-case:${caseId}`,
    );
    if (rows[0]?.ok === false) return;
    await sleep(25);
  }
  throw new Error('CASE_LOCK_NOT_HELD');
}

async function rejectionAudits() {
  return prisma.auditLog.findMany({
    where: { organizationId: ORG, action: 'recovery.outcome_rejected' },
    select: { actorType: true, entityType: true, entityId: true, changes: true },
  });
}

describe('② R3 — 有控制点的真实竞争（HTTP + PostgreSQL）', () => {
  it('01 核验通过后、等锁期间撤销：最终 403 APPROVAL_REVOKED，零新增资金/消费 + 拒绝审计', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await grantApproval();
      const lock = await holdCaseLock();

      const pending = confirm(base, cookie, { approvalId });
      // 控制点：请求确实被案件锁挡住（尚未产生任何结果）。
      // R4 CHANGE D 口径：本条只说明「此刻未返回」，不能单独证明请求已达锁等待；
      // 更强的证据是同用例末尾的 recovery.outcome_rejected（stage=LOCKED_RECHECK）最终拒绝记录。
      expect(await Promise.race([pending.then(() => 'done'), sleep(400).then(() => 'blocked')])).toBe('blocked');

      // 等锁期间完成撤销（直写等价事件；测试持有案件锁，故不能走 HTTP）
      await prisma.auditLog.create({
        data: {
          organizationId: ORG,
          actorType: 'USER',
          actorUserId: ownerId,
          action: 'recovery.approval_revoked',
          entityType: 'Case',
          entityId: caseId,
          changes: { approvalId, reason: '撤销' } as never,
          createdAt: new Date(NOW.getTime() + 5000),
        },
      });
      lock.release();
      await lock.pending;

      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_REVOKED');
      expect(await counts()).toEqual(ZERO);

      const rejections = await rejectionAudits();
      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toMatchObject({ actorType: 'SYSTEM', entityType: 'Case', entityId: caseId });
      expect(rejections[0].changes).toMatchObject({
        actorUserId: ownerId,
        approvalId,
        operationId: `approval:${approvalId}`,
        stage: 'LOCKED_RECHECK',
        reason: 'APPROVAL_REVOKED',
        result: 'REJECTED',
      });
    });
  }, 30_000);

  it('02 核验通过后、等锁期间审批过期：锁后重读服务端时间 → 403 APPROVAL_EXPIRED，零资金', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      // 审批在「核验时」仍有效（+1.2s），但申请人等待案件锁超过该时间
      const approvalId = await grantApproval({ expiresAt: new Date(Date.now() + 1200) });
      const lock = await holdCaseLock();

      const pending = confirm(base, cookie, { approvalId });
      expect(await Promise.race([pending.then(() => 'done'), sleep(400).then(() => 'blocked')])).toBe('blocked');
      await sleep(1600); // 让审批在锁等待期间过期
      lock.release();
      await lock.pending;

      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_EXPIRED');
      expect(await counts()).toEqual(ZERO);

      // 该拒绝发生在锁内重验（而非 wrapper）：入口已通过、最终执行被拒
      const rejections = await rejectionAudits();
      expect(rejections.map((row) => (row.changes as Record<string, unknown>).stage)).toEqual(['LOCKED_RECHECK']);
    });
  }, 30_000);

  it('03 核验通过后、等锁期间成员停用：最终 403 APPROVAL_ACTOR_MISMATCH，零资金', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await grantApproval();
      const lock = await holdCaseLock();

      const pending = confirm(base, cookie, { approvalId });
      expect(await Promise.race([pending.then(() => 'done'), sleep(400).then(() => 'blocked')])).toBe('blocked');

      await prisma.membership.updateMany({ where: { organizationId: ORG, userId: ownerId }, data: { isActive: false } });
      lock.release();
      await lock.pending;

      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_ACTOR_MISMATCH');
      expect(await counts()).toEqual(ZERO);
    });
  }, 30_000);

  it('04 同案件不同审批并发：最多一条完整资金链', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const first = await grantApproval({ suffix: 'a' });
      // 新一轮 REQUEST 使旧审批被取代
      const second = await grantApproval({ suffix: 'b' });

      const results = await Promise.all([confirm(base, cookie, { approvalId: first }), confirm(base, cookie, { approvalId: second })]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 403]);

      const rejected = results.find((r) => r.status === 403);
      expect(rejected?.body.reason).toBe('APPROVAL_NOT_APPROVED');
      expect(await counts()).toEqual({ settlement: 1, ledger: 1, fee: 1, billing: 1, consumed: 1 });
    });
  }, 30_000);

  it('05 既有资金链缺项：409 ILLEGAL_TRANSITION，不返回空 ID，不消费审批', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const evidence = await prisma.evidenceArtifact.create({
        data: { organizationId: ORG, kind: 'CREDIT_NOTE', title: 'race evidence', description: 'd', capturedAt: NOW },
      });
      const settlement = await prisma.settlement.create({
        data: {
          organizationId: ORG,
          caseId,
          evidenceId: evidence.id,
          status: 'RECEIVED',
          source: 'OTHER',
          amount: new Prisma.Decimal(AMOUNT),
          currency: 'USD',
          receivedAt: NOW,
          confirmedAt: NOW,
        },
      });
      await prisma.recoveryLedgerEntry.create({
        data: {
          organizationId: ORG,
          caseId,
          opportunityId: null,
          settlementId: settlement.id,
          entryType: 'RECOVERED',
          amount: new Prisma.Decimal(AMOUNT),
          currency: 'USD',
          counterparty: 'EXTERNAL_PAYER',
          reference: `settlement:${settlement.id}`,
        },
      });
      await prisma.feeCalculation.create({
        data: {
          organizationId: ORG,
          settlementId: settlement.id,
          caseId,
          basis: 'RECOVERED_AMOUNT_PCT',
          rate: new Prisma.Decimal(RATE),
          baseAmount: new Prisma.Decimal(AMOUNT),
          feeAmount: new Prisma.Decimal('450.0000'),
          currency: 'USD',
          computation: {
            settlementId: settlement.id,
            baseAmount: AMOUNT,
            rate: RATE,
            feeAmount: '450.0000',
            rounding: { scale: 4, mode: 'HALF_UP' },
            source: 'manual_input',
            basisReference: BASIS,
          },
        },
      });

      const approvalId = await grantApproval();
      const res = await confirm(base, cookie, { approvalId });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('ILLEGAL_TRANSITION');
      // 缺项链被拒绝：不新增任何对象、不消费审批（缺 Billing 仍为 0）
      expect(await counts()).toEqual({ settlement: 1, ledger: 1, fee: 1, billing: 0, consumed: 0 });

      const rejections = await rejectionAudits();
      expect(rejections).toHaveLength(1);
      expect(rejections[0].changes).toMatchObject({ stage: 'LOCKED_RECHECK', reason: 'ILLEGAL_TRANSITION' });
    });
  }, 30_000);

  it('06 审批指纹版本异常：403 APPROVAL_VERSION_UNSUPPORTED，零资金', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await grantApproval({ fingerprintVersion: 'v9' });
      const res = await confirm(base, cookie, { approvalId });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_VERSION_UNSUPPORTED');
      expect(await counts()).toEqual(ZERO);
    });
  }, 30_000);

  it('07 受保护入口缺 approvalId（兼容路径隔离）：4xx 拒绝且零资金', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await confirm(base, cookie);
      // R4 CHANGE D：取消宽松 4xx 集合，精确断言守卫的 REQUIRE_APPROVAL 结果
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('ACTION_GUARD_HUMAN_APPROVAL_REQUIRED');
      expect(await counts()).toEqual(ZERO);
    });
  }, 30_000);

  it('08 成功与拒绝的真实落库审计：执行主体 / approvalId / operationId / Settlement 关联', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await grantApproval();
      const res = await confirm(base, cookie, { approvalId });
      expect(res.status).toBe(201);
      const settlementId = String(res.body.settlementId);

      const confirmed = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: 'recovery_outcome.confirmed' },
      });
      expect(confirmed).toMatchObject({ actorType: 'USER', actorUserId: ownerId, entityType: 'Settlement', entityId: settlementId });
      expect(confirmed.changes).toMatchObject({
        approvalId,
        operationId: `approval:${approvalId}`,
        result: 'CONFIRMED',
        caseId,
      });

      const consumed = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: 'recovery.approval_consumed' },
      });
      expect(consumed).toMatchObject({ actorType: 'USER', actorUserId: ownerId, entityType: 'Case', entityId: caseId });
      expect(consumed.changes).toMatchObject({ approvalId, operationId: `approval:${approvalId}` });

      const guardAudits = await prisma.auditLog.findMany({
        where: { organizationId: ORG, action: 'action_guard.approval_decision' },
        select: { changes: true, entityType: true, entityId: true },
      });
      expect(guardAudits.length).toBeGreaterThan(0);
      expect(
        guardAudits.map((row) => row.changes as Record<string, unknown>).find((changes) => changes.decision === 'ALLOW'),
      ).toMatchObject({
        actorUserId: ownerId,
        approvalId,
        operationId: `approval:${approvalId}`,
        code: 'ACTION_GUARD_APPROVAL_VERIFIED',
      });
      expect(guardAudits.some((row) => row.entityType === 'ActionGuardTarget' && row.entityId === caseId)).toBe(true);
    });
  }, 30_000);

  it('09 审批审计端口写入失败：放行降级为拒绝，真实数据库零资金副作用', async () => {
    const approvalId = await grantApproval();
    const boundary = createHitlSubmissionBoundary({
      guard: permissiveGuard(),
      prisma,
      audit: {
        write: async () => {
          throw new Error('AUDIT_DOWN');
        },
      },
    });

    await expect(
      boundary.submit({
        action: ACTION,
        organizationId: ORG,
        actorUserId: ownerId,
        targetRef: caseId,
        approvalId,
        payload: { recoveredAmount: AMOUNT, currency: 'USD', basisReference: BASIS, evidenceArtifactId: null },
        perform: () =>
          confirmRecoveryOutcome(prisma, {
            organizationId: ORG,
            actorUserId: ownerId,
            role: 'OWNER',
            caseId,
            recoveredAmount: AMOUNT,
            currency: 'USD',
            basisReference: BASIS,
            approvalId,
          }),
      }),
    ).rejects.toThrow('AUDIT_DOWN');

    expect(await counts()).toEqual(ZERO);
  }, 30_000);
});
