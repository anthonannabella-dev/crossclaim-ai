import prisma from '../config/database';
import { generateOrderId } from '../utils/helpers';
import { PLAN_PRICES } from '../routes/routes/payment';
import { notifyRenewalSuccess, notifySubscriptionExpiring } from './payment/paymentNotifier';

// 自动续费服务
// 由 cronJobs.ts 中的定时任务调用

export async function processAutoRenewals() {
  // 查找所有月付且明天到期的 ACTIVE 租户
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const expiringStart = new Date(Date.now());
  const expiringEnd = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

  const tenants = await prisma.tenant.findMany({
    where: {
      status: 'ACTIVE',
      paymentCycle: 'MONTHLY',
      expiresAt: { gte: expiringStart, lte: expiringEnd },
    },
  });

  for (const tenant of tenants) {
    const amount = PLAN_PRICES[tenant.planTier]?.monthly || 0;
    const orderId = generateOrderId();

    // 读取租户最近一次支付方式作为默认支付方式
    const lastPayment = await prisma.payment.findFirst({
      where: { tenantId: tenant.id, status: 'success' },
      orderBy: { createdAt: 'desc' },
      select: { paymentMethod: true },
    });
    const defaultMethod = lastPayment?.paymentMethod || 'wechat';

    await prisma.payment.create({
      data: {
        tenantId: tenant.id,
        amount,
        planTier: tenant.planTier,
        paymentCycle: 'MONTHLY',
        paymentMethod: defaultMethod,
        transactionId: orderId,
        status: 'success',
        paidAt: new Date(),
      },
    });

    // 延长到期时间
    const newExpiry = new Date(tenant.expiresAt!.getTime() + 30 * 24 * 60 * 60 * 1000);
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { expiresAt: newExpiry },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        action: 'auto_renewal',
        detail: `自动续费: ¥${amount} 月付, 新到期: ${newExpiry.toISOString()}`,
      },
    });

    notifyRenewalSuccess(tenant.companyName, amount);
  }

  return tenants.length;
}

// 续费前3天提醒
export async function sendRenewalReminders() {
  const threeDaysLater = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const now = new Date();

  const expiring = await prisma.tenant.findMany({
    where: {
      status: 'ACTIVE',
      expiresAt: { gte: now, lte: threeDaysLater },
    },
  });

  for (const tenant of expiring) {
    notifySubscriptionExpiring(tenant.companyName);
  }

  return expiring.length;
}
