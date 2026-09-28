import cron from 'node-cron';
import { tenantService } from './tenantService';
import { processAutoRenewals, sendRenewalReminders } from './autoRenewal';
import { fetchLatestPolicies } from './policyFetcher';
import { runPolicyMonitor } from './policyMonitor';
import { resetDailyCounters, resetMonthlyCounters } from './usageTracker';
import { runDatabaseBackup } from './backupService';
import { sendTrialExpiringEmail } from './emailService';
import { checkAndAlert } from './healthService';
import prisma from '../config/database';

export function startCronJobs() {
  // 每天凌晨 2:30 — 数据库备份 (pg_dump + 上传 MinIO)
  cron.schedule('30 2 * * *', async () => {
    console.log('[Cron] 开始数据库备份...');
    const ok = await runDatabaseBackup();
    console.log(`[Cron] 数据库备份${ok ? '成功' : '失败'}`);
  });
  // 每天凌晨 2:00 — 检查过期 + 自动续费
  cron.schedule('0 2 * * *', async () => {
    console.log('[Cron] 检查试用到期...');
    const frozenTrials = await tenantService.checkAndFreezeTrials();
    console.log(`[Cron] 冻结了 ${frozenTrials} 个试用到期账号`);

    console.log('[Cron] 检查付费到期...');
    const frozenPaid = await tenantService.checkAndFreezeExpired();
    console.log(`[Cron] 冻结了 ${frozenPaid} 个付费到期账号`);

    console.log('[Cron] 处理自动续费...');
    const renewed = await processAutoRenewals();
    console.log(`[Cron] 自动续费了 ${renewed} 个月付账号`);
  });

  // 每6小时 — 海关政策自动抓取
  cron.schedule('0 */6 * * *', async () => {
    console.log('[Cron] 抓取最新海关政策...');
    const newPolicies = await fetchLatestPolicies();
    if (newPolicies > 0) {
      console.log(`[Cron] 新增 ${newPolicies} 条政策`);
    }
  });

  // 每天凌晨3:00 — AI摘要政策 + 推送通知
  cron.schedule('0 3 * * *', async () => {
    console.log('[Cron] AI政策摘要与推送...');
    const summarized = await runPolicyMonitor();
    console.log(`[Cron] AI摘要了 ${summarized} 条政策`);
  });

  // 每天上午 9:00 — 到期提醒
  cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] 发送续费提醒...');
    const reminded = await sendRenewalReminders();
    console.log(`[Cron] 向 ${reminded} 个账号发送了续费提醒`);

    const expiringTrials = await tenantService.getExpiringTenants(3);
    if (expiringTrials.length > 0) {
      console.log(`[Cron] ${expiringTrials.length} 个试用即将到期，发送邮件提醒...`);
      for (const tenant of expiringTrials) {
        const daysLeft = tenant.trialEndAt
          ? Math.ceil((tenant.trialEndAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
          : 3;
        if (daysLeft > 0) {
          await sendTrialExpiringEmail(tenant.contactEmail, tenant.companyName, daysLeft);
        }
      }
    }
  });

  // 每天凌晨 4:00 — 清理30天前的旧日计数器
  cron.schedule('0 4 * * *', async () => {
    console.log('[Cron] 清理旧日计数器...');
    await resetDailyCounters();
  });

  // 每月1号凌晨 1:00 — 清理12个月前的旧月计数器
  cron.schedule('0 1 1 * *', async () => {
    console.log('[Cron] 清理旧月计数器...');
    await resetMonthlyCounters();
  });

  // 每月1号重置月度API调用统计
  cron.schedule('0 0 1 * *', async () => {
    console.log('[Cron] 重置月度API调用计数...');
    await prisma.apiToken.updateMany({ data: { monthlyCalls: 0 } });
  });

  // 每5分钟 — 系统健康检查
  cron.schedule('*/5 * * * *', async () => {
    await checkAndAlert();
  });

  // 每10分钟 — 报关流水线卡死恢复(进程重启会丢失 process.nextTick 在途任务)
  cron.schedule('*/10 * * * *', async () => {
    try {
      const { recoverStuckGroups } = await import('./groupPipelineService');
      const n = await recoverStuckGroups();
      if (n > 0) console.log(`[Cron] 恢复了 ${n} 个卡死的报关分组`);
    } catch (err) {
      console.error('[Cron] 流水线卡死恢复失败:', (err as Error).message);
    }
  });

  console.log('定时任务已启动 (备份/试用冻结/付费冻结/自动续费/到期提醒/政策抓取/健康检查/API统计/配额清理)');
// ============================================================
// 数据自动更新服务 — 2026年新增
// ============================================================

  // 每月1号凌晨 3:00 — HS 编码数据自动更新（本地JSON文件 + 税率推算法则，无外部API依赖）
  cron.schedule('0 3 1 * *', async () => {
    console.log('[Cron] 开始自动更新HS编码数据...');
    try {
      const { updateAllHSCodes } = await import('./hsCodeUpdater');
      const count = await updateAllHSCodes();
      console.log(`[Cron] HS编码更新完成: ${count} 条`);
    } catch (err) {
      console.error('[Cron] HS编码更新失败:', (err as Error).message);
    }
  });

  // 每月1号凌晨 3:30 — 出口退税率 + 增值税率自动更新（写入数据库）
  cron.schedule('30 3 1 * *', async () => {
    console.log('[Cron] 开始更新出口退税率和增值税率...');
    try {
      const { updateAllTaxRates } = await import('./taxRateService');
      const count = await updateAllTaxRates();
      console.log(`[Cron] 税率更新完成, 共更新 ${count} 条记录`);
    } catch (err) {
      console.error('[Cron] 税率更新失败:', (err as Error).message);
    }
  });

  // 每月1号凌晨 4:00 — FTA/RCEP 优惠税率自动更新
  cron.schedule('0 4 1 * *', async () => {
    console.log('[Cron] 开始更新FTA/RCEP优惠税率...');
    try {
      const { updateAllFtaRates } = await import('./ftaUpdater');
      const result = await updateAllFtaRates();
      console.log(`[Cron] FTA更新完成: ${result.rulesUpdated} 条规则, ${result.agreementsChecked} 个协定`);
    } catch (err) {
      console.error('[Cron] FTA更新失败:', (err as Error).message);
    }
  });

  // 每周一上午 9:00 — CBAM 碳价自动更新
  cron.schedule('0 9 * * 1', async () => {
    console.log('[Cron] 开始更新CBAM碳价...');
    try {
      const { updateCarbonPricing } = await import('./carbonPricingUpdater');
      const ok = await updateCarbonPricing();
      console.log(`[Cron] CBAM碳价更新${ok ? '成功' : '失败'}`);
    } catch (err) {
      console.error('[Cron] CBAM碳价更新失败:', (err as Error).message);
    }
  });

  console.log('数据自动更新任务已启动 (HS编码/退税率/FTA税率/CBAM碳价)');

}
