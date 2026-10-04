/**
 * C18-8 — PROVIDER WEBHOOK REPLAY CLAIM（Layer 3 / P0，离线层）
 * ---------------------------------------------------------------
 * MSG-20261004-16/17 的 Production Enablement 硬门槛：webhook 重放防护不能只是
 * 「先读一个 Set、后面再写 C17」——真实入口必须是 **atomic durable claim**：
 *
 *     两个相同的 (providerId, deliveryId) 并发进入 ⇒ 只有一个获得 CLAIMED，
 *     另一个必须拿到 ALREADY_CLAIMED（视作已处理，不再执行业务副作用）。
 *
 * 本模块只定义**端口契约**与进程内实现（零网络、零凭据、零外写），真实落地由 DB
 * 唯一约束或等价事务机制承担（属于 Schema Delta 审计范围，本单元不求 Schema 变更）。
 */

import {
  verifyProviderWebhook,
  type ProviderWebhookErrorCode,
} from './customs-provider-webhook';

export type ProviderWebhookClaimOutcome = 'CLAIMED' | 'ALREADY_CLAIMED';

export interface ProviderWebhookReplayClaimStore {
  /**
   * 原子领取 (providerId, deliveryId)。实现必须保证并发下单一赢家：
   * 例如 `INSERT ... ON CONFLICT DO NOTHING` + 受影响行数判定，或 `(providerId, deliveryId)` 唯一约束。
   */
  claim(input: {
    providerId: string;
    deliveryId: string;
    claimedAt: string;
  }): Promise<ProviderWebhookClaimOutcome>;
}

/**
 * 进程内参考实现：单线程下天然原子；仅用于测试与离线验证真实入口应满足的语义。
 * 它**不是**生产实现——生产必须换成数据库唯一约束（见 C18-8 记录）。
 */
export function createInMemoryProviderWebhookReplayClaimStore(): ProviderWebhookReplayClaimStore & {
  size(): number;
  has(providerId: string, deliveryId: string): boolean;
} {
  const claimed = new Set<string>();
  const keyOf = (providerId: string, deliveryId: string): string => `${providerId}|${deliveryId}`;
  return {
    async claim(input): Promise<ProviderWebhookClaimOutcome> {
      const key = keyOf(input.providerId, input.deliveryId);
      if (claimed.has(key)) return 'ALREADY_CLAIMED';
      claimed.add(key);
      return 'CLAIMED';
    },
    size: () => claimed.size,
    has: (providerId, deliveryId) => claimed.has(keyOf(providerId, deliveryId)),
  };
}

export type ProviderWebhookClaimFailureCode =
  | ProviderWebhookErrorCode
  | 'CLAIM_FAILED'
  | 'REPLAY_DETECTED'
  | 'MISSING_PROVIDER_ID';

export type ProviderWebhookClaimResult =
  | { ok: true; deliveryId: string; outcome: 'CLAIMED'; externalWritePerformed: false }
  | { ok: false; code: ProviderWebhookClaimFailureCode; detail: string };

/**
 * 验签 → 原子领取 → 才允许后续业务处理。
 * 验签失败**不产生 claim**（否则攻击者可用坏签名烧掉合法 deliveryId）。
 */
export async function claimVerifiedProviderWebhookDelivery(input: {
  providerId: string;
  rawBody: string;
  headers: Record<string, string | undefined>;
  secret: string;
  claimStore: ProviderWebhookReplayClaimStore;
  now?: Date;
  toleranceSeconds?: number;
}): Promise<ProviderWebhookClaimResult> {
  if (typeof input.providerId !== 'string' || input.providerId.trim() === '') {
    return { ok: false, code: 'MISSING_PROVIDER_ID', detail: 'providerId is required for the replay claim key' };
  }

  const verified = verifyProviderWebhook({
    rawBody: input.rawBody,
    headers: input.headers,
    secret: input.secret,
    now: input.now,
    toleranceSeconds: input.toleranceSeconds,
  });
  if (!verified.ok) return { ok: false, code: verified.code, detail: verified.detail };

  const deliveryId = verified.deliveryId;
  let outcome: ProviderWebhookClaimOutcome;
  try {
    outcome = await input.claimStore.claim({
      providerId: input.providerId,
      deliveryId,
      claimedAt: (input.now ?? new Date()).toISOString(),
    });
  } catch (error) {
    return { ok: false, code: 'CLAIM_FAILED', detail: String(error) };
  }

  if (outcome !== 'CLAIMED') {
    return { ok: false, code: 'REPLAY_DETECTED', detail: 'delivery id already claimed' };
  }
  return { ok: true, deliveryId, outcome: 'CLAIMED', externalWritePerformed: false };
}

/** 边界自证：claim 层不产生任何外部写 / 凭据使用。 */
export const CUSTOMS_PROVIDER_WEBHOOK_CLAIM_BOUNDARY = {
  externalWritePerformed: false,
  filingSubmitted: false,
  transportEnabled: false,
  credentialReadPerformed: false,
  productionCredentials: 'ABSENT',
  durableClaimRequiredInProduction: true,
} as const;
