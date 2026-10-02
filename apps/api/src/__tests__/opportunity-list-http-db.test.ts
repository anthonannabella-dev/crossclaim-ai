/**
 * TRACK A / PC-02 —— OPPORTUNITY LIST 验收（真实 HTTP + PostgreSQL）
 * MSG-20261002-82 ⑧：same tenant visible / foreign invisible / multi-account attribution /
 * legacy NULL 不猜 account / status·domain·channel·account·amount·date 过滤 /
 * deterministic pagination / unauthorized 401 / 无权限 fail-closed / 无敏感字段 /
 * empty state / action flags。
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
const ORG = 'cc000000-0000-4000-8000-00000000000a';
const ORG_B = 'cc000000-0000-4000-8000-00000000000b';
const SALT = 'pc02-opportunity-list-salt-012345';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'opportunity-pass-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc02-'));
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

async function seedUser(email: string, role: string, organizationId = ORG): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: role + ' user',
      status: 'ACTIVE',
      emailVerified: true,
    },
    select: { id: true },
  });
  await prisma.membership.create({
    data: { organizationId, userId: user.id, role: role as never, isActive: true },
  });
  return user.id;
}

let seq = 0;
async function seedOpportunity(input: {
  organizationId?: string;
  accountId?: string | null;
  status?: 'DETECTED' | 'QUALIFIED' | 'REJECTED' | 'CONVERTED' | 'EXPIRED';
  domain?: 'PLATFORM' | 'LOGISTICS';
  channel?: 'AMAZON_OTHER' | 'UPS';
  recoverable?: string;
  detectedAt?: Date;
  title?: string;
}): Promise<string> {
  seq += 1;
  const created = await prisma.recoveryOpportunity.create({
    data: {
      organizationId: input.organizationId ?? ORG,
      accountId: input.accountId === undefined ? accountA : input.accountId,
      domain: input.domain ?? 'LOGISTICS',
      channel: input.channel ?? 'UPS',
      opportunityType: 'FREIGHT_RATE_OVERCHARGE',
      title: input.title ?? 'PC02 opportunity ' + seq,
      description: 'opaque description',
      amountExpected: new Prisma.Decimal('100.0000'),
      amountActual: new Prisma.Decimal('120.0000'),
      recoverableAmount: new Prisma.Decimal(input.recoverable ?? '20.0000'),
      currency: 'USD',
      status: input.status ?? 'DETECTED',
      detectedAt: input.detectedAt ?? new Date('2026-09-08T00:00:00.000Z'),
    },
    select: { id: true },
  });
  return created.id;
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
    'TRUNCATE TABLE "AuditLog", "RecoveryOpportunity", "PlatformAccount", "SourceConnection", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: 'PC02 租户', slug: 'pc02-org' },
      { id: ORG_B, name: '外部租户', slug: 'pc02-org-b' },
    ],
  });
  accountA = (
    await prisma.platformAccount.create({
      data: { organizationId: ORG, platform: 'UPS', externalAccountId: 'PC02-A', displayName: '账户 A' },
      select: { id: true },
    })
  ).id;
  accountA2 = (
    await prisma.platformAccount.create({
      data: { organizationId: ORG, platform: 'UPS', externalAccountId: 'PC02-A2', displayName: '账户 A2' },
      select: { id: true },
    })
  ).id;
  accountB = (
    await prisma.platformAccount.create({
      data: { organizationId: ORG_B, platform: 'UPS', externalAccountId: 'PC02-B', displayName: '账户 B' },
      select: { id: true },
    })
  ).id;
  await seedUser('ops-pc02@example.com', 'OPS');
  await seedUser('finance-pc02@example.com', 'FINANCE');
  await seedUser('viewer-pc02@example.com', 'VIEWER');
});

describe('PC-02 — opportunity list HTTP contract', () => {
  it('unauthorized → 401；无权限（FINANCE/VIEWER）→ 403', async () => {
    await withServer(async (base) => {
      expect((await fetch(base + '/opportunities')).status).toBe(401);
      const finance = await login(base, 'finance-pc02@example.com');
      expect((await fetch(base + '/opportunities', { headers: { cookie: finance } })).status).toBe(403);
      const viewer = await login(base, 'viewer-pc02@example.com');
      expect((await fetch(base + '/opportunities', { headers: { cookie: viewer } })).status).toBe(403);
    });
  });

  it('same tenant visible；foreign tenant invisible；无敏感字段', async () => {
    const mine = await seedOpportunity({ title: '本租户机会' });
    await seedOpportunity({ organizationId: ORG_B, accountId: accountB, title: '外部租户机会' });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc02@example.com');
      const response = await fetch(base + '/opportunities', { headers: { cookie } });
      expect(response.status).toBe(200);
      const raw = await response.text();
      const body = JSON.parse(raw) as { items: Array<Record<string, unknown>> };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].id).toBe(mine);
      // 12：不得出现任何敏感 / 内部字段名
      for (const forbidden of ['credentialRef', 'raw', 'sourceTransaction', 'passwordHash', 'secret', 'token', 'organizationId']) {
        expect(raw).not.toContain(forbidden);
      }
    });
  });

  it('multi-account 正确归属；legacy NULL 不被推断为当前 connection 账户', async () => {
    const a1 = await seedOpportunity({ accountId: accountA, title: 'A 的机会' });
    const a2 = await seedOpportunity({ accountId: accountA2, title: 'A2 的机会' });
    const legacy = await seedOpportunity({ accountId: null, title: 'legacy 机会' });
    // 即使存在与 legacy 无关的 connection，也不得据此推断
    await prisma.sourceConnection.create({
      data: {
        organizationId: ORG,
        domain: 'LOGISTICS',
        channel: 'UPS',
        kind: 'FILE_UPLOAD',
        status: 'ACTIVE',
        label: 'pc02 bound connection',
        platformAccountId: accountA,
      },
    });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc02@example.com');
      const body = (await (await fetch(base + '/opportunities', { headers: { cookie } })).json()) as {
        items: Array<{ id: string; accountState: string; account: { id: string } | null }>;
      };
      const byId = new Map(body.items.map((item) => [item.id, item]));
      expect(byId.get(a1)?.account?.id).toBe(accountA);
      expect(byId.get(a2)?.account?.id).toBe(accountA2);
      expect(byId.get(legacy)?.accountState).toBe('LEGACY_UNATTRIBUTED');
      expect(byId.get(legacy)?.account).toBeNull();
    });
  });

  it('status / domain / channel / account / amount / date 过滤', async () => {
    await seedOpportunity({ status: 'DETECTED', title: 'd1' });
    await seedOpportunity({ status: 'QUALIFIED', title: 'q1', recoverable: '50.0000' });
    await seedOpportunity({ status: 'DETECTED', domain: 'PLATFORM', channel: 'AMAZON_OTHER', title: 'p1' });
    await seedOpportunity({ accountId: accountA2, title: 'a2' });
    await seedOpportunity({
      title: 'old',
      detectedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc02@example.com');
      const get = async (qs: string) => {
        const response = await fetch(base + '/opportunities?' + qs, { headers: { cookie } });
        expect(response.status).toBe(200);
        return (await response.json()) as { items: Array<{ title: string }>; appliedFilters: Record<string, unknown> };
      };
      expect((await get('status=QUALIFIED')).items.map((i) => i.title)).toEqual(['q1']);
      expect((await get('domain=PLATFORM')).items.map((i) => i.title)).toEqual(['p1']);
      expect((await get('channel=AMAZON_OTHER')).items.map((i) => i.title)).toEqual(['p1']);
      expect((await get('accountId=' + accountA2)).items.map((i) => i.title)).toEqual(['a2']);
      expect((await get('minRecoverable=30')).items.map((i) => i.title)).toEqual(['q1']);
      expect((await get('detectedFrom=2026-06-01')).items.map((i) => i.title)).not.toContain('old');
      expect((await get('detectedTo=2026-03-01')).items.map((i) => i.title)).toEqual(['old']);
      // 非法输入 fail-closed
      expect((await fetch(base + '/opportunities?status=NOPE', { headers: { cookie } })).status).toBe(400);
      expect((await fetch(base + '/opportunities?limit=9999', { headers: { cookie } })).status).toBe(400);
      expect((await fetch(base + '/opportunities?cursor=not-a-cursor', { headers: { cookie } })).status).toBe(400);
    });
  });

  it('deterministic pagination（detectedAt DESC + id DESC；cursor 前进且不重复）', async () => {
    const same = new Date('2026-09-08T00:00:00.000Z');
    for (let index = 0; index < 5; index += 1) {
      await seedOpportunity({ title: 'page-' + index, detectedAt: same });
    }
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc02@example.com');
      const first = (await (
        await fetch(base + '/opportunities?limit=2', { headers: { cookie } })
      ).json()) as { items: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean };
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeTruthy();

      const second = (await (
        await fetch(base + '/opportunities?limit=2&cursor=' + encodeURIComponent(first.nextCursor ?? ''), {
          headers: { cookie },
        })
      ).json()) as { items: Array<{ id: string }>; nextCursor: string | null };
      const third = (await (
        await fetch(base + '/opportunities?limit=2&cursor=' + encodeURIComponent(second.nextCursor ?? ''), {
          headers: { cookie },
        })
      ).json()) as { items: Array<{ id: string }>; hasMore: boolean };

      const seen = [...first.items, ...second.items, ...third.items].map((item) => item.id);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(5);
      expect(third.hasMore).toBe(false);

      // 确定性：同样查询两次结果顺序一致
      const repeat = (await (
        await fetch(base + '/opportunities?limit=5', { headers: { cookie } })
      ).json()) as { items: Array<{ id: string }> };
      expect(repeat.items.map((item) => item.id)).toEqual(seen);
    });
  });

  it('empty state 与 action flags（客户可见状态语义）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc02@example.com');
      const empty = (await (await fetch(base + '/opportunities', { headers: { cookie } })).json()) as {
        items: unknown[];
        hasMore: boolean;
      };
      expect(empty.items).toEqual([]);
      expect(empty.hasMore).toBe(false);
    });

    await seedOpportunity({ status: 'DETECTED', title: 'needs review' });
    await seedOpportunity({ status: 'QUALIFIED', title: 'ready for case' });
    await seedOpportunity({ status: 'REJECTED', title: 'excluded' });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc02@example.com');
      const body = (await (await fetch(base + '/opportunities', { headers: { cookie } })).json()) as {
        items: Array<{
          title: string;
          customerStatus: { code: string; label: string };
          actions: { canQualify: boolean; canReject: boolean; canCreateCase: boolean };
        }>;
      };
      const byTitle = new Map(body.items.map((item) => [item.title, item]));
      expect(byTitle.get('needs review')?.customerStatus.code).toBe('NEEDS_REVIEW');
      expect(byTitle.get('needs review')?.actions).toEqual({
        canQualify: true,
        canReject: true,
        canCreateCase: false,
      });
      expect(byTitle.get('ready for case')?.customerStatus.code).toBe('RECOVERABLE');
      expect(byTitle.get('ready for case')?.actions.canCreateCase).toBe(true);
      expect(byTitle.get('excluded')?.customerStatus.code).toBe('EXCLUDED');
    });
  });
});
