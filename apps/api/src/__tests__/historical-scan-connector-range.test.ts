// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 7 —— Connector 历史区间 + 覆盖诚实
// 覆盖：range 必须 server-owned（缺 scanRunId 拒绝）；区间透传到 fetcher；
//       provider 实际覆盖被如实回传；请求 5 年但源只给 1 年时不得是 FULL。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runConnectorPull } from '../services/connectors/runner';
import {
  assertServerOwnedConnectorRange,
  type ConnectorDescriptor,
  type Fetcher,
  type FetcherPage,
  type Normalizer,
} from '../services/connectors/types';

const prisma = new PrismaClient();

const ORG = 'a2000000-0000-4000-8000-0000000000aa';
const CONNECTION = 'a2000000-0000-4000-8000-0000000000c2';
const ACTOR = '11111111-1111-4111-8111-111111111111';

const connector: ConnectorDescriptor = {
  connectorId: 'fixture-customs',
  platformType: 'CUSTOMS',
  authKind: 'FILE_UPLOAD',
  readonlyScopes: ['read:entries'],
  resources: ['customs-entry'],
};

const normalizer: Normalizer = {
  normalizerVersion: 'v1',
  platformType: 'CUSTOMS',
  normalize: () => ({ ok: false, reasonCode: 'MISSING_FIELD' }),
};

function makeFetcher(page: Partial<FetcherPage>, capture: { range?: unknown } = {}): Fetcher {
  return {
    async pull(input): Promise<FetcherPage> {
      capture.range = input.range ?? null;
      return { records: [], nextCursor: null, ...page };
    },
  };
}

const deps = () => ({
  cursorStore: {
    async read() {
      return null;
    },
    async write(key: { connectionRef: string; resource: string }, cursor: string) {
      return {
        cursor,
        updatedAt: '2026-10-08T00:00:00.000Z',
        connectionRef: key.connectionRef,
        resource: key.resource,
        cursorVersion: 1,
      };
    },
  },
  quarantine: {
    async write() {
      /* test sink：只记录"无法理解的数据"，本用例全部 quarantine */
    },
  },
  now: () => new Date('2026-10-08T00:00:00.000Z'),
});

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AuditLog", "Membership", "Session", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'connector-range', slug: 'connector-range' } });
  await prisma.user.create({
    data: { id: ACTOR, email: 'connector-range@example.com', displayName: 'Connector Range' },
  });
  await prisma.membership.create({
    data: { id: 'a2000000-0000-4000-8000-0000000000f1', userId: ACTOR, organizationId: ORG, role: 'OWNER' },
  });
});

beforeEach(async () => {
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PHASE 7 · connector historical range + coverage', () => {
  it('range 必须 server-owned：缺 scanRunId / 日期非法 / 区间倒置 → 拒绝', () => {
    expect(() =>
      assertServerOwnedConnectorRange({ from: '2021-10-08', to: '2026-10-08' } as never),
    ).toThrowError(/CONNECTOR_RANGE_NOT_SERVER_OWNED/);
    expect(() =>
      assertServerOwnedConnectorRange({ from: '2021-10-08', to: '2026-10-08', scanRunId: '' }),
    ).toThrowError(/CONNECTOR_RANGE_NOT_SERVER_OWNED/);
    expect(() =>
      assertServerOwnedConnectorRange({ from: '2021/10/08', to: '2026-10-08', scanRunId: 'scan-1' }),
    ).toThrowError(/CONNECTOR_RANGE_INVALID/);
    expect(() =>
      assertServerOwnedConnectorRange({ from: '2026-10-08', to: '2021-10-08', scanRunId: 'scan-1' }),
    ).toThrowError(/CONNECTOR_RANGE_INVERTED/);
    expect(() =>
      assertServerOwnedConnectorRange({ from: '2021-10-08', to: '2026-10-08', scanRunId: 'scan-1' }),
    ).not.toThrow();
  });

  it('runner 把 server-derived 区间透传给 fetcher，并如实回传 coverage', async () => {
    const capture: { range?: unknown } = {};
    const result = await runConnectorPull(
      prisma,
      {
        organizationId: ORG,
        actorUserId: ACTOR,
        role: 'OWNER',
        connector,
        connectionRef: CONNECTION,
        resource: 'customs-entry',
        fetcher: makeFetcher(
          {
            actualCoverageFrom: '2025-10-08',
            actualCoverageTo: '2026-10-08',
            sourceCoverageStatus: 'SOURCE_LIMITED',
          },
          capture,
        ),
        normalizer,
        range: { from: '2021-10-08', to: '2026-10-08', scanRunId: 'scan-run-1' },
      },
      deps(),
    );

    expect(capture.range).toEqual({ from: '2021-10-08', to: '2026-10-08', scanRunId: 'scan-run-1' });
    expect(result.coverage).toEqual({
      from: '2025-10-08',
      to: '2026-10-08',
      status: 'SOURCE_LIMITED',
    });
    expect(result.coverage?.status).not.toBe('FULL');
  });

  it('未提供区间时行为与既有完全一致（coverage = null，不传 range）', async () => {
    const capture: { range?: unknown } = {};
    const result = await runConnectorPull(
      prisma,
      {
        organizationId: ORG,
        actorUserId: ACTOR,
        role: 'OWNER',
        connector,
        connectionRef: CONNECTION,
        resource: 'customs-entry',
        fetcher: makeFetcher({}, capture),
        normalizer,
      },
      deps(),
    );
    expect(capture.range).toBeNull();
    expect(result.coverage).toBeNull();
  });

  it('provider 未上报覆盖时不得默认 FULL（UNKNOWN）', async () => {
    const result = await runConnectorPull(
      prisma,
      {
        organizationId: ORG,
        actorUserId: ACTOR,
        role: 'OWNER',
        connector,
        connectionRef: CONNECTION,
        resource: 'customs-entry',
        fetcher: makeFetcher({ actualCoverageFrom: null, actualCoverageTo: null }),
        normalizer,
        range: { from: '2021-10-08', to: '2026-10-08', scanRunId: 'scan-run-1' },
      },
      deps(),
    );
    expect(result.coverage?.status).toBe('UNKNOWN');
    expect(result.coverage?.status).not.toBe('FULL');
  });
});
