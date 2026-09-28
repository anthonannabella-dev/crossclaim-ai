import rateLimit from 'express-rate-limit';
import { getQuota } from '../config/planQuotas';

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10000,  // 临时大幅放宽
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后重试' },
});

// 认证接口防爆破 (更严格限制)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 5000,  // 临时大幅放宽
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登录尝试过于频繁，请15分钟后重试' },
});

// API 网关限频 (按 AppKey)
export function createApiGatewayLimiter(maxCalls: number) {
  return rateLimit({
    windowMs: 60 * 1000,
    max: maxCalls,
    keyGenerator: (req) => (req as any).apiTokenRecord?.appKey || req.ip || 'unknown',
    message: { error: 'API 调用次数超限' },
  });
}

// 按计划分层的速率限制器 (用于外部API网关)
export const planBasedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => {
    const planTier = (req as any).tenant?.planTier || (req as any).tenantRecord?.planTier || 'TRIAL';
    const quota = getQuota(planTier);
    return quota.apiRateLimit;
  },
  keyGenerator: (req) => (req as any).apiTokenRecord?.appKey || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'API 调用次数超限，请稍后重试或升级套餐' },
  skip: (_req) => {
    // Skip if plan has no API access (let the auth middleware handle 403)
    const planTier = (_req as any).tenant?.planTier || (_req as any).tenantRecord?.planTier || 'TRIAL';
    const quota = getQuota(planTier);
    return quota.apiRateLimit === 0;
  },
});
