import { Request, Response, NextFunction } from 'express';
import { checkQuota as checkQuotaFn, incrementUsage } from '../services/usageTracker';

/**
 * Middleware: check quota BEFORE request processing.
 * Returns 429 if quota exceeded.
 */
export function requireQuota(resource: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const tenantId = req.tenant?.tenantId;
    const planTier = (req as any).tenantRecord?.planTier || 'TRIAL';

    if (!tenantId) {
      res.status(401).json({ error: '未认证' });
      return;
    }

    checkQuotaFn(tenantId, planTier, resource).then(result => {
      if (!result.allowed) {
        res.status(429).json({
          error: '用量已达上限',
          resource,
          current: result.current,
          limit: result.limit,
          remaining: 0,
          resetAt: result.resetAt,
        });
        return;
      }

      // Attach quota info to request so handler can use it
      (req as any).quotaCheck = result;
      next();
    }).catch(next);
  };
}

/**
 * Middleware: increment usage counter AFTER successful response.
 * Should be called BEFORE the route handler, but it patches res.json
 * to increment on success.
 *
 * Usage: router.post('/classify', requireQuota('ai_classify'), trackUsage('ai_classify'), handler)
 */
export function trackUsage(resource: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const tenantId = req.tenant?.tenantId;
    if (!tenantId) { next(); return; }

    // Increment after response
    const originalJson = _res.json.bind(_res);
    _res.json = function (body: any) {
      // Only count successful responses (2xx)
      if (_res.statusCode >= 200 && _res.statusCode < 300) {
        incrementUsage(tenantId, resource).catch(() => {});
      }
      return originalJson(body);
    } as any;

    next();
  };
}

/**
 * Convenience: apply both requireQuota and trackUsage for a resource.
 */
export function withQuota(resource: string) {
  return [requireQuota(resource), trackUsage(resource)];
}
