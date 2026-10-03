/**
 * TRACK B ONBOARDING TRANSPORT CLOSURE（MSG-20261002-78 T1 / T2）
 * ---------------------------------------------------------------
 * canonical PlatformAccount identity（platform + externalAccountId + identityVersion）
 * 只能来自**可信方检索结果**，不能来自客户端直接提交。
 *
 * 真实 provider（Amazon / TikTok Shop / Walmart / Carrier OAuth·API）在凭据获批前继续 HOLD，
 * 因此本批只建立 adapter contract + mock/dev transport：
 *   credential / OAuth authorization
 *     → server 调用身份接口（account profile）
 *     → server 取得 canonical externalAccountId
 *     → create / reuse PlatformAccount
 *     → bind SourceConnection
 *
 * 边界：NO platform write · 真实外写 HOLD · 生产凭据 HOLD · TRANSPORT=false。
 */

import type { Platform } from '@prisma/client';

export type PlatformIdentityVerificationSource =
  | 'PROVIDER_OAUTH'
  | 'PROVIDER_API'
  | 'ADAPTER_MOCK';

export interface VerifiedPlatformIdentity {
  platform: Platform;
  externalAccountId: string;
  displayName: string;
  identityVersion?: string;
  marketplace?: string | null;
  region?: string | null;
}

export interface PlatformIdentityVerification {
  /** 身份来自哪一类可信通道（mock 只能用于 dev/test，不得用于生产）。 */
  source: PlatformIdentityVerificationSource;
  /** 可审计的验证证据引用（例如 provider token id / API 调用流水号）；不得是 secret 本身。 */
  evidenceRef: string;
  verifiedAt: Date;
  identity: VerifiedPlatformIdentity;
}

export interface PlatformIdentityVerifier {
  verify(input: {
    organizationId: string;
    platform: Platform;
    credentialRef: string | null;
  }): Promise<PlatformIdentityVerification>;
}

/**
 * 测试 / 本地开发用的 mock transport：**不发起任何网络请求**，也不读真实凭据。
 * 只有显式注入的 provider 映射才会被「验证」；未登记的 platform 一律 fail-closed。
 */
export function createMockPlatformIdentityVerifier(
  fixtures: Partial<Record<Platform, VerifiedPlatformIdentity>>,
  options: { evidenceRef?: string; now?: () => Date } = {},
): PlatformIdentityVerifier {
  return {
    async verify(input) {
      const identity = fixtures[input.platform];
      if (!identity) {
        throw new Error(
          'PLATFORM_IDENTITY_NOT_VERIFIABLE: mock transport 未登记 platform ' + input.platform,
        );
      }
      return {
        source: 'ADAPTER_MOCK',
        evidenceRef: options.evidenceRef ?? 'mock:' + input.platform + ':' + input.organizationId,
        verifiedAt: (options.now ?? (() => new Date()))(),
        identity,
      };
    },
  };
}
