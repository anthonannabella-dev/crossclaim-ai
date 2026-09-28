import { Router } from 'express';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import { withQuota } from '../../middleware/usageMiddleware';
import { calculateTaxRebate } from '../../services/taxRebateCalculator';
import { getExportRebateRate } from '../../services/taxRebateRates';

const router = Router();
router.use(authenticate);
router.use(requireActiveTenant);

// 查询退税率
router.get('/rates', async (req, res) => {
  const { hsCode } = req.query;
  if (!hsCode || typeof hsCode !== 'string') {
    res.status(400).json({ error: '请提供 hsCode 参数' });
    return;
  }

  try {
    const rate = await getExportRebateRate(hsCode);
    res.json(rate);
  } catch (err: any) {
    res.status(500).json({ error: err.message || '查询退税率失败' });
  }
});

// 退税计算 (支持单条/批量)
router.post('/calculate', ...withQuota('tax_rebate'), async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { items, exchangeRate } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: '请提供 items 数组 (每条含 hsCode, quantity, unit, unitPrice)' });
    return;
  }

  for (const item of items) {
    if (!item.hsCode || item.quantity == null || !item.unit || item.unitPrice == null) {
      res.status(400).json({ error: '每条必须包含 hsCode, quantity, unit, unitPrice' });
      return;
    }
  }

  try {
    const result = calculateTaxRebate(items, exchangeRate || 7.1);

    // 记录审计日志
    await prisma.auditLog.create({
      data: {
        tenantId,
        action: 'tax_rebate_calculate',
        detail: `${items.length}条HS编码退税计算, 合计退税¥${result.totalRebate}`,
      },
    });

    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '退税计算失败' });
  }
});

// 历史计算记录
router.get('/history', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { limit = '50' } = req.query;

  try {
    const logs = await prisma.auditLog.findMany({
      where: {
        tenantId,
        action: 'tax_rebate_calculate',
      },
      orderBy: { createdAt: 'desc' },
      take: Number(limit),
      select: {
        id: true,
        action: true,
        detail: true,
        createdAt: true,
      },
    });

    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ error: err.message || '查询历史失败' });
  }
});

export default router;
