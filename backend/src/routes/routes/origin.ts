import { Router } from 'express';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import { calculateRvc, determineOrigin, OriginDeterminationInput } from '../../services/originService';
import { compareOrigins } from '../../services/originCompareService';

const router = Router();

router.use(authenticate);

// 解析成员国列表（数据库以 JSON 字符串存储）
function parseMemberCountries(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return String(raw).split(',').map(s => s.trim()).filter(Boolean);
  }
}

// 1) FTA 协定列表
router.get('/fta-agreements', async (_req, res) => {
  try {
    const list = await prisma.ftaAgreement.findMany({
      where: { isActive: true },
      orderBy: { effectiveDate: 'desc' },
    });
    res.json(list.map((f: any) => ({ ...f, memberCountries: parseMemberCountries(f.memberCountries) })));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || '获取FTA协定失败' });
  }
});

// 2) 原产地规则查询（按协定 / HS编码 / 规则类型过滤）
router.get('/rules', async (req, res) => {
  try {
    const { ftaId, hsCode, ruleType } = req.query as Record<string, string>;
    const where: any = {};
    if (ftaId) where.ftaAgreementId = ftaId;
    if (ruleType) where.ruleType = ruleType;
    if (hsCode) where.hsCode = { startsWith: String(hsCode).trim() };

    const rules = await prisma.originRule.findMany({
      where,
      include: { ftaAgreement: { select: { shortName: true, name: true } } },
      orderBy: { hsCode: 'asc' },
      take: 500,
    });
    res.json(rules);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || '查询原产地规则失败' });
  }
});

// 3) RVC 区域价值成分测算
router.post('/rvc-calculate', async (req, res) => {
  try {
    const fobValue = Number(req.body?.fobValue);
    const nonOriginatingValue = Number(req.body?.nonOriginatingValue);
    const threshold = Number(req.body?.threshold ?? 40);
    if (!Number.isFinite(fobValue) || !Number.isFinite(nonOriginatingValue)) {
      res.status(400).json({ error: 'fobValue 与 nonOriginatingValue 必须为数字' });
      return;
    }
    const result = calculateRvc({ fobValue, nonOriginatingValue }, threshold);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'RVC测算失败' });
  }
});

// 4) 原产地资格判定
router.post('/determine', async (req, res) => {
  try {
    const { ftaId, hsCode, materials, fobValue } = req.body || {};
    if (!ftaId || !hsCode || !Array.isArray(materials) || materials.length === 0) {
      res.status(400).json({ error: '缺少 ftaId / hsCode / materials' });
      return;
    }

    const fta = await prisma.ftaAgreement.findUnique({ where: { id: ftaId } });
    if (!fta) {
      res.status(404).json({ error: '指定的FTA协定不存在' });
      return;
    }

    const rule = await prisma.originRule.findFirst({
      where: { ftaAgreementId: ftaId, hsCode: String(hsCode).trim() },
    });
    if (!rule) {
      res.status(404).json({ error: `该协定下未配置 HS ${hsCode} 的原产地规则` });
      return;
    }

    const input: OriginDeterminationInput = {
      ftaMemberCountries: parseMemberCountries(fta.memberCountries),
      materials: materials.map((m: any) => ({
        hsCode: String(m.hsCode || ''),
        originCountry: String(m.originCountry || ''),
        value: Number(m.value) || 0,
      })),
      fobValue: Number(fobValue) || 0,
      rule: { ruleType: rule.ruleType, ruleDetail: rule.ruleDetail, rvcThreshold: rule.rvcThreshold },
    };

    const result = determineOrigin(input);
    res.json({
      ...result,
      fta: { shortName: fta.shortName, name: fta.name },
      tariffReduction: rule.tariffReduction ?? null,
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || '原产地判定失败' });
  }
});

// 5) 多协定择优比对（按目的国找最优 FTA）
router.post('/compare', requireActiveTenant, async (req, res) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const { hsCode, destCountry } = req.body || {};
    if (!destCountry) {
      res.status(400).json({ error: '请提供目的国 destCountry' });
      return;
    }
    const result = await compareOrigins(tenantId, String(hsCode || ''), String(destCountry));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || '协定比对失败' });
  }
});

export default router;
