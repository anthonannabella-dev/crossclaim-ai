import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import { getUsage, getUsageHistory } from '../../services/usageTracker';
import { PLAN_QUOTAS } from '../../config/planQuotas';

const router = Router();
router.use(authenticate);
router.use(requireActiveTenant);

// 当前租户全量用量 + 限额
router.get('/', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const planTier = (req as any).tenantRecord?.planTier || 'TRIAL';

  try {
    const data = await getUsage(tenantId, planTier);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message || '获取用量失败' });
  }
});

// 用量历史 (每日)
router.get('/history', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { resource = 'ai_classify', days = '30' } = req.query;

  try {
    const history = await getUsageHistory(tenantId, resource as string, Number(days));
    res.json({ resource, days: Number(days), history });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '获取用量历史失败' });
  }
});

// 当前计划的配额定义
router.get('/limits', async (req, res) => {
  const planTier = (req as any).tenantRecord?.planTier || 'TRIAL';
  const quota = PLAN_QUOTAS[planTier] || PLAN_QUOTAS.TRIAL;

  res.json({
    plan: planTier,
    quotas: quota,
    allPlans: Object.entries(PLAN_QUOTAS).map(([tier, q]) => ({
      tier,
      ...q,
    })),
  });
});

export default router;
