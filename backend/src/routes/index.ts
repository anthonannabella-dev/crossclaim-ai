import { Router, Express } from 'express';
import authRoutes from './routes/auth';
import tenantRoutes from './routes/tenant';
import paymentRoutes from './routes/payment';
import hscodeRoutes from './routes/hscode';
import rcepRoutes from './routes/rcep';
import cbamRoutes from './routes/cbam';
import ocrRoutes from './routes/ocr';
import documentRoutes from './routes/document';
import policyRoutes from './routes/policy';
import aiRoutes from './routes/ai';
import originRoutes from './routes/origin';
import declarationRoutes from './routes/declaration';
import dashboardRoutes from './routes/dashboard';
import reportRoutes from './routes/reports';
import apiTokenRoutes from './routes/apiTokens';
import adminRoutes from './admin/routes';
import webhookRoutes from './routes/webhooks';
import usageRoutes from './routes/usage';
import taxRebateRoutes from './routes/taxRebate';
import taxRebateSupplementRoutes from './routes/taxRebateSupplement';
import batchGroupRoutes from './routes/batchGroup';
import licenseRoutes from './routes/license';
import externalApiRoutes from './api/routes';
import { getHealthReport } from '../services/healthService';
import tenantSelfServiceRoutes from './routes/tenantSelfService';


export function registerRoutes(app: Express): void {
  // 健康检查 — 不要求认证

  // Swagger API 文档 — 重定向到 external/docs JSON spec
  app.get('/api-docs', (_req: any, res: any) => {
    res.redirect('/external/docs');
  });
  app.get('/api/docs/ui', (_req: any, res: any) => {
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>API 文档</title></head>
<body style="font-family:sans-serif;padding:40px;max-width:800px;margin:auto;background:#f5f5f5">
<h1>📋 出口报关合规AI SaaS API 文档</h1>
<p>系统提供两套API：</p>
<h2>1. 内置API (<code>/api/*</code>)</h2>
<p>前端使用的内部接口，需要JWT认证。</p>
<h2>2. 企业版外部API (<code>/external/*</code>)</h2>
<p>供客户系统集成的开放接口，需要 AppKey + API Token 认证。</p>
<p><a href="/external/docs" style="font-size:18px;color:#1890ff;">👉 查看 OpenAPI 3.0 规范文档</a></p>
<hr>
<h3>快速测试</h3>
<pre style="background:#fff;padding:16px;border-radius:8px;border:1px solid #ddd">
# HS编码查询
curl -H "X-App-Key: TESTOAPP" -H "X-API-Token: TESTAPITOKEN" /external/hscode?q=8471

# 一键申报
curl -X POST -H "X-App-Key: TESTOAPP" -H "X-API-Token: TESTAPITOKEN" \
  -H "Content-Type: application/json" \
  -d '{"hsCodes":["8471.30"],"customsMode":"normal"}' \
  /external/submit-once
</pre>
<h3>第三方集成工具</h3>
<p>访问 <a href="/external/docs" target="_blank">/external/docs</a> 获取完整 OpenAPI 3.0 JSON 规范，可导入 Postman / Insomnia / Swagger Editor。</p>
</body></html>`);
  });

    app.get('/health', async (_req, res) => {
    const report = await getHealthReport();
    const httpStatus = report.status === 'healthy' ? 200 : report.status === 'degraded' ? 200 : 503;
    res.status(httpStatus).json(report);
  });

  const router = Router();

  router.use('/auth', authRoutes);
  router.use('/tenant', tenantRoutes);
router.use('/tenant', tenantSelfServiceRoutes);
  router.use('/payments', paymentRoutes);
  router.use('/hscode', hscodeRoutes);
  router.use('/rcep', rcepRoutes);
  router.use('/cbam', cbamRoutes);
  router.use('/ocr', ocrRoutes);
  router.use('/documents', documentRoutes);
  router.use('/policy', policyRoutes);
  router.use('/ai', aiRoutes);
  router.use('/origin', originRoutes);
  router.use('/declaration', declarationRoutes);
  router.use('/dashboard', dashboardRoutes);
  router.use('/reports', reportRoutes);
  router.use('/api-tokens', apiTokenRoutes);
  router.use('/webhooks', webhookRoutes);
  router.use('/usage', usageRoutes);
  router.use('/tax-rebate', taxRebateRoutes);
  router.use('/tax-rebate', taxRebateSupplementRoutes);
router.use('/batch-group', batchGroupRoutes);
  router.use('/license', licenseRoutes);

  app.use('/api', router);

  // 管理后台 (独立路由)
  app.use('/admin', adminRoutes);

  // 外部 API 网关 (企业版)
  app.use('/external', externalApiRoutes);
}