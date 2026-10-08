/**
 * HISTORICAL_RECOVERY_SCAN_V1 / UI_RESULT_VIEW —— 只读结果端点真实 HTTP 验收（PHASE 14 发现）
 * ---------------------------------------------------------------------------
 * 背景：PHASE 14 浏览器旅程发现结果页恒为空态 —— 根因是 `GET /recovery-scans/:id`
 * **未列入方法白名单**，方法阶梯落到默认 `['POST']` → 405 METHOD_NOT_ALLOWED（结果页拿不到 summary）。
 * 本测试锁定修复后的契约：认证 GET → 200 只读投影；跨租户 → 404；缺会话 → 401；POST → 405。
 */

import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { LocalFileSystemStorage } from '../services/storage';
import { compileAgentGoal } from '../services/agent-goal/goal-compiler';
import { validateAgentGoalDraft } from '../services/agent-goal/goal-validator';
import { createOrGetRecoveryScan, claimRecoveryScanRun, runHistoricalBackfill } from '../services/historical-scan';
import { evaluateCustomsHistoricalBatch } from '../services/historical-scan/customs-historical-pipeline';

const prisma = new PrismaClient();
const ORG = 'aa222222-0000-4000-8000-00000000000a';
const ORG_B = 'aa222222-0000-4000-8000-00000000000b';
const SALT = 'hist-scan-http-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'hist-scan-pass-1';
const INTENT = '检查我过去 5 年的关税损失，能追回的全部处理';
const NOW = new Date('2026-10-08T00:00:00.000Z');
const REQUESTED_FROM = '2021-10-08';
const REQUESTED_TO = '2026-10-08';
const SOURCE_FROM = '2025-10-08';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-hscan-http-'));
const storage = new LocalFileSystemStorage({ rootDir: storageRoot, secret: SALT, publicBaseUrl: 'http://localhost:3000' });

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
  return cookie.split(';')[0]!;
}

async function seedUser(email: string, organizationId: string): Promise<void> {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
    select: { id: true },
  });
  await prisma.membership.create({
    data: { organizationId, userId: user.id, role: 'OWNER' as never, isActive: true },
  });
}

async function seedScan(organizationId: string, intent: string) {
  const compiled = compileAgentGoal({ text: intent });
  if (!compiled.ok) throw new Error('compile failed');
  const validated = validateAgentGoalDraft({
    draft: compiled.draft,
    context: { organizationId, actorUserId: 'seed-actor', now: NOW },
  });
  const goalId = validated.goalId + '-http';
  await prisma.agentGoal.create({
    data: {
      id: goalId,
      organizationId,
      createdBy: 'seed-actor',
      rawUserIntent: intent,
      normalizedGoal: { version: validated.version, goalDigest: validated.goalDigest },
      status: 'ADMITTED',
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  const created = await createOrGetRecoveryScan(prisma, {
    organizationId,
    goalId,
    goalDigest: validated.goalDigest,
    domain: 'CUSTOMS',
    provider: 'CBP',
    platformAccountId: null,
    requestedFrom: REQUESTED_FROM,
    requestedTo: REQUESTED_TO,
    effectiveFrom: SOURCE_FROM,
    effectiveTo: REQUESTED_TO,
    requestedMonths: 60,
  });
  await claimRecoveryScanRun(prisma, {
    organizationId,
    scanId: created.row.id,
    leaseOwner: 'http-test',
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    now: NOW,
  });
  await runHistoricalBackfill(prisma, {
    organizationId,
    scanId: created.row.id,
    pagePort: {
      async fetchPage({ shard }) {
        return {
          records: [
            {
              entryNumber: 'HTTP-' + shard.key,
              scope: { organizationId, platformAccountId: 'acct-http' },
              hts: '8471.30.0100',
              jurisdiction: 'US',
              entryDate: '2025-01-01',
              liquidationDate: '2025-06-01',
              exportDate: '2026-06-01',
              destructionDate: null,
              evidenceChain: { chainStatus: 'COMPLETE', missing: [], partial: [], lowConfidence: [] },
              counterpartMatch: { status: 'EXACT' },
              verifiedDeadlinePolicy: {
                policyId: 'us-drawback-v1',
                policyVersion: '1.0.0',
                anchorField: 'exportDate',
                daysFromAnchor: 1825,
                verification: 'LEGAL_VERIFIED',
              },
              requestFiling: false,
              now: NOW,
              historicalWindow: { blocksClaimReady: false, reasonCodes: ['FULL_COVERAGE'] },
            },
          ],
          nextCursor: null,
          coverageFrom: SOURCE_FROM,
          coverageTo: REQUESTED_TO,
          coverageStatus: 'SOURCE_LIMITED' as const,
        };
      },
    },
    ingestPort: {
      async ingest({ records }) {
        const batch = evaluateCustomsHistoricalBatch(records as never);
        return { accepted: batch.summary.scanned, rejected: 0, eligibleFound: batch.summary.claimReady };
      },
    },
  });
  return created.row.id;
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "RecoveryScanRun", "AgentGoalRun", "AgentGoal", "AuditLog", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'hscan-http', slug: 'hscan-http' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'hscan-http-b', slug: 'hscan-http-b' } });
  await seedUser('hscan-owner@example.com', ORG);
  await seedUser('hscan-other@example.com', ORG_B);
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "RecoveryScanRun" CASCADE;');
  await prisma.agentGoal.deleteMany({});
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

describe('HISTORICAL_RECOVERY_SCAN_V1 · 结果端点真实 HTTP 契约', () => {
  it('认证 GET /recovery-scans/:id → 200 只读投影（覆盖诚实；filing/payment/externalWrite=false）', async () => {
    const scanId = await seedScan(ORG, INTENT);
    await withServer(async (base) => {
      const cookie = await login(base, 'hscan-owner@example.com');
      const response = await fetch(base + '/recovery-scans/' + scanId, { headers: { cookie } });
      expect(response.status).toBe(200);
      const summary = (await response.json()) as Record<string, unknown>;
      expect(summary.coverage).toBe('SOURCE_LIMITED');
      expect(summary.requestedMonths).toBe(60);
      expect(summary.claimsFiled).toBe(0);
      expect(summary.filingPerformed).toBe(false);
      expect(summary.paymentPerformed).toBe(false);
      expect(summary.externalWritePerformed).toBe(false);
    });
  });

  it('缺会话 → 401；跨租户 → 404（tenant-scoped，不泄漏存在性）', async () => {
    const scanId = await seedScan(ORG, INTENT + '，另一组织用');
    await withServer(async (base) => {
      const anonymous = await fetch(base + '/recovery-scans/' + scanId);
      expect(anonymous.status).toBe(401);

      const otherCookie = await login(base, 'hscan-other@example.com');
      const crossTenant = await fetch(base + '/recovery-scans/' + scanId, { headers: { cookie: otherCookie } });
      expect(crossTenant.status).toBe(404);
    });
  });

  it('方法白名单仍受控：POST /recovery-scans/:id → 405（只读端点不接受写入方法）', async () => {
    const scanId = await seedScan(ORG, INTENT + '，方法用');
    await withServer(async (base) => {
      const cookie = await login(base, 'hscan-owner@example.com');
      const response = await fetch(base + '/recovery-scans/' + scanId, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(405);
    });
  });
});
