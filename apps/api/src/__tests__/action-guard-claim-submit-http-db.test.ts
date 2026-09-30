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
