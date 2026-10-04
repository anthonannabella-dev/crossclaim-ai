/** SEO-3 生产限流部署守卫单元验收。 */

import { describe, expect, it } from 'vitest';

import { assertProductionRateLimiter } from '../services/seo/seo-rate-limit';

const canary = (over: Record<string, boolean> = {}) => ({
  singleInstance: true,
  singleNodeProcess: true,
  noPm2Cluster: true,
  noAutoscaleOrServerless: true,
  upstreamGlobalRateLimit: true,
  mapHasTtlOrMaxSize: true,
  hasKillSwitch: true,
  ...over,
});

describe('SEO-3 production rate limiter guard', () => {
  it('dev/staging 模式放行（进程内限流器可用）', () => {
    expect(assertProductionRateLimiter({ mode: 'DEV_STAGING', hasSharedOrEdgeLimiter: false })).toEqual({ ok: true, reason: 'DEV_STAGING_ONLY' });
  });

  it('生产 + 共享/边缘限流 → 放行', () => {
    expect(assertProductionRateLimiter({ mode: 'PRODUCTION', hasSharedOrEdgeLimiter: true })).toEqual({ ok: true, reason: 'SHARED_LIMITER' });
  });

  it('生产 + 仅进程内限流且无 canary 前提 → 拒绝（这正是审计要求的生产门槛）', () => {
    expect(assertProductionRateLimiter({ mode: 'PRODUCTION', hasSharedOrEdgeLimiter: false })).toEqual({ ok: false, reason: 'SHARED_LIMITER_REQUIRED' });
  });

  it('单机 canary：前提齐全才放行，缺任一项即拒绝', () => {
    expect(assertProductionRateLimiter({ mode: 'PRODUCTION', hasSharedOrEdgeLimiter: false, canary: canary() })).toEqual({ ok: true, reason: 'CANARY_ACCEPTED' });
    for (const key of ['singleInstance','singleNodeProcess','noPm2Cluster','noAutoscaleOrServerless','upstreamGlobalRateLimit','mapHasTtlOrMaxSize','hasKillSwitch']) {
      expect(assertProductionRateLimiter({ mode: 'PRODUCTION', hasSharedOrEdgeLimiter: false, canary: canary({ [key]: false }) })).toEqual({ ok: false, reason: 'CANARY_PRECONDITION_MISSING' });
    }
  });
});
