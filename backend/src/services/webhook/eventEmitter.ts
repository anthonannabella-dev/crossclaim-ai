import prisma from '../../config/database';
import { deliverWebhook, DeliverResult } from './deliverer';

export interface FireResult {
  subscriptionId: string;
  subscriptionName: string;
  result: DeliverResult;
}

class EventEmitter {
  /**
   * Fire an event: find matching active subscriptions and deliver webhooks.
   * This runs asynchronously — failures do not block the caller.
   */
  async fire(
    eventType: string,
    tenantId: string,
    payload: Record<string, unknown>,
    filter?: (sub: { events: string }) => boolean,
  ): Promise<FireResult[]> {
    // 查询该租户下匹配该事件类型且启用的订阅
    const subscriptions = await prisma.webhookSubscription.findMany({
      where: {
        tenantId,
        isActive: true,
        events: { contains: eventType },
      },
    });

    if (subscriptions.length === 0) return [];

    return this.dispatch(subscriptions.filter(filter || (() => true)), eventType, payload);
  }

  /**
   * Broadcast an event to ALL tenants with matching subscriptions.
   * Used for system-level events like policy updates.
   */
  async broadcast(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<FireResult[]> {
    const subscriptions = await prisma.webhookSubscription.findMany({
      where: {
        isActive: true,
        events: { contains: eventType },
      },
    });

    if (subscriptions.length === 0) return [];

    return this.dispatch(subscriptions, eventType, payload);
  }

  private async dispatch(
    subscriptions: { id: string; name: string; url: string; secret: string }[],
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<FireResult[]> {
    const results: FireResult[] = [];
    const deliveryPromises = subscriptions.map(async (sub) => {
      const result = await deliverWebhook(sub, eventType, payload);
      results.push({
        subscriptionId: sub.id,
        subscriptionName: sub.name,
        result,
      });
    });

    await Promise.allSettled(deliveryPromises);
    return results;
  }
}

export const eventEmitter = new EventEmitter();
