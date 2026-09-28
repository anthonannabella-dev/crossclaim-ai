import { Request, Response, NextFunction } from 'express';
import prisma from '../config/database';

// 检查租户是否冻结/禁用
export function requireActiveTenant(req: Request, res: Response, next: NextFunction): void {
  const tenantId = req.tenant?.tenantId;
  if (!tenantId) {
    res.status(401).json({ error: '未认证' });
    return;
  }

  (async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      res.status(404).json({ error: '企业不存在' });
      return;
    }

    if (tenant.status === 'FROZEN') {
      res.status(403).json({ error: '账号因欠费已冻结，请续费后使用' });
      return;
    }

    if (tenant.status === 'DISABLED') {
      res.status(403).json({ error: '账号已被封禁' });
      return;
    }

    (req as any).tenantRecord = tenant;
    next();
  })().catch(next);
}

// 按套餐等级限制功能
export function requirePlan(...tiers: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const tenant = (req as any).tenantRecord;
    if (!tenant) {
      res.status(500).json({ error: '租户信息缺失' });
      return;
    }
    if (!tiers.includes(tenant.planTier)) {
      res.status(403).json({ error: '当前套餐不支持此功能，请升级套餐' });
      return;
    }
    next();
  };
}
