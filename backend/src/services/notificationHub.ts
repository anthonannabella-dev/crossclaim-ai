import axios from 'axios';
import { logger } from '../config/logger';
import { env } from '../config/env';
import prisma from '../config/database';

// 统一通知中心: 企微 + 飞书 + 站内消息

type NotificationChannel = 'feishu' | 'wecom' | 'in_app';
type NotificationEvent =
  | 'payment_success'
  | 'payment_failed'
  | 'trial_expiring'
  | 'subscription_expiring'
  | 'policy_update'
  | 'cbam_alert'
  | 'ai_review_needed'
  | 'account_frozen';

interface NotificationPayload {
  tenantId?: string;
  event: NotificationEvent;
  title: string;
  message: string;
  channels?: NotificationChannel[];
}

export async function sendNotification(payload: NotificationPayload) {
  const channels = payload.channels || ['in_app'];
  const tasks: Promise<any>[] = [];

  // 站内通知
  if (channels.includes('in_app') && payload.tenantId) {
    tasks.push(
      prisma.auditLog.create({
        data: {
          tenantId: payload.tenantId,
          action: payload.event,
          detail: `${payload.title}: ${payload.message}`,
        },
      })
    );
  }

  // 飞书机器人
  if (channels.includes('feishu')) {
    const webhook = env().FEISHU_WEBHOOK_URL;
    if (webhook) {
      tasks.push(
        axios.post(webhook, {
          msg_type: 'interactive',
          card: {
            header: { title: { tag: 'plain_text', content: payload.title } },
            elements: [{ tag: 'div', text: { tag: 'lark_md', content: payload.message } }],
          },
        }).then(() => {
          logger.info('[通知] 飞书通知成功', { event: payload.event, tenantId: payload.tenantId });
        }).catch((err: any) => {
          logger.warn('[通知] 飞书通知失败', { event: payload.event, error: err.message });
        })
      );
    } else if (payload.event === 'cbam_alert' || payload.event === 'payment_failed') {
      // 高优先级事件没有配置飞书时记录警告
      logger.warn('[通知] 高优先级事件无飞书配置: ' + payload.event);
    }
  }

  // 企微
  if (channels.includes('wecom')) {
    const webhook = env().WECOM_WEBHOOK_URL;
    if (webhook) {
      tasks.push(
        axios.post(webhook, {
          msgtype: 'markdown',
          markdown: { content: `## ${payload.title}\n${payload.message}` },
        }).catch(() => {})
      );
    }
  }

  await Promise.allSettled(tasks);
}

// 批量提醒到期客户
export async function sendBatchReminders(tenantIds: string[], event: NotificationEvent, title: string, message: string) {
  for (const tenantId of tenantIds) {
    await sendNotification({ tenantId, event, title, message });
  }
}
