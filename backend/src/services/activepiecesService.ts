import axios from 'axios';

// Activepieces 工作流集成服务
// Activepieces 运行在 Docker 中，默认端口 8080

const AP_BASE = process.env.ACTIVEPIECES_URL || 'http://localhost:8080';

// 触发 Activepieces 工作流
export async function triggerWorkflow(flowId: string, payload: Record<string, any>): Promise<void> {
  try {
    await axios.post(`${AP_BASE}/api/v1/webhooks/${flowId}`, payload, {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(`Activepieces workflow ${flowId} trigger failed:`, err);
  }
}

// 预定义工作流触发

// 新客户注册 → 发送欢迎邮件 + 开通提醒
export async function onNewTenantRegistered(tenantName: string, email: string) {
  await triggerWorkflow('new-tenant-welcome', {
    event: 'tenant.registered',
    tenantName,
    email,
    timestamp: new Date().toISOString(),
  });
}

// 支付成功 → 开通权限 + 发票处理
export async function onPaymentCompleted(tenantId: string, amount: number, planTier: string) {
  await triggerWorkflow('payment-completed', {
    event: 'payment.completed',
    tenantId,
    amount,
    planTier,
    timestamp: new Date().toISOString(),
  });
}

// HS归类置信度低 → 人工复核工单
export async function onLowConfidenceClassification(tenantId: string, hsCode: string, confidence: number) {
  await triggerWorkflow('low-confidence-alert', {
    event: 'classification.low_confidence',
    tenantId,
    hsCode,
    confidence,
    timestamp: new Date().toISOString(),
  });
}

// CBAM碳关税高风险 → 预警
export async function onCBAMHighRisk(tenantId: string, hsCode: string, riskLevel: string) {
  await triggerWorkflow('cbam-high-risk', {
    event: 'cbam.high_risk',
    tenantId,
    hsCode,
    riskLevel,
    timestamp: new Date().toISOString(),
  });
}

// 政策更新 → 推送给所有相关租户
export async function onPolicyUpdated(policyId: string, title: string) {
  await triggerWorkflow('policy-updated', {
    event: 'policy.updated',
    policyId,
    title,
    timestamp: new Date().toISOString(),
  });
}

// OCR单证识别完成 → 归档 + 通知
export async function onOCRCompleted(tenantId: string, documentId: string) {
  await triggerWorkflow('ocr-completed', {
    event: 'ocr.completed',
    tenantId,
    documentId,
    timestamp: new Date().toISOString(),
  });
}
