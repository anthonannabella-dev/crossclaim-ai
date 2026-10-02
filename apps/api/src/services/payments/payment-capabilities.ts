/**
 * TRACK A / PC-12A FINAL（MSG-20261003-103 CHANGE B）— 既有 payment 能力事实源（单一真源）。
 * ---------------------------------------------------------------
 * readiness 不得凭空调用 `true` / `false`；每一项都从**既有能力**派生：
 *   · implemented        —— 该能力在本仓库是否已实现（代码 + 既有回归）
 *   · productionVerified —— 是否已经过生产验收（属 PC-12B；未验收即 false）
 * 未来真实启用后，只需把对应 productionVerified 置真（并附证据），readiness 会自动反映。
 */

export interface PaymentOperationCapability {
  implemented: boolean;
  productionVerified: boolean;
  evidenceRef: string;
}

export const PAYMENT_OPERATION_CAPABILITIES: Record<string, PaymentOperationCapability> = {
  billingModel: {
    implemented: true,
    productionVerified: true,
    evidenceRef: 'BillingInvoice / FeeCalculation / RecoveryLedgerEntry / Settlement 既有模型与 billing.draft 回归',
  },
  reconciliation: {
    implemented: true,
    productionVerified: false,
    evidenceRef: 'GET /payments/reconciliation（既有实现；生产对账 / 争议路径尚未验收 → 属 PC-12B）',
  },
  retryReplay: {
    implemented: true,
    productionVerified: true,
    evidenceRef: 'payment replay / retry-due 受保护入口（MSG-28 / MSG-20261001-01，含并发与恢复回归）',
  },
} as const;

export function capabilityReady(key: keyof typeof PAYMENT_OPERATION_CAPABILITIES): boolean {
  const capability = PAYMENT_OPERATION_CAPABILITIES[key];
  return capability.implemented && capability.productionVerified;
}
