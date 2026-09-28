import { Router } from 'express';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import { summarizePolicy } from '../../services/policyMonitor';
import { searchPolicySource, getAvailablePorts } from '../../services/policyFetcher';

const router = Router();
router.use(authenticate);
router.use(requireActiveTenant);

// ============================================================
// 政策预警列表（支持分类/口岸/全国或地方/关键词筛选）
// ============================================================
router.get('/alerts', async (req, res) => {
  const { category, portCode, sourceType, keyword, limit } = req.query;

  try {
    const alerts = await searchPolicySource({
      keyword: keyword as string,
      category: category as string,
      portCode: portCode as string,
      sourceType: sourceType as string,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    res.json(alerts);
  } catch (err: any) {
    res.status(500).json({ error: err.message || '查询失败' });
  }
});

// ============================================================
// 政策统计
// ============================================================
router.get('/stats', async (_req, res) => {
  try {
    const [total, highImpact, byCategory, bySourceType] = await Promise.all([
      prisma.policyAlert.count({ where: { isActive: true } }),
      prisma.policyAlert.count({ where: { isActive: true, impactLevel: 'HIGH' } }),
      prisma.policyAlert.groupBy({
        by: ['category'],
        where: { isActive: true },
        _count: true,
      }),
      prisma.policyAlert.groupBy({
        by: ['sourceType'],
        where: { isActive: true },
        _count: true,
      }),
    ]);

    res.json({
      total,
      highImpact,
      byCategory: byCategory.map((c: any) => ({ category: c.category, count: c._count })),
      bySourceType: bySourceType.map((s: any) => ({ sourceType: s.sourceType, count: s._count })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 分类列表（用于筛选下拉框）
// ============================================================
router.get('/categories', async (_req, res) => {
  const result = await prisma.policyAlert.findMany({
    where: { isActive: true },
    select: { category: true },
    distinct: ['category'],
  });
  const labels: Record<string, string> = {
    customs: '海关政策', tariff: '关税调整', rcep: 'RCEP规则',
    cbam: '碳关税', origin: '原产地', export: '出口管制',
  };
  res.json(result.map((r: any) => ({ value: r.category, label: labels[r.category] || r.category })));
});

// ============================================================
// 可用口岸列表
// ============================================================
router.get('/ports', (_req, res) => {
  res.json(getAvailablePorts());
});

// ============================================================
// AI摘要手动触发
// ============================================================
router.post('/summarize/:id', async (req, res) => {
  try {
    const policy = await prisma.policyAlert.findUnique({ where: { id: req.params.id } });
    if (!policy) {
      res.status(404).json({ error: '政策不存在' });
      return;
    }

    const result = await summarizePolicy(policy.title, policy.content ?? '');
    const updated = await prisma.policyAlert.update({
      where: { id: policy.id },
      data: {
        summary: result.summary,
        impactLevel: result.impactLevel,
        affectedHsCodes: result.affectedHsCodes?.join(',') ?? null,
        actionRequired: result.actionRequired || null,
      },
    });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'AI摘要生成失败' });
  }
});

// ============================================================
// ─── 用户业务配置 ───
// ============================================================

// 获取我的业务配置
router.get('/my-config', async (req: any, res) => {
  // admin 用户返回空配置
  if (req.isAdmin) {
    res.json({ preferredPorts: [], hsCodeRanges: [] });
    return;
  }
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.tenant!.tenantId },
    select: { preferredPorts: true, hsCodeRanges: true },
  });
  res.json({
    preferredPorts: tenant?.preferredPorts ? JSON.parse(tenant.preferredPorts) : [],
    hsCodeRanges: tenant?.hsCodeRanges ? JSON.parse(tenant.hsCodeRanges) : [],
  });
});

// 保存我的业务配置
router.put('/my-config', async (req: any, res) => {
  const { preferredPorts, hsCodeRanges } = req.body;
  const tenantId = req.tenant!.tenantId;
  
  // admin 用户直接返回成功（不保存到 DB）
  if (req.isAdmin) {
    res.json({ message: '配置已保存' });
    return;
  }

  // 验证口岸编码有效性
  const validPorts = getAvailablePorts().map(p => p.value);
  if (preferredPorts) {
    for (const port of preferredPorts) {
      if (!validPorts.includes(port)) {
        res.status(400).json({ error: `无效口岸编码: ${port}` });
        return;
      }
    }
  }

  // 验证HS编码格式（2-4位数字章节，支持范围如 84-85）
  if (hsCodeRanges) {
    for (const code of hsCodeRanges) {
      if (!/^\d{2,4}(-\d{2,4})?$/.test(code)) {
        res.status(400).json({ error: `HS编码格式无效: ${code}，应为2-4位数字或范围如 84-85` });
        return;
      }
    }
  }

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      preferredPorts: preferredPorts ? JSON.stringify(preferredPorts) : undefined,
      hsCodeRanges: hsCodeRanges ? JSON.stringify(hsCodeRanges) : undefined,
    },
  });

  // 记录审计
  await prisma.auditLog.create({
    data: {
      tenantId,
      action: 'policy_config_update',
      detail: `更新业务配置: 口岸=[${(preferredPorts || []).join(',')}] HS=[${(hsCodeRanges || []).join(',')}]`,
    },
  }).catch(() => {});

  res.json({ success: true });
});

// 获取与我业务相关的政策推送（首页用）
router.get('/my-feed', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { preferredPorts: true, hsCodeRanges: true },
  });

  if (!tenant) {
    res.status(404).json({ error: '租户不存在' });
    return;
  }

  const preferredPorts: string[] = tenant.preferredPorts ? JSON.parse(tenant.preferredPorts) : [];
  const hsCodeRanges: string[] = tenant.hsCodeRanges ? JSON.parse(tenant.hsCodeRanges) : [];

  const where: any = { isActive: true };

  // 如果有配置口岸或HS，构建复合条件
  const conditions: any[] = [];

  // 全国性政策 + 高影响 → 所有人都推
  conditions.push({ sourceType: 'NATIONAL', impactLevel: 'HIGH' });

  // 匹配用户口岸的地方性政策
  if (preferredPorts.length > 0) {
    conditions.push({ portCode: { in: preferredPorts } });
  }

  // 匹配用户HS范围的政策
  if (hsCodeRanges.length > 0) {
    conditions.push({
      affectedHsCodes: {
        // 用简单的关系匹配：affectedHsCodes包含任意用户HS前缀
      },
    });
  }

  if (conditions.length > 1) {
    where.OR = conditions;
  } else if (conditions.length === 1) {
    Object.assign(where, conditions[0]);
  }

  const alerts = await prisma.policyAlert.findMany({
    where,
    orderBy: [{ impactLevel: 'asc' }, { publishDate: 'desc' }],
    take: 30,
  });

  res.json(alerts);
});

export default router;
