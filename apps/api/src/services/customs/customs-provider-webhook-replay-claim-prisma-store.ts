/**
 * C18-8 — PRISMA webhook replay claim store（atomic durable claim 的真实实现）
 * ---------------------------------------------------------------
 * 契约（C18-8 端口）：`claim(providerId, deliveryId)` 必须**原子**且单一赢家。
 * 这里用 `(providerId, deliveryId)` 唯一约束 + `INSERT ... ON CONFLICT DO NOTHING`
 * （Prisma `create` + 捕获 P2002）实现；两个并发连接下只有一个拿到 CLAIMED。
 *
 * 只存 id / 时间，不存 raw body、不存签名、不读凭据。
 */

import type { PrismaClient } from '@prisma/client';

import type { ProviderWebhookClaimOutcome, ProviderWebhookReplayClaimStore } from './customs-provider-webhook-replay-claim';

export function createPrismaProviderWebhookReplayClaimStore(
  prisma: PrismaClient,
): ProviderWebhookReplayClaimStore & { count(): Promise<number> } {
  return {
    async claim(input: { providerId: string; deliveryId: string; claimedAt: string }): Promise<ProviderWebhookClaimOutcome> {
      try {
        await prisma.customsProviderWebhookReplayClaim.create({
          data: {
            providerId: input.providerId,
            deliveryId: input.deliveryId,
            claimedAt: new Date(input.claimedAt),
          },
        });
        return 'CLAIMED';
      } catch (error) {
        // P2002 = 唯一约束冲突 = 同一 (providerId, deliveryId) 已被领取（并发单一赢家）。
        if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
          return 'ALREADY_CLAIMED';
        }
        throw error;
      }
    },
    async count(): Promise<number> {
      return prisma.customsProviderWebhookReplayClaim.count();
    },
  };
}
