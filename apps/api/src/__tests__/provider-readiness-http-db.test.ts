/**
 * TRACK A / PC-11A — `/provider-readiness` 只读投影（真实 HTTP）：合同就绪 ≠ 生产可用。
 * 断言：未认证 401；成员 200；每个 provider 恒 EXTERNAL_GATE / ABSENT / platformWrite=false；响应无 secret。
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

const prisma = new PrismaClient();
const ORG = 'cc666666-0000-4000-8000-000000000010';
const SALT = 'pc11a-readiness-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'provider-readiness-pass-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc11a-'));
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
  return cookie.split(';')[0];
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
    'TRUNCATE TABLE "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'PC11A 租户', slug: 'pc11a-org' } });
  const user = await prisma.user.create({
    data: {
      email: 'viewer-pc11a@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'VIEWER',
      status: 'ACTIVE',
      emailVerified: true,
    },
    select: { id: true },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: user.id, role: 'VIEWER' as never, isActive: true } });
});

describe('PC-11A — /provider-readiness', () => {
  it('未认证 → 401；成员 → 200 且恒 EXTERNAL_GATE / ABSENT / platformWrite=false（无 secret）', async () => {
    await withServer(async (base) => {
      expect((await fetch(base + '/provider-readiness')).status).toBe(401);
      const cookie = await login(base, 'viewer-pc11a@example.com');
      const response = await fetch(base + '/provider-readiness', { headers: { cookie } });
      expect(response.status).toBe(200);
      const raw = await response.text();
      const payload = JSON.parse(raw) as {
        providers: Array<{
          provider: string;
          contractReady: boolean;
          productionCredentials: string;
          readiness: string;
          platformWriteEnabled: boolean;
          requiredHostActions: string[];
          callbackPath: string;
        }>;
        checkedAt: string;
      };
      expect(payload.providers.length).toBeGreaterThanOrEqual(5);
      for (const view of payload.providers) {
        expect(view.contractReady).toBe(true);
        expect(view.readiness).toBe('EXTERNAL_GATE');
        expect(view.productionCredentials).toBe('ABSENT');
        expect(view.platformWriteEnabled).toBe(false);
        expect(view.requiredHostActions.length).toBeGreaterThan(0);
        expect(view.callbackPath.startsWith('/connect/callbacks/')).toBe(true);
      }
      const providers = payload.providers.map((view) => view.provider);
      expect(providers).toContain('AMAZON');
      expect(providers).toContain('TIKTOK_SHOP');
      expect(providers).toContain('WALMART');
      // 只暴露「安全 key 名」（例如 LWA_CLIENT_SECRET 这类变量名），绝不暴露取值；
      // 因此断言的是「没有泄漏标记」而不是禁止出现 "secret" 这个词。
      for (const forbidden of ['PRODUCTION_READY', 'passwordHash', 'credentialRef', 'SANDBOX:']) {
        expect(raw).not.toContain(forbidden);
      }
      // requiredHostActions 只描述宿主需要完成的动作（可含 credential 名称概念），不含任何取值。
      expect(raw).not.toContain('client_secret=');
      // CARRIER QUEUE #3（MSG-20261003-105 ㉗）：carrier readiness 按 provider 分别投影，
      // 恒 ABSENT / platformWrite=false / transport=false（合同就绪 ≠ 生产可用）。
      const carriers = (
        payload as unknown as {
          carriers: Array<{
            provider: string;
            authContractReady: boolean;
            accountDiscoveryContractReady: boolean;
            productionCredentials: string;
            productionApprovalState: string;
            sandboxState: string;
            platformWriteEnabled: boolean;
            transportEnabled: boolean;
            requiredHostActions: string[];
          }>;
        }
      ).carriers;
      expect(carriers.map((view) => view.provider).sort()).toEqual(['FEDEX', 'UPS']);
      for (const carrier of carriers) {
        expect(carrier.authContractReady).toBe(true);
        expect(carrier.accountDiscoveryContractReady).toBe(true);
        expect(carrier.productionCredentials).toBe('ABSENT');
        expect(carrier.productionApprovalState).toBe('NOT_REQUESTED');
        expect(carrier.sandboxState).toBe('AVAILABLE');
        expect(carrier.platformWriteEnabled).toBe(false);
        expect(carrier.transportEnabled).toBe(false);
        expect(carrier.requiredHostActions.length).toBeGreaterThan(0);
      }
    });
  });
});
