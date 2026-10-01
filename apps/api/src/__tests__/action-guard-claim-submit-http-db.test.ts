/**
 * Gate 7 / ② RUNTIME BUSINESS BLOCKING —— claim.submit（真实 HTTP + PostgreSQL）
 * ---------------------------------------------------------------------------
 * 依据 docs/releases/ACTION-GUARD-CP2-STATUS-AND-INTEGRATION-CHECKLIST.md §3.2 的六项验收：
 *   01 缺 Action Guard（未注入）→ 拒绝 + 零副作用
 *   02 缺 approvalId → 拒绝 + 零副作用
 *   03 approvalId 不存在/不匹配 → 拒绝 + 零副作用
 *   04 能力/平台/Production Gate 未满足 → 拒绝 + 零副作用
 *   05 合法审批 → recordSubmission 恰一次 + 审批消费恰一次 + 平台外写 0 + NEEDS_MANUAL
 *   06 重复提交 → 幂等或 APPROVAL_ALREADY_CONSUMED，且无重复副作用
 *
 * 说明：claim.submit 本批次**不新增 review 路由**，审批用既有 submitRecoveryReview 服务播种
 * （boundAction='claim.submit'、boundPayload={basisReference: claimId}）。
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
import { APPROVAL_REASON_CODES } from '../services/action-guard/approval-verifier';
import { AdapterCapabilityError } from '../services/adapters/types';
import { createAdapterRegistry } from '../services/adapters/registry';
import { handleWorkflowRequest, type WorkflowRouteDeps } from '../services/workflow/http-routes';
import { SESSION_COOKIE } from '../services/auth/http-routes';
import { submitRecoveryReview } from '../services/workflow/recovery-review';

const prisma = new PrismaClient();
let ORG = '';
const SALT = 'claim-submit-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'claim-submit-pass-1';
let EMAIL = '';
const ACTION = 'claim.submit';
const NOW = new Date('2026-09-30T06:00:00Z');

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-claim-submit-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

let ownerId = '';
let caseId = '';
let claimId = '';
const createdOrgs: string[] = [];

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  for (const server of liveServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // 与其它同库套件一致：结束即整表清库，避免残留数据污染后续文件
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')",
  );
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((row) => '"' + row.tablename + '"').join(', ')} CASCADE;`,
    );
  }
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // 每用例唯一数据（不做全局 TRUNCATE）：消除用例间共享状态导致的竞态
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  ORG = randomUUID();
  createdOrgs.push(ORG);
  EMAIL = `claim-submit-${suffix}@example.com`;
  await prisma.organization.create({
    data: { id: ORG, name: 'claim.submit 租户', slug: `claim-submit-${suffix}` },
  });
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
  await prisma.membership.create({
    data: { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true },
  });
  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: `CS-${suffix}`,
      title: 'claim.submit 用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('5000.0000'),
      currency: 'USD',
    },
  });
  caseId = kase.id;
  const claim = await prisma.claim.create({
    data: { organizationId: ORG, caseId, round: 1, status: 'DRAFT', target: 'CARRIER', aiDraftText: 'draft' },
  });
  claimId = claim.id;
});

function guard(options: { platform?: boolean; tenant?: boolean; gate?: 'SATISFIED' | 'NOT_SATISFIED' } = {}): RuntimeActionGuard {
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
      productionGate: options.gate ?? 'SATISFIED',
      platformEnabled: { [ACTION]: options.platform ?? true },
      tenantFeatureEnabled: { [ACTION]: options.tenant ?? true },
      hostApprovalGranted: true,
    }),
  });
}

type GuardVariant = 'permissive' | 'defaultGuard' | 'platformOff' | 'tenantOff' | 'gateOff';

const liveServers: Array<{ close: (cb: () => void) => void }> = [];
const baseByVariant = new Map<GuardVariant, string>();

function guardForVariant(variant: GuardVariant): RuntimeActionGuard {
  if (variant === 'defaultGuard') {
    // 未注入 control plane 配置 → 控制面回落 READ_ONLY（fail closed）
    return createAppActionGuard({
      prisma,
      killSwitchResolver: {
        async resolve(scope: string) {
          return { scope, value: 'enabled' as const, degraded: false, stale: false };
        },
      },
      audit: { write: () => {} },
    });
  }
  if (variant === 'platformOff') return guard({ platform: false });
  if (variant === 'tenantOff') return guard({ tenant: false });
  if (variant === 'gateOff') return guard({ gate: 'NOT_SATISFIED' });
  return guard();
}

/** 每个变体只起一个常驻 HTTP server（避免每用例新建 server 造成的会话/端口竞态）。 */
async function baseFor(variant: GuardVariant): Promise<string> {
  const cached = baseByVariant.get(variant);
  if (cached) return cached;
  const activeGuard = guardForVariant(variant);
  const server = createServer({ prisma, log, audit, storage, actionGuard: activeGuard });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  liveServers.push(server);
  baseByVariant.set(variant, base);
  return base;
}

async function withServer<T>(
  run: (base: string) => Promise<T>,
  options: { variant?: GuardVariant } = {},
): Promise<T> {
  return run(await baseFor(options.variant ?? 'permissive'));
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

async function submit(base: string, cookie: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/cases/${caseId}/claim/submit`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * 经既有服务播种操作级审批（不手写审批审计行）。
 * `claim.submit` 非资金动作：按 1f380c8 的按动作类型判定，绑定依据 basisReference 即可
 * （资金动作 commission.charge 仍必须绑定金额/币种/依据）；服务端提交载荷逐项比对。
 */
async function seedApproval(boundBasis: string = claimId): Promise<string> {
  await submitRecoveryReview(
    prisma,
    {
      organizationId: ORG,
      actorUserId: ownerId,
      role: 'OWNER',
      caseId,
      decision: 'REQUEST',
      recoveredAmount: null,
      currency: null,
    } as never,
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
      boundAction: ACTION,
      boundPayload: { basisReference: boundBasis },
    } as never,
    () => new Date(NOW.getTime() + 1000),
  )) as { approvalId?: string };
  if (!approved.approvalId) throw new Error('APPROVAL_NOT_CREATED');
  return approved.approvalId;
}

async function sideEffects() {
  const claim = await prisma.claim.findUniqueOrThrow({ where: { id: claimId } });
  return {
    claimStatus: claim.status,
    humanSubmissionAudits: await prisma.auditLog.count({
      where: { organizationId: ORG, action: 'claim.submitted_by_human' },
    }),
    consumedAudits: await prisma.auditLog.count({
      where: { organizationId: ORG, action: { contains: 'consumed' } },
    }),
    approvalDecisionAudits: await prisma.auditLog.count({
      where: { organizationId: ORG, action: 'action_guard.approval_decision' },
    }),
  };
}

const ZERO = { claimStatus: 'DRAFT', humanSubmissionAudits: 0, consumedAudits: 0 };
/** 允许的拒绝原因：闸门/守卫错误码 + 审批绑定校验码（approval-verifier 的稳定枚举） */
const REJECTION_CODES: readonly string[] = [
  'ACTION_GUARD_NOT_CONFIGURED',
  'ACTION_GUARD_REQUIREMENTS_NOT_MET',
  'ACTION_GUARD_HUMAN_APPROVAL_REQUIRED',
  'ACTION_GUARD_APPROVAL_NOT_VERIFIED',
  'ACTION_GUARD_STATE_UNAVAILABLE',
  'FORBIDDEN',
  ...APPROVAL_REASON_CODES,
];

function rejectionReason(body: Record<string, unknown>): string {
  const code = [body.reason, body.error, body.code]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find((value) => value !== '');
  return code ?? '';
}

describe('② RUNTIME BUSINESS BLOCKING — claim.submit（真实 HTTP + PostgreSQL）', () => {
  it('01 未配置 control plane（默认 READ_ONLY）→ 拒绝（fail closed）且零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await submit(base, cookie, { approvalId: 'any' });
      expect([403, 409]).toContain(res.status);
      expect(REJECTION_CODES).toContain(rejectionReason(res.body));
      expect(await sideEffects()).toMatchObject(ZERO);
    }, { variant: 'defaultGuard' });
  }, 60_000);

  it('02 缺 approvalId → 拒绝且零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await submit(base, cookie, {});
      expect([403, 409]).toContain(res.status);
      expect(REJECTION_CODES).toContain(rejectionReason(res.body));
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('03 approvalId 不存在 → 拒绝且零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await submit(base, cookie, { approvalId: 'cf000000-0000-4000-8000-00000000dead' });
      expect([403, 409]).toContain(res.status);
      expect(REJECTION_CODES).toContain(rejectionReason(res.body));
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('04 审批绑定到其他目标 → 拒绝且零副作用', async () => {
    const foreignApproval = await (async () => {
      const other = await prisma.claim.create({
        data: { organizationId: ORG, caseId, round: 2, status: 'DRAFT', target: 'CARRIER', aiDraftText: 'draft2' },
      });
      return other.id;
    })();
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await seedApproval(foreignApproval);
      const res = await submit(base, cookie, { approvalId });
      expect([403, 409]).toContain(res.status);
      expect(REJECTION_CODES).toContain(rejectionReason(res.body));
      const claim = await prisma.claim.findUniqueOrThrow({ where: { id: claimId } });
      expect(claim.status).toBe('DRAFT');
    });
  }, 60_000);

  it('05 能力未满足（platform / tenant / Production Gate）→ 拒绝且零副作用', async () => {
    for (const variant of ['platformOff', 'tenantOff', 'gateOff'] as const) {
      await withServer(
        async (base) => {
          const cookie = await login(base);
          const approvalId = await seedApproval();
          const res = await submit(base, cookie, { approvalId });
          expect([403, 409]).toContain(res.status);
          expect(REJECTION_CODES).toContain(rejectionReason(res.body));
          expect(await sideEffects()).toMatchObject(ZERO);
        },
        { variant },
      );
      await prisma.claim.update({ where: { id: claimId }, data: { status: 'DRAFT' } });
    }
  }, 120_000);

  it('06 合法审批 → 恰一次人工提交、审批消费恰一次、零平台外写、NEEDS_MANUAL', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await seedApproval();
      const res = await submit(base, cookie, { approvalId });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'SUBMITTED',
        externalSubmission: 'NEEDS_MANUAL',
        platformWriteExecuted: false,
      });
      const after = await sideEffects();
      expect(after.claimStatus).toBe('SUBMITTED');
      expect(after.humanSubmissionAudits).toBe(1);
      expect(after.consumedAudits).toBe(1);

      // 06b 重复提交：幂等或已消费；不得产生第二次人工提交
      const replay = await submit(base, cookie, { approvalId });
      expect([200, 403, 409]).toContain(replay.status);
      if (replay.status !== 200) {
        expect(rejectionReason(replay.body)).not.toBe('');
      }
      const final = await sideEffects();
      expect(final.humanSubmissionAudits).toBe(1);
      expect(final.consumedAudits).toBe(1);
    });
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// R19（MSG-20261001-02）验收：CHANGE A（原子提交）/ B（锁后完整重验）/
// C（载荷策略白名单）/ D（失败、并发、等锁与装配路径）
// ─────────────────────────────────────────────────────────────────────────────

const caseLockKey = () => `cc-recovery-case:${caseId}`;

async function advisoryLockCount(key: string, granted: boolean): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n
       FROM pg_locks l
      WHERE l.locktype = 'advisory'
        AND l.granted = ${granted ? 'true' : 'false'}
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

/** 独立连接持有案件咨询锁（与 submitRecoveryReview / 提交事务同一协议）；返回释放函数 */
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

/** 注入数据库层「某审计动作不可写」的失败；用后必然拆除约束 */
async function withAuditActionBlocked<T>(action: string, run: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "AuditLog" ADD CONSTRAINT r19_block_audit_action CHECK (action <> '${action}') NOT VALID`,
  );
  try {
    return await run();
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS r19_block_audit_action');
  }
}

/** 直接调用工作流处理器（不经 server 前缀门控），用于覆盖「缺 Action Guard 装配」路径 */
async function callWorkflowDirect(
  targetPath: string,
  body: Record<string, unknown>,
  options: { guard?: RuntimeActionGuard | null } = {},
) {
  const token = 'r19-direct-session-token';
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  const reqAny = req as unknown as {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  };
  reqAny.url = targetPath;
  reqAny.method = 'POST';
  reqAny.headers = {
    cookie: `${SESSION_COOKIE}=${token}`,
    'content-type': 'application/json',
    origin: 'http://127.0.0.1',
  };

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
        create: async () => ({ id: 'r19-session' }),
        findByTokenHash: async () => ({
          id: 'r19-session',
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
    // 缺省（不传 actionGuard）即「装配缺失」路径；显式传 null 等价
    ...(options.guard ? { actionGuard: options.guard } : {}),
  };

  await handleWorkflowRequest(req, res, deps);
  return { status, body: payload as Record<string, unknown> | null };
}

describe('R19 CHANGE A–D — claim.submit 原子性 / 锁内重验 / 装配路径 / 载荷策略', () => {
  it('07 同审批并发提交：恰一次状态推进 + 恰一次业务审计 + 恰一次审批消费', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await seedApproval();
      const results = await Promise.all([
        submit(base, cookie, { approvalId }),
        submit(base, cookie, { approvalId }),
        submit(base, cookie, { approvalId }),
        submit(base, cookie, { approvalId }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const rejected = results.filter((r) => r.status !== 200);
      expect(rejected).toHaveLength(3);
      // 其余必须精确拒绝（已消费）——不允许宽泛 500
      for (const r of rejected) {
        expect(r.status).toBe(403);
        expect(r.body.error).toBe('APPROVAL_ALREADY_CONSUMED');
      }
      const after = await sideEffects();
      expect(after).toMatchObject({ claimStatus: 'SUBMITTED', humanSubmissionAudits: 1, consumedAudits: 1 });
    });
  }, 60_000);

  it('08 业务审计写入失败（claim.submitted_by_human 被库拒绝）→ 整笔提交事务回滚', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await seedApproval();
      const res = await withAuditActionBlocked('claim.submitted_by_human', () =>
        submit(base, cookie, { approvalId }),
      );
      expect(res.status).not.toBe(200);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('09 审批消费写入失败（recovery.approval_consumed 被库拒绝）→ 状态与业务审计一并回滚', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await seedApproval();
      const res = await withAuditActionBlocked('recovery.approval_consumed', () =>
        submit(base, cookie, { approvalId }),
      );
      expect(res.status).not.toBe(200);
      // CHANGE A 的核心：消费失败必须把已写入的 Claim CAS 与人工提交审计一起回滚
      const claim = await prisma.claim.findUniqueOrThrow({ where: { id: claimId } });
      expect(claim.status).toBe('DRAFT');
      expect(claim.submittedAt).toBeNull();
      expect(claim.submittedBy).toBeNull();
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('10 放行前审批决策审计失败 → work=0（零业务副作用）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await seedApproval();
      const res = await withAuditActionBlocked('action_guard.approval_decision', () =>
        submit(base, cookie, { approvalId }),
      );
      expect(res.status).not.toBe(200);
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('11 等锁期间审批被撤销 → 锁后拒绝 APPROVAL_REVOKED，零业务副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await seedApproval();
      const release = await holdCaseLock();
      const pending = submit(base, cookie, { approvalId });
      try {
        // 控制点：请求已通过事务外只读校验，正阻塞在案件锁上
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
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('12 等锁期间审批过期 → 锁后拒绝 APPROVAL_EXPIRED，零业务副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      await submitRecoveryReview(
        prisma,
        {
          organizationId: ORG,
          actorUserId: ownerId,
          role: 'OWNER',
          caseId,
          decision: 'REQUEST',
        } as never,
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
          boundAction: ACTION,
          boundPayload: { basisReference: claimId },
          // TTL 相对**真实时钟**（审批在真实 now 生成，3s 后过期；外层只读校验先通过，锁内重验时已过期）
          approvalTtlMs: 3_000,
        } as never,
        () => new Date(),
      )) as { approvalId?: string };
      const approvalId = String(approved.approvalId);
      const release = await holdCaseLock();
      const pending = submit(base, cookie, { approvalId });
      try {
        await waitFor(async () => (await advisoryLockCount(caseLockKey(), false)) >= 1, 10_000, 'SUBMIT_WAITING_ON_CASE_LOCK');
        await new Promise((resolve) => setTimeout(resolve, 3_600));
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('APPROVAL_EXPIRED');
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('13 等锁期间执行主体成员停用 → 锁后拒绝 APPROVAL_ACTOR_MISMATCH，零业务副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await seedApproval();
      const release = await holdCaseLock();
      const pending = submit(base, cookie, { approvalId });
      try {
        await waitFor(async () => (await advisoryLockCount(caseLockKey(), false)) >= 1, 10_000, 'SUBMIT_WAITING_ON_CASE_LOCK');
        await prisma.membership.updateMany({
          where: { organizationId: ORG, userId: ownerId },
          data: { isActive: false },
        });
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('APPROVAL_ACTOR_MISMATCH');
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('14 审批绑定到其他 Claim → 状态/业务审计/消费均不新增', async () => {
    const other = await prisma.claim.create({
      data: { organizationId: ORG, caseId, round: 2, status: 'DRAFT', target: 'CARRIER', aiDraftText: 'draft2' },
    });
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await seedApproval(other.id);
      const res = await submit(base, cookie, { approvalId });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_PAYLOAD_MISMATCH');
      expect(await sideEffects()).toMatchObject(ZERO);
      const otherAfter = await prisma.claim.findUniqueOrThrow({ where: { id: other.id } });
      expect(otherAfter.status).toBe('DRAFT');
    });
  }, 60_000);

  it('15 成功落库记录的关联一致性：approvalId / operationId / Case / Claim', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await seedApproval();
      expect((await submit(base, cookie, { approvalId })).status).toBe(200);

      const human = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: 'claim.submitted_by_human' },
      });
      expect(human.entityType).toBe('Claim');
      expect(human.entityId).toBe(claimId);
      expect(human.changes).toMatchObject({
        from: 'DRAFT',
        to: 'SUBMITTED',
        humanApproved: true,
        caseId,
        approvalId,
        operationId: `approval:${approvalId}`,
      });

      const consumed = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: 'recovery.approval_consumed' },
      });
      expect(consumed.entityType).toBe('Case');
      expect(consumed.entityId).toBe(caseId);
      expect(consumed.changes).toMatchObject({
        approvalId,
        operationId: `approval:${approvalId}`,
        caseId,
        claimId,
        basisReference: claimId,
      });

      const claim = await prisma.claim.findUniqueOrThrow({ where: { id: claimId } });
      expect(claim.submittedBy).toBe(ownerId);
      expect(claim.approvedByUserId).toBe(ownerId);
      expect(claim.submittedAt?.getTime()).toBe(claim.approvedAt?.getTime());
    });
  }, 60_000);

  it('16 缺 Action Guard 装配（直接调用 handleWorkflowRequest）→ 拒绝且零业务调用', async () => {
    const res = await callWorkflowDirect(`/cases/${caseId}/claim/submit`, { approvalId: 'any' });
    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('ACTION_GUARD_NOT_CONFIGURED');
    expect(await sideEffects()).toMatchObject(ZERO);
  }, 60_000);

  it('17 零平台外写探针：路由源码不含适配器写入面 + 注册表拒绝写入面适配器', () => {
    const routeSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'services', 'workflow', 'http-routes.ts'),
      'utf8',
    );
    // 静态探针：受保护入口文件内不得出现任何平台写入面引用
    expect(routeSource).not.toMatch(/submitClaim\s*\(/);
    expect(routeSource).not.toMatch(/submitClaimThroughAdapter/);
    expect(routeSource).not.toMatch(/from '\.\.\/adapters/);

    // 动态探针：实现写入面的适配器在**注册阶段**即被拒绝（闸门先于调用）
    const writeProbe = {
      platform: 'r19-write-probe',
      capabilities: () => ({
        platform: 'r19-write-probe',
        displayName: 'R19 write probe',
        domains: ['LOGISTICS'],
        channels: ['UPS'],
        maxPageSize: 50,
        supportsClaimSubmission: false,
      }),
      submitClaim: async () => {
        throw new Error('WRITE_PROBE_INVOKED');
      },
    };
    expect(() => createAdapterRegistry([writeProbe as never])).toThrow(AdapterCapabilityError);
  });

  it('18 审批载荷策略白名单：默认资金动作缺字段拒绝 / claim.submit 合法 / 未知动作拒绝', async () => {
    const request = () =>
      submitRecoveryReview(
        prisma,
        { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', caseId, decision: 'REQUEST' } as never,
        () => NOW,
      );

    // 默认（资金动作 commission.charge）：缺金额/币种 → 拒绝
    await request();
    await expect(
      submitRecoveryReview(
        prisma,
        {
          organizationId: ORG,
          actorUserId: ownerId,
          role: 'OWNER',
          caseId,
          decision: 'APPROVE',
          boundPayload: { basisReference: claimId },
        } as never,
        () => new Date(NOW.getTime() + 1000),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    // claim.submit：仅绑定依据即可（本批次白名单）
    await prisma.$executeRawUnsafe('DELETE FROM "AuditLog"');
    await request();
    const claimSubmitApproval = (await submitRecoveryReview(
      prisma,
      {
        organizationId: ORG,
        actorUserId: ownerId,
        role: 'OWNER',
        caseId,
        decision: 'APPROVE',
        boundAction: ACTION,
        boundPayload: { basisReference: claimId },
      } as never,
      () => new Date(NOW.getTime() + 1000),
    )) as { approvalId?: string };
    expect(typeof claimSubmitApproval.approvalId).toBe('string');

    // 未知动作：不得被当作非资金动作放行
    await prisma.$executeRawUnsafe('DELETE FROM "AuditLog"');
    await request();
    await expect(
      submitRecoveryReview(
        prisma,
        {
          organizationId: ORG,
          actorUserId: ownerId,
          role: 'OWNER',
          caseId,
          decision: 'APPROVE',
          boundAction: 'unknown.action',
          boundPayload: { basisReference: claimId },
        } as never,
        () => new Date(NOW.getTime() + 1000),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }, 60_000);
  it('19 等锁期间执行角色被降级（成员仍有效）→ 锁后拒绝 + claim.submit_rejected 留痕', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await seedApproval();
      const release = await holdCaseLock();
      const pending = submit(base, cookie, { approvalId });
      try {
        await waitFor(
          async () => (await advisoryLockCount(caseLockKey(), false)) >= 1,
          10_000,
          'SUBMIT_WAITING_ON_CASE_LOCK',
        );
        // 降级：OWNER → VIEWER（成员仍 isActive，但权限矩阵不再允许 Claim 提交）
        await prisma.membership.updateMany({
          where: { organizationId: ORG, userId: ownerId },
          data: { role: 'VIEWER' },
        });
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(403);
      expect(await sideEffects()).toMatchObject(ZERO);
      // 锁后权限拒绝必须留痕（claim.submit_rejected），且字段完整、不与成功业务审计混淆
      const rejectedRows = await prisma.auditLog.findMany({ where: { organizationId: ORG, action: 'claim.submit_rejected' } });
      expect(rejectedRows).toHaveLength(1);
      const changes = (rejectedRows[0]?.changes ?? {}) as Record<string, unknown>;
      expect(changes).toMatchObject({
        stage: 'LOCKED_RECHECK',
        result: 'REJECTED',
        reason: 'FORBIDDEN',
        caseId,
        claimId,
        approvalId,
      });
      expect(typeof changes.operationId === 'string' && changes.operationId.startsWith('approval:')).toBe(true);
      // Claim 未推进：状态、submittedAt/submittedBy 均保持未写
      const claimRow = await prisma.claim.findUniqueOrThrow({
        where: { id: claimId },
        select: { status: true, submittedAt: true, submittedBy: true },
      });
      expect(claimRow.status).toBe('DRAFT');
      expect(claimRow.submittedAt).toBeNull();
      expect(claimRow.submittedBy).toBeNull();
      // 审批不得被消费
      const consumed = await prisma.auditLog.count({ where: { organizationId: ORG, action: { contains: 'consumed' } } });
      expect(consumed).toBe(0);
      const successAudits = await prisma.auditLog.count({ where: { organizationId: ORG, action: 'claim.submitted_by_human' } });
      expect(successAudits).toBe(0);
    });
  }, 60_000);
});
