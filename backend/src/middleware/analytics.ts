import { Request, Response, NextFunction } from 'express';
import { trackEvent } from '../services/analyticsService';

// 自动埋点中间件：记录功能使用
export function trackFeatureUsage(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  res.on('finish', () => {
    // 跳过静态资源和健康检查
    if (req.path === '/health' || req.path.startsWith('/static')) return;

    const duration = Date.now() - start;
    const feature = req.path.split('/').filter(Boolean).join('.') || 'root';

    // 只跟踪成功的业务请求
    if (res.statusCode < 400) {
      trackEvent({
        tenantId: (req as any).tenant?.tenantId,
        event: 'feature_use',
        feature,
        detail: `${req.method} ${req.path} (${duration}ms)`,
        ip: req.ip,
      });
    }
  });

  next();
}
