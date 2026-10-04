/**
 * C18-8 Prisma claim store 真实 PostgreSQL 验收（MSG-20261004-29）：
 *   同一 (providerId, deliveryId) 两个**独立连接**并发 → 恰好一个 CLAIMED + 一个 ALREADY_CLAIMED，
 *   且 DB 行数 = 1（atomic durable claim）。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPrismaProviderWebhookReplayClaimStore } from '../services/customs/customs-provider-webhook-replay-claim-prisma-store';

const prisma = new PrismaClient();
const prismaB = new PrismaClient();
const NOW = '2026-10-04T06:00:00.000Z';

beforeAll(async () => {
  await prisma.$connect();
  await prismaB.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  await prismaB.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "CustomsProviderWebhookReplayClaim" CASCADE;');
});

describe('C18-8 Prisma webhook replay claim (PostgreSQL)', () => {
  it('两个独立连接并发同一 (providerId, deliveryId) → exactly one CLAIMED', async () => {
    const storeA = createPrismaProviderWebhookReplayClaimStore(prisma);
    const storeB = createPrismaProviderWebhookReplayClaimStore(prismaB);
    const input = { providerId: 'provider:customs-a', deliveryId: 'delivery:concurrent-1', claimedAt: NOW };

    const [a, b] = await Promise.all([storeA.claim(input), storeB.claim(input)]);
    expect([a, b].sort()).toEqual(['ALREADY_CLAIMED', 'CLAIMED']);
    expect(await storeA.count()).toBe(1);
  });

  it('不同 deliveryId 各自独立领取；重复领取同一 delivery 返回 ALREADY_CLAIMED', async () => {
    const store = createPrismaProviderWebhookReplayClaimStore(prisma);
    expect(await store.claim({ providerId: 'p', deliveryId: 'd1', claimedAt: NOW })).toBe('CLAIMED');
    expect(await store.claim({ providerId: 'p', deliveryId: 'd2', claimedAt: NOW })).toBe('CLAIMED');
    expect(await store.claim({ providerId: 'p', deliveryId: 'd1', claimedAt: NOW })).toBe('ALREADY_CLAIMED');
    expect(await store.count()).toBe(2);
  });
});
