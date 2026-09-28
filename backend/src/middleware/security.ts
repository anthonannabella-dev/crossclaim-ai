import { Request, Response, NextFunction } from 'express';

// 安全响应头
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  next();
}

// 输入净化 (防XSS)
export function sanitizeInput(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object') {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = req.body[key]
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/on\w+\s*=\s*"[^"]*"/gi, '')
          .replace(/on\w+\s*=\s*'[^']*'/gi, '')
          .trim();
      }
    }
  }
  next();
}

// 移除敏感数据从错误消息
export function noSensitiveLeak(err: any): string {
  if (err.code === 'P2002') return '数据已存在';
  if (err.code === 'P2025') return '记录不存在';
  if (err.name === 'ZodError') return '参数验证失败';
  if (err.name === 'JsonWebTokenError') return '认证失败';
  if (err.name === 'TokenExpiredError') return '认证已过期';
  return '服务器内部错误';
}
