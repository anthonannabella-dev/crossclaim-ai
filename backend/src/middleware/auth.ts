import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../config/env';
import prisma from '../config/database';

// JWT payload
export interface JwtPayload {
  tenantId: string;
  subAccountId?: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      tenant?: JwtPayload;
    }
  }
}

// 验证租户/子账号 JWT
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: '未提供有效的认证令牌' });
    return;
  }

  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, env().JWT_SECRET) as JwtPayload;
    req.tenant = payload;
    next();
  } catch {
    res.status(401).json({ error: '认证令牌无效或已过期' });
  }
}

// 验证管理员 JWT
export function authenticateAdmin(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: '未提供管理员认证' });
    return;
  }

  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, env().JWT_SECRET) as { adminId: string; role: string };
    if (!payload.adminId) {
      res.status(403).json({ error: '无管理员权限' });
      return;
    }
    (req as any).admin = payload;
    next();
  } catch {
    res.status(401).json({ error: '管理员认证无效' });
  }
}

// 验证企业版 API Token (外部API)
export function authenticateApiToken(req: Request, res: Response, next: NextFunction): void {
  const appKey = req.headers['x-app-key'] as string;
  const token = req.headers['x-api-token'] as string;

  if (!appKey || !token) {
    res.status(401).json({ error: '缺少 AppKey 或 API Token' });
    return;
  }

  // 异步验证
  (async () => {
    const apiToken = await prisma.apiToken.findUnique({
      where: { appKey },
      include: { tenant: true },
    });

    if (!apiToken || !apiToken.isActive) {
      res.status(401).json({ error: '无效的 API 凭证' });
      return;
    }

    if (apiToken.tenant.status !== 'ACTIVE') {
      res.status(403).json({ error: '企业账号未激活' });
      return;
    }

    if (apiToken.tenant.planTier !== 'ENTERPRISE') {
      res.status(403).json({ error: '仅企业版支持 API 访问' });
      return;
    }

    const valid = await bcrypt.compare(token, apiToken.tokenHash);
    if (!valid) {
      res.status(401).json({ error: 'API Token 验证失败' });
      return;
    }

    // 让下游通用中间件(限流 planBasedLimiter / 配额 requireQuota / 用量 trackUsage)
    // 正确识别企业租户:它们读取 req.tenant.tenantId 与 req.tenantRecord.planTier。
    // 此前外部鉴权只设了 apiTenant,导致:限流回落 TRIAL(30/min,企业应为1000)、
    // 用量统计因拿不到 tenantId 而静默不计数。
    req.tenant = { tenantId: apiToken.tenant.id, role: 'api' };
    (req as any).tenantRecord = apiToken.tenant;
    (req as any).apiTenant = apiToken.tenant;
    (req as any).apiTokenRecord = apiToken;
    next();
  })().catch(next);
}
