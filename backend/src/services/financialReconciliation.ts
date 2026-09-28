import prisma from '../config/database';

type PaymentRow = {
  amount: number;
  paymentMethod: string;
  planTier: string;
  paymentCycle: string;
  invoiceRequested: boolean;
  status: string;
  paidAt: Date | null;
  tenant?: { companyName: string } | null;
};

// 关务财务自动对账统计服务

export interface ReconciliationResult {
  period: { startDate: string; endDate: string };
  revenue: {
    total: number;
    byPaymentMethod: Record<string, number>;
    byPlanTier: Record<string, number>;
    byPaymentCycle: Record<string, number>;
    monthly: { month: string; amount: number }[];
  };
  subscriptions: {
    active: number;
    trial: number;
    frozen: number;
    churnRate: string;
  };
  invoices: {
    requested: number;
    pending: number;
  };
  topCustomers: { name: string; amount: number }[];
}

export async function runReconciliation(tenantId: string, startDate: string, endDate: string) {
  const [payments, tenant] = await Promise.all([
    prisma.payment.findMany({
      where: {
        tenantId,
        status: 'success',
        paidAt: { gte: new Date(startDate), lte: new Date(endDate) },
      },
      orderBy: { paidAt: 'asc' },
    }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { companyName: true, status: true } }),
  ]);

  const total = payments.reduce((s: number, p: PaymentRow) => s + p.amount, 0);

  // 按支付方式
  const byPaymentMethod: Record<string, number> = {};
  payments.forEach((p: PaymentRow) => {
    byPaymentMethod[p.paymentMethod] = (byPaymentMethod[p.paymentMethod] || 0) + p.amount;
  });

  // 按月汇总
  const monthlyMap: Record<string, number> = {};
  payments.forEach((p: PaymentRow) => {
    const month = p.paidAt?.toISOString().slice(0, 7) || 'unknown';
    monthlyMap[month] = (monthlyMap[month] || 0) + p.amount;
  });

  const monthly = Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amount]) => ({ month, amount }));

  // 按套餐
  const byPlanTier: Record<string, number> = {};
  payments.forEach((p: PaymentRow) => {
    byPlanTier[p.planTier] = (byPlanTier[p.planTier] || 0) + p.amount;
  });

  // 按付费周期
  const byPaymentCycle: Record<string, number> = {};
  payments.forEach((p: PaymentRow) => {
    byPaymentCycle[p.paymentCycle] = (byPaymentCycle[p.paymentCycle] || 0) + p.amount;
  });

  // 开票统计
  const invoiceRequested = payments.filter((p: PaymentRow) => p.invoiceRequested).length;

  const result: ReconciliationResult = {
    period: { startDate, endDate },
    revenue: {
      total,
      byPaymentMethod,
      byPlanTier,
      byPaymentCycle,
      monthly,
    },
    subscriptions: {
      active: tenant?.status === 'ACTIVE' ? 1 : 0,
      trial: tenant?.status === 'TRIAL' ? 1 : 0,
      frozen: tenant?.status === 'FROZEN' || tenant?.status === 'DISABLED' ? 1 : 0,
      churnRate: '0%',
    },
    invoices: {
      requested: invoiceRequested,
      pending: payments.filter((p: PaymentRow) => !p.invoiceRequested && p.status === 'success').length,
    },
    topCustomers: tenant ? [{ name: tenant.companyName, amount: total }] : [],
  };

  return result;
}

// 管理员全局对账
export async function runGlobalReconciliation(startDate: string, endDate: string) {
  const payments = await prisma.payment.findMany({
    where: {
      status: 'success',
      paidAt: { gte: new Date(startDate), lte: new Date(endDate) },
    },
    include: { tenant: { select: { companyName: true } } },
    orderBy: { paidAt: 'asc' },
  });

  const total = payments.reduce((s: number, p: PaymentRow) => s + p.amount, 0);

  // Top customers
  const customerMap: Record<string, number> = {};
  payments.forEach((p: PaymentRow) => {
    const name = p.tenant?.companyName || 'Unknown';
    customerMap[name] = (customerMap[name] || 0) + p.amount;
  });

  const topCustomers = Object.entries(customerMap)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([name, amount]) => ({ name, amount }));

  // Subscription stats
  const [active, trial, frozen] = await Promise.all([
    prisma.tenant.count({ where: { status: 'ACTIVE' } }),
    prisma.tenant.count({ where: { status: 'TRIAL' } }),
    prisma.tenant.count({ where: { status: { in: ['FROZEN', 'DISABLED'] } } }),
  ]);

  const totalTenants = active + trial + frozen;
  const churnRate = totalTenants > 0 ? ((frozen / totalTenants) * 100).toFixed(1) + '%' : '0%';

  // 按月汇总
  const monthlyMap: Record<string, number> = {};
  payments.forEach((p: PaymentRow) => {
    const month = p.paidAt?.toISOString().slice(0, 7) || 'unknown';
    monthlyMap[month] = (monthlyMap[month] || 0) + p.amount;
  });

  const monthly = Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amount]) => ({ month, amount }));

  return {
    period: { startDate, endDate },
    revenue: { total, monthly, byPaymentCycle: {} as any, byPlanTier: {} as any, byPaymentMethod: {} as any },
    subscriptions: { active, trial, frozen, churnRate },
    invoices: { requested: payments.filter((p: PaymentRow) => p.invoiceRequested).length, pending: 0 },
    topCustomers,
  };
}
