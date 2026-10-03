/**
 * R41 —— Amazon SP-API READ-ONLY adapter → 既有 Connector Runner / ClaimItem / Quarantine（fixture-only）
 * ---------------------------------------------------------------------------
 * 依据 MSG-20261001-26 CHANGE B：必须复用既有 sourceFingerprint v1 / ClaimItem 幂等 / cursor 生命周期 /
 * quarantine 白名单 / normalizerVersion / Connector Runner 审计 —— 不得为 Amazon 另建平行 ingest 链。
 * 无真实凭据、无真实 seller 账号、无网络调用（全部 fixture / mocked transport）。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import {
  AmazonAdapterBoundaryError,
  type AmazonCredentialPort,
  type AmazonReadTransport,
} from '../services/adapters/amazon-sp-read-only-adapter';
import {
  AMAZON_CONNECTOR_FINGERPRINT_VERSION,
  AMAZON_SP_NORMALIZER_VERSION,
  AMAZON_SP_READ_ONLY_CONNECTOR,
  createAmazonConnectorFetcher,
  createAmazonConnectorNormalizer,
} from '../services/adapters/amazon-sp-connector';
import { assertQuarantineEntry, type QuarantineEntry, type QuarantineSink } from '../services/connectors/quarantine';
import type { CursorKey, CursorStore } from '../services/connectors/cursor-store';
import { CONNECTOR_AUDIT, runConnectorPull } from '../services/connectors/runner';

const prisma = new PrismaClient();
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'amazon-connector-pass-1';

let ORG = '';
let B2_CONNECTION_ID = '';
let ownerId = '';
let EMAIL = '';

const credentials: AmazonCredentialPort = {
  async getLwaAccessToken() {
    return { token: 'fixture-token', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  },
};

/** 内存 cursor store（实现既有 CursorStore 端口） */
function createMemoryCursorStore() {
  const entries = new Map<string, string>();
  const store: CursorStore = {
    async read(key: CursorKey) {
      return entries.get(key.connectionRef + '|' + key.resource) ?? null;
    },
    async write(key: CursorKey, cursor: string) {
      entries.set(key.connectionRef + '|' + key.resource, cursor);
      return {
        cursor,
        updatedAt: new Date().toISOString(),
        connectionRef: key.connectionRef,
        resource: key.resource,
        cursorVersion: 1,
      };
    },
  };
  return { store, entries };
}

/** 内存 quarantine（实现既有 QuarantineSink；仅存白名单字段） */
function createMemoryQuarantine() {
  const entries: QuarantineEntry[] = [];
  const sink: QuarantineSink = {
    async write(entry) {
      assertQuarantineEntry(entry);
      entries.push(entry);
    },
  };
  return { sink, entries };
}

function orderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    AmazonOrderId: 'A-100',
    PurchaseDate: '2026-09-01T00:00:00.000Z',
    OrderTotal: { Amount: '120.00', CurrencyCode: 'USD' },
    ...overrides,
  };
}

function transportReturning(pages: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ query: Record<string, string>; path: string }> = [];
  let index = 0;
  const transport: AmazonReadTransport = {
    async get(request) {
      calls.push({ query: { ...request.query }, path: request.path });
      const page = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return { status: page.status ?? 200, body: page.body, ...(page.headers ? { headers: page.headers } : {}) };
    },
  };
  return { transport, calls };
}

async function pull(input: {
  transport: AmazonReadTransport;
  cursorStore: CursorStore;
  quarantine: QuarantineSink;
  resource?: string;
}) {
  return runConnectorPull(
    prisma,
    {
      organizationId: ORG,
      actorUserId: ownerId,
      role: 'OWNER',
      connector: AMAZON_SP_READ_ONLY_CONNECTOR,
      connectionRef: B2_CONNECTION_ID,
      resource: input.resource ?? 'orders',
      fetcher: createAmazonConnectorFetcher({ transport: input.transport, credentials }),
      normalizer: createAmazonConnectorNormalizer(),
    },
    { cursorStore: input.cursorStore, quarantine: input.quarantine },
  );
}

async function claimItemCount(): Promise<number> {
  return prisma.claimItem.count({ where: { organizationId: ORG } });
}

async function unrelatedCounts() {
  return {
    ruleEvaluations: await prisma.ruleEvaluation.count({ where: { organizationId: ORG } }),
    payments: await prisma.payment.count({ where: { organizationId: ORG } }),
    settlements: await prisma.settlement.count({ where: { organizationId: ORG } }),
    billingInvoices: await prisma.billingInvoice.count({ where: { organizationId: ORG } }),
    platformWriteAttempts: await prisma.platformWriteAttempt.count({ where: { organizationId: ORG } }),
    ledgerEntries: await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } }),
  };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')",
  );
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE ' + tables.map((row) => '"' + row.tablename + '"').join(', ') + ' CASCADE;',
    );
  }
  await prisma.$disconnect();
});

beforeEach(async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  ORG = randomUUID();
  EMAIL = 'amazon-connector-' + suffix + '@example.com';
  await prisma.organization.create({
    data: { id: ORG, name: 'Amazon connector 租户', slug: 'amazon-connector-' + suffix },
  });
  // TRACK B BATCH 2：连接器/内部调用方必须提供可信连接上下文（同租户 + 已绑定 PlatformAccount）。
  const b2Account = await prisma.platformAccount.create({
    data: {
      organizationId: ORG,
      platform: 'AMAZON',
      externalAccountId: 'fixture-' + ORG,
      displayName: 'fixture account',
    },
  });
  const b2Connection = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'API',
      status: 'ACTIVE',
      label: 'amazon connector fixture',
      platformAccountId: b2Account.id,
    },
  });
  B2_CONNECTION_ID = b2Connection.id;
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
});

describe('R41 — Amazon fixture → 既有 Connector Runner（ClaimItem / Quarantine / Cursor）', () => {
  it('01 正常 Amazon 记录 → ClaimItem（CONNECTOR_IMPORT，指纹复用 sourceFingerprint v1）', async () => {
    const { transport } = transportReturning([{ body: { Orders: [orderPayload()] } }]);
    const { store } = createMemoryCursorStore();
    const { sink, entries } = createMemoryQuarantine();

    const result = await pull({ transport, cursorStore: store, quarantine: sink });
    expect(result.created).toBe(1);
    expect(result.quarantined).toBe(0);
    expect(entries).toHaveLength(0);
    expect(AMAZON_SP_NORMALIZER_VERSION).toBe('amazon-sp-orders-normalizer/v1');
    expect(AMAZON_CONNECTOR_FINGERPRINT_VERSION).toBe('v1');

    const item = await prisma.claimItem.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(item.platformType).toBe('AMAZON');
    expect(item.claimType).toBe('ORDER_DISCREPANCY');
    expect(item.normalizerVersion).toBe(AMAZON_SP_NORMALIZER_VERSION);
    expect(item.fingerprintVersion).toBe('v1');
    // 幂等身份来自 sourceFingerprint（normalizedRef 参与指纹计算，不单独落库）
    expect(item.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(item.platformRef).toBeNull();
  }, 60_000);

  it('02 同页/同记录重放 → ClaimItem 仍 1 条（既有幂等，不另建链）', async () => {
    const { transport } = transportReturning([{ body: { Orders: [orderPayload()] } }]);
    const { store } = createMemoryCursorStore();
    const { sink } = createMemoryQuarantine();

    const first = await pull({ transport, cursorStore: store, quarantine: sink });
    const second = await pull({ transport, cursorStore: store, quarantine: sink });
    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.idempotent).toBe(1);
    expect(await claimItemCount()).toBe(1);
  }, 60_000);

  it('03 金额更正但 identity 不变 → 不拆 Claim（指纹不含金额）', async () => {
    const first = transportReturning([{ body: { Orders: [orderPayload()] } }]);
    const second = transportReturning([
      { body: { Orders: [orderPayload({ OrderTotal: { Amount: '999.00', CurrencyCode: 'USD' } })] } },
    ]);
    const { store } = createMemoryCursorStore();
    const { sink } = createMemoryQuarantine();

    await pull({ transport: first.transport, cursorStore: store, quarantine: sink });
    await pull({ transport: second.transport, cursorStore: store, quarantine: sink });
    expect(await claimItemCount()).toBe(1);
  }, 60_000);

  it('04 malformed shape → Quarantine，不产生 ClaimItem', async () => {
    const { transport } = transportReturning([
      { body: { Orders: [orderPayload(), { foo: 'bar' }, 'not-an-object'] } },
    ]);
    const { store } = createMemoryCursorStore();
    const { sink, entries } = createMemoryQuarantine();

    const result = await pull({ transport, cursorStore: store, quarantine: sink });
    expect(result.created).toBe(1);
    expect(result.quarantined).toBe(2);
    expect(entries.map((entry) => entry.reasonCode)).toEqual(['IDENTITY_UNAVAILABLE', 'INVALID_TYPE']);
    expect(await claimItemCount()).toBe(1);
  }, 60_000);

  it('05 quarantine 不包含 raw payload / customer / token（白名单 + 内容检查）', async () => {
    const { transport } = transportReturning([{ body: { Orders: [{ foo: 'bar', BuyerEmail: 'buyer@example.com' }] } }]);
    const { store } = createMemoryCursorStore();
    const { sink, entries } = createMemoryQuarantine();

    await pull({ transport, cursorStore: store, quarantine: sink });
    expect(entries).toHaveLength(1);
    const serialized = JSON.stringify(entries[0]);
    for (const forbidden of ['BuyerEmail', 'buyer@example.com', 'fixture-token', 'raw']) {
      expect(serialized).not.toContain(forbidden);
    }
    // 白名单字段校验（多余字段会抛错）
    expect(() => assertQuarantineEntry(entries[0]!)).not.toThrow();
  }, 60_000);

  it('06 cursor 成功后推进（携带 NextToken），处理中异常不推进', async () => {
    const ok = transportReturning([
      { body: { Orders: [orderPayload()], NextToken: 'PAGE-2' } },
    ]);
    const { store, entries: cursorEntries } = createMemoryCursorStore();
    const { sink } = createMemoryQuarantine();
    const first = await pull({ transport: ok.transport, cursorStore: store, quarantine: sink });
    expect(first.cursor).toBe('PAGE-2');
    expect(first.exhausted).toBe(false);
    expect([...cursorEntries.values()]).toEqual(['PAGE-2']);

    // 第二页：携带第一页游标请求；随后失败（5xx）→ 游标保持 PAGE-2 不推进
    const failing = transportReturning([{ status: 500, body: {} }]);
    await expect(pull({ transport: failing.transport, cursorStore: store, quarantine: sink })).rejects.toThrow(
      AmazonAdapterBoundaryError,
    );
    expect(failing.calls[0]?.query.NextToken).toBe('PAGE-2');
    expect([...cursorEntries.values()]).toEqual(['PAGE-2']);
  }, 60_000);

  it('07 normalizer version 可追溯（Runner 审计携带版本）', async () => {
    const { transport } = transportReturning([{ body: { Orders: [orderPayload()] } }]);
    const { store } = createMemoryCursorStore();
    const { sink } = createMemoryQuarantine();
    await pull({ transport, cursorStore: store, quarantine: sink });

    const finished = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: ORG, action: CONNECTOR_AUDIT.pullFinished },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const changes = finished.changes as Record<string, unknown>;
    expect(changes.normalizerVersion).toBe(AMAZON_SP_NORMALIZER_VERSION);
    expect(finished.entityId).toBe(AMAZON_SP_READ_ONLY_CONNECTOR.connectorId);
  }, 60_000);

  it('08 Rule Engine 不被 Amazon adapter / Runner 触发；资金与 platform-write 链路零变化', async () => {
    const { transport } = transportReturning([{ body: { Orders: [orderPayload()] } }]);
    const { store } = createMemoryCursorStore();
    const { sink } = createMemoryQuarantine();
    await pull({ transport, cursorStore: store, quarantine: sink });

    expect(await unrelatedCounts()).toEqual({
      ruleEvaluations: 0,
      payments: 0,
      settlements: 0,
      billingInvoices: 0,
      platformWriteAttempts: 0,
      ledgerEntries: 0,
    });
  }, 60_000);

  it('09 WRITE / 未登记 operation 继续 fail-closed（Amazon bridge 不得绕过 allowlist）', async () => {
    const { transport } = transportReturning([{ body: { Orders: [] } }]);
    const { store } = createMemoryCursorStore();
    const { sink } = createMemoryQuarantine();

    await expect(
      pull({ transport, cursorStore: store, quarantine: sink, resource: 'sellers' }),
    ).rejects.toThrow(/OPERATION_NOT_REGISTERED/);
    expect(await claimItemCount()).toBe(0);
  }, 60_000);
});
