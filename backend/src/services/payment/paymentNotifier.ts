import axios from 'axios';
import { env } from '../../config/env';

// 支付通知服务: 企微/飞书消息推送 + 站内通知

export async function notifyPaymentSuccess(tenantName: string, amount: number, planTier: string, cycle: string) {
  const planNames: Record<string, string> = { BASIC: '基础版', PROFESSIONAL: '专业版', ENTERPRISE: '企业版' };
  const cycleNames: Record<string, string> = { ANNUAL: '年付', MONTHLY: '月付' };
  const message = `💰 新付费客户\n企业: ${tenantName}\n套餐: ${planNames[planTier] || planTier}\n金额: ¥${amount}\n方式: ${cycleNames[cycle] || cycle}`;

  await sendNotification(message);
}

export async function notifyTrialExpiring(tenantName: string, daysLeft: number) {
  const message = `⏰ 试用即将到期\n企业: ${tenantName}\n剩余: ${daysLeft} 天`;
  await sendNotification(message);
}

export async function notifySubscriptionExpiring(tenantName: string) {
  const message = `⚠ 付费即将到期\n企业: ${tenantName}\n请及时续费`;
  await sendNotification(message);
}

export async function notifyRenewalSuccess(tenantName: string, amount: number) {
  const message = `🔄 自动续费成功\n企业: ${tenantName}\n金额: ¥${amount}`;
  await sendNotification(message);
}

async function sendNotification(message: string) {
  const config = env();

  const promises: Promise<any>[] = [];

  // 飞书通知
  if (config.FEISHU_WEBHOOK_URL) {
    promises.push(
      axios.post(config.FEISHU_WEBHOOK_URL, {
        msg_type: 'text',
        content: { text: message },
      }).catch(() => {})
    );
  }

  // 企微通知
  if (config.WECOM_WEBHOOK_URL) {
    promises.push(
      axios.post(config.WECOM_WEBHOOK_URL, {
        msgtype: 'text',
        text: { content: message },
      }).catch(() => {})
    );
  }

  await Promise.allSettled(promises);
}
