import { Router } from 'express';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { generateOrderId, daysFromNow, monthsFromNow } from '../../utils/helpers';
import { createWechatOrder, verifyWechatCallback } from '../../services/payment/wechatPay';
import { createAlipayOrder, verifyAlipaySign } from '../../services/payment/alipay';
import { notifyPaymentSuccess, notifyRenewalSuccess } from '../../services/payment/paymentNotifier';
import { getRedis, tenantKey } from '../../config/redis';

const router = Router();

router.use(authenticate);

export const PLAN_PRICES: Record<string, { annual: number; monthly: number }> = {
  BASIC: { annual: 1999, monthly: 199 },
  PROFESSIONAL: { annual: 4999, monthly: 499 },
  ENTERPRISE: { annual: 9999, monthly: 999 },
};

const PLAN_NAMES: Record<string, string> = {
  BASIC: '基础版', PROFESSIONAL: '专业版', ENTERPRISE: '企业版',
};

// 获取套餐定价
router.get('/plans', (_req, res) => {
  const plans = Object.entries(PLAN_PRICES).map(([key, prices]) => ({
    tier: key,
    name: PLAN_NAMES[key],
    annual: prices.annual,
    monthly: prices.monthly,
    features: getPlanFeatures(key),
  }));
  res.json(plans);
});

// 获取支付记录
router.get('/', async (req, res) => {
  const payments = await prisma.payment.findMany({
    where: { tenantId: req.tenant!.tenantId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json(payments);
});

// 获取当前订阅状态
router.get('/subscription', async (req, res) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.tenant!.tenantId },
    select: {
      planTier: true, paymentCycle: true, status: true,
      trialEndAt: true, expiresAt: true, subscribedAt: true,
    },
  });
  res.json(tenant);
});

// 创建支付订单
router.post('/create-order', async (req, res) => {
  const { planTier, paymentCycle, paymentMethod } = req.body;
  const tenantId = req.tenant!.tenantId;

  if (!PLAN_PRICES[planTier]) {
    res.status(400).json({ error: '无效的套餐类型' });
    return;
  }

  if (!['wechat', 'alipay'].includes(paymentMethod)) {
    res.status(400).json({ error: '支付方式仅支持 wechat / alipay' });
    return;
  }

  const amount = paymentCycle === 'ANNUAL'
    ? PLAN_PRICES[planTier].annual
    : PLAN_PRICES[planTier].monthly;

  const orderId = generateOrderId();
  const amountInFen = Math.round(amount * 100); // 微信支付用分

  const payment = await prisma.payment.create({
    data: {
      tenantId,
      amount,
      planTier,
      paymentCycle,
      paymentMethod,
      transactionId: orderId,
      status: 'pending',
    },
  });

  // 调用实际支付接口
  let paymentResult: any = { orderId: payment.id, orderNo: orderId, amount };

  try {
    if (paymentMethod === 'wechat') {
      const wxResult = await createWechatOrder({
        orderNo: orderId,
        amount: amountInFen,
        description: `报关合规SaaS-${PLAN_NAMES[planTier]}-${paymentCycle === 'ANNUAL' ? '年付' : '月付'}`,
        paymentCycle,
      });
      paymentResult.qrCode = wxResult.codeUrl;
      paymentResult.prepayId = wxResult.prepayId;
    } else if (paymentMethod === 'alipay') {
      const aliResult = await createAlipayOrder({
        orderNo: orderId,
        amount,
        subject: `报关合规SaaS-${PLAN_NAMES[planTier]}-${paymentCycle === 'ANNUAL' ? '年付' : '月付'}`,
        paymentCycle,
      });
      paymentResult.paymentUrl = aliResult.paymentUrl;
    }
  } catch (payErr) {
    console.error('Payment gateway error:', payErr);
    // 支付网关可能未配置，返回订单信息供手动处理
    paymentResult.qrCode = null;
    paymentResult.paymentUrl = null;
    paymentResult.note = '支付网关暂未配置，请联系管理员';
  }

  res.json(paymentResult);
});

// 微信支付回调 (无需认证 — 由微信调用)
router.post('/callback/wechat', async (req, res) => {
  try {
    // 微信回调是 XML 格式
    const verified = verifyWechatCallback(req.body);
    if (!verified) {
      res.status(400).send('<xml><return_code>FAIL</return_code></xml>');
      return;
    }

    const { out_trade_no, transaction_id } = req.body;

    await handlePaymentSuccess(out_trade_no, transaction_id);

    res.send('<xml><return_code>SUCCESS</return_code></xml>');
  } catch (err) {
    console.error('Wechat callback error:', err);
    res.status(500).send('<xml><return_code>FAIL</return_code></xml>');
  }
});

// 支付宝回调 (无需认证 — 由支付宝调用)
router.post('/callback/alipay', async (req, res) => {
  try {
    const verified = verifyAlipaySign(req.body);
    if (!verified) {
      res.status(400).send('fail');
      return;
    }

    const { out_trade_no, trade_no, trade_status } = req.body;
    if (trade_status === 'TRADE_SUCCESS' || trade_status === 'TRADE_FINISHED') {
      await handlePaymentSuccess(out_trade_no, trade_no);
    }

    res.send('success');
  } catch (err) {
    console.error('Alipay callback error:', err);
    res.status(500).send('fail');
  }
});

// 支付成功通用处理
async function handlePaymentSuccess(outTradeNo: string, transactionId: string) {
  const payment = await prisma.payment.findFirst({
    where: { OR: [{ transactionId: outTradeNo }, { id: outTradeNo }] },
    include: { tenant: true },
  });

  if (!payment || payment.status === 'success') return;

  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: 'success', transactionId, paidAt: new Date() },
  });

  // 计算到期时间
  const now = new Date();
  const currentExpiry = payment.tenant.expiresAt && payment.tenant.expiresAt > now
    ? payment.tenant.expiresAt
    : now;

  const expiryDate = payment.paymentCycle === 'ANNUAL'
    ? new Date(currentExpiry.getTime() + 365 * 24 * 60 * 60 * 1000)
    : new Date(currentExpiry.getTime() + 30 * 24 * 60 * 60 * 1000);

  await prisma.tenant.update({
    where: { id: payment.tenantId },
    data: {
      status: 'ACTIVE',
      planTier: payment.planTier,
      paymentCycle: payment.paymentCycle,
      subscribedAt: payment.tenant.subscribedAt || now,
      expiresAt: expiryDate,
    },
  });

  // 清除缓存
  try {
    const redis = getRedis();
    await redis?.del(tenantKey(payment.tenantId, 'profile'));
  } catch { /* Redis不可用 */ }

  // 审计日志
  await prisma.auditLog.create({
    data: {
      tenantId: payment.tenantId,
      action: 'payment_success',
      detail: `支付成功: ¥${payment.amount} ${PLAN_NAMES[payment.planTier]} ${payment.paymentCycle === 'ANNUAL' ? '年付' : '月付'}, 到期: ${expiryDate.toISOString()}`,
    },
  });

  // Webhook事件
  import('../../services/webhook/eventEmitter').then(({ eventEmitter }) =>
    eventEmitter.fire('payment.completed', payment.tenantId, {
      amount: payment.amount,
      planTier: payment.planTier,
      paymentCycle: payment.paymentCycle,
      expireAt: expiryDate.toISOString(),
    }).catch(() => {}),
  );

  // 发送通知
  notifyPaymentSuccess(
    payment.tenant.companyName,
    payment.amount,
    payment.planTier,
    payment.paymentCycle === 'ANNUAL' ? '年付' : '月付'
  );
}

// 手动续费 (模拟自动续费触发)
router.post('/renew', async (req, res) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.tenant!.tenantId },
  });

  if (!tenant || tenant.paymentCycle !== 'MONTHLY') {
    res.status(400).json({ error: '仅月付用户支持自动续费' });
    return;
  }

  // 创建续费订单
  const amount = PLAN_PRICES[tenant.planTier]?.monthly || 0;
  const orderId = generateOrderId();

  await prisma.payment.create({
    data: {
      tenantId: tenant.id,
      amount,
      planTier: tenant.planTier,
      paymentCycle: 'MONTHLY',
      paymentMethod: 'wechat', // 使用首次支付的支付方式
      transactionId: orderId,
      status: 'success',
      paidAt: new Date(),
    },
  });

  const newExpiry = new Date(
    (tenant.expiresAt && tenant.expiresAt > new Date() ? tenant.expiresAt.getTime() : Date.now()) + 30 * 24 * 60 * 60 * 1000
  );

  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { expiresAt: newExpiry },
  });

  notifyRenewalSuccess(tenant.companyName, amount);

  res.json({ message: '续费成功', newExpiry });
});

// 开票申请
router.post('/:id/invoice', async (req, res) => {
  await prisma.payment.update({
    where: { id: req.params.id },
    data: { invoiceRequested: true },
  });
  res.json({ message: '开票申请已提交，我们将尽快处理' });
});

// 获取套餐权益描述
function getPlanFeatures(tier: string): string[] {
  const features: Record<string, string[]> = {
    BASIC: [
      'HS编码智能查询',
      '基础AI归类问答',
      '政策预警推送',
      '7天全功能试用',
    ],
    PROFESSIONAL: [
      'HS编码智能查询',
      '高级AI归类双校验',
      'RCEP原产地核算',
      'CBAM碳关税测算',
      'OCR单证识别',
      'AEO基础档案',
      '批量单证处理',
      '7天全功能试用',
    ],
    ENTERPRISE: [
      '全部专业版功能',
      '子账号分级管理',
      'REST对外开放API',
      '独立Token+调用统计',
      '关务财务自动对账',
      'AEO年度自查报告',
      'API在线文档',
      '专属技术支持',
      '7天全功能试用',
    ],
  };
  return features[tier] || [];
}

export default router;
