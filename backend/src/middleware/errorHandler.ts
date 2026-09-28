import { Request, Response, NextFunction } from 'express';
import { noSensitiveLeak } from './security';
import { logger } from '../config/logger';

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  logger.error('Unhandled error', {
    message: err.message,
    name: err.name,
    code: err.code,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
  });

  if (err.name === 'ZodError') {
    res.status(400).json({
      error: '参数验证失败',
      details: process.env.NODE_ENV !== 'production' ? err.issues : undefined,
    });
    return;
  }

  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    res.status(401).json({ error: '认证失败或已过期' });
    return;
  }

  // Prisma known errors
  if (err.code === 'P2002') {
    res.status(409).json({ error: '数据已存在' });
    return;
  }
  if (err.code === 'P2025') {
    res.status(404).json({ error: '记录不存在' });
    return;
  }

  const message = process.env.NODE_ENV === 'production'
    ? noSensitiveLeak(err)
    : err.message || '服务器内部错误';

  res.status(err.status || err.statusCode || 500).json({ error: message });
}

// 404 handler
export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: '接口不存在' });
}
