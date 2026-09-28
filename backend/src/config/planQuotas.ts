export interface PlanQuota {
  aiClassifyDaily: number;
  documentsMonthly: number;
  declarationsMonthly: number;
  ocrMonthly: number;
  cbamMonthly: number;
  rcepMonthly: number;
  apiCallsDaily: number;
  taxRebateMonthly: number;
  storageMB: number;
  subAccounts: number;
  apiRateLimit: number; // req/min for /external
}

export const PLAN_QUOTAS: Record<string, PlanQuota> = {
  TRIAL: {
    aiClassifyDaily: 10,
    documentsMonthly: 20,
    declarationsMonthly: 3,
    ocrMonthly: 10,
    cbamMonthly: 5,
    rcepMonthly: 10,
    apiCallsDaily: 100,
    taxRebateMonthly: 10,
    storageMB: 50,
    subAccounts: 0,
    apiRateLimit: 30,
  },
  BASIC: {
    aiClassifyDaily: 20,
    documentsMonthly: 50,
    declarationsMonthly: 10,
    ocrMonthly: 20,
    cbamMonthly: 10,
    rcepMonthly: 20,
    apiCallsDaily: 0,
    taxRebateMonthly: 20,
    storageMB: 100,
    subAccounts: 1,
    apiRateLimit: 0,
  },
  PROFESSIONAL: {
    aiClassifyDaily: 100,
    documentsMonthly: 300,
    declarationsMonthly: 100,
    ocrMonthly: 200,
    cbamMonthly: 100,
    rcepMonthly: 200,
    apiCallsDaily: 5000,
    taxRebateMonthly: 200,
    storageMB: 1024,
    subAccounts: 5,
    apiRateLimit: 300,
  },
  ENTERPRISE: {
    aiClassifyDaily: 500,
    documentsMonthly: 2000,
    declarationsMonthly: 500,
    ocrMonthly: 1000,
    cbamMonthly: 500,
    rcepMonthly: 1000,
    apiCallsDaily: 50000,
    taxRebateMonthly: 1000,
    storageMB: 10240,
    subAccounts: 20,
    apiRateLimit: 1000,
  },
};

export function getQuota(planTier: string): PlanQuota {
  return PLAN_QUOTAS[planTier] || PLAN_QUOTAS.TRIAL;
}

export const RESOURCE_LABELS: Record<string, string> = {
  ai_classify: 'AI智能归类',
  document_upload: '单证上传',
  declaration_build: '报关单构建',
  ocr: 'OCR识别',
  cbam: 'CBAM碳关税测算',
  rcep: 'RCEP关税核算',
  tax_rebate: '出口退税计算',
  api_call: '外部API调用',
};

export const DAILY_RESOURCES = ['ai_classify', 'api_call'];
export const MONTHLY_RESOURCES = ['document_upload', 'declaration_build', 'ocr', 'cbam', 'rcep', 'tax_rebate'];
