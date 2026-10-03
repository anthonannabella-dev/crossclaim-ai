/**
 * TRACK A / PC-09（MSG-20261003-96 ⑬）— 客户可见的商业/法律就绪投影（只读）。
 * 只报告安全状态：文档版本 / 接受完成度 / 披露可用性 / payment·integration·transport gate。
 * 严禁返回 secret / 凭据 / 内部堆栈；真实付款与真实 provider 授权保持关闭。
 */

import type { PrismaClient } from '@prisma/client';

import { PAYMENT_STATE } from '../entitlements/plan-entitlements';
import { EXTERNAL_INTEGRATION_GATES } from '../ops/readiness-facts';
import { getAcceptanceStatus, type CommercialActor } from './policy-acceptance';
import { COMMERCIAL_DISCLOSURES, listCurrentPolicies, listPolicyDocuments } from './policy-registry';

export interface CommercialReadiness {
  policies: {
    current: Array<{ key: string; version: string; title: string; effectiveAt: string; requiresExplicitAcceptance: boolean; documentRef: string }>;
    supersededCount: number;
  };
  acceptance: { complete: boolean; outstanding: string[]; items: unknown[] };
  disclosures: typeof COMMERCIAL_DISCLOSURES;
  feeCollection: {
    billingModel: 'EXISTS';
    payment: typeof PAYMENT_STATE.payment;
    collection: typeof PAYMENT_STATE.collection;
    activation: 'HOLD';
    autopay: 'OFF';
    externalWrite: 'OFF';
  };
  integrations: typeof EXTERNAL_INTEGRATION_GATES;
  transport: 'DISABLED';
  checkedAt: string;
}

export async function getCommercialReadiness(
  prisma: PrismaClient,
  actor: CommercialActor,
  deps: { now?: () => Date } = {},
): Promise<CommercialReadiness> {
  const all = listPolicyDocuments();
  const current = listCurrentPolicies().map((document) => ({
    key: document.key,
    version: document.version,
    title: document.title,
    effectiveAt: document.effectiveAt,
    requiresExplicitAcceptance: document.requiresExplicitAcceptance,
    documentRef: document.documentRef,
  }));
  const acceptance = await getAcceptanceStatus(prisma, actor);
  const at = (deps.now ?? (() => new Date()))();
  return {
    policies: { current, supersededCount: all.length - current.length },
    acceptance: { complete: acceptance.complete, outstanding: acceptance.outstanding, items: acceptance.items },
    disclosures: COMMERCIAL_DISCLOSURES,
    feeCollection: {
      billingModel: 'EXISTS',
      payment: PAYMENT_STATE.payment,
      collection: PAYMENT_STATE.collection,
      activation: 'HOLD',
      autopay: 'OFF',
      externalWrite: 'OFF',
    },
    integrations: EXTERNAL_INTEGRATION_GATES,
    transport: 'DISABLED',
    checkedAt: at.toISOString(),
  };
}
