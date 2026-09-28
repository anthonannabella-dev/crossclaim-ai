import { Router } from 'express';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant, requirePlan } from '../../middleware/tenant';
import { parseSupervisionCodes } from '../../services/customsCodes';
import { lookupDeclarationElements } from '../../services/declarationElements';

const router = Router();

// 公开 HS 编码搜索 (无需认证，供外部前端查询)
router.get('/public/search', async (req, res) => {
  const { keyword, q } = req.query;
  const searchTerm = (keyword || q || '') as string;
  const term = searchTerm.trim();
  if (!term) {
    res.json({ success: true, data: [] });
    return;
  }

  const results = await prisma.hSCode.findMany({
    where: {
      OR: [
        { code: { contains: term } },
        { description: { contains: term } },
      ],
    },
    take: 50,
  });

  const mapped = results.map((item: any) => ({
    code: item.code,
    name: item.description,
    unit: item.unit,
    mfn_rate: item.tariffRate,
    export_rate: item.exportRate,
    vat_rate: item.vatRate,
    excise_rate: item.exciseRate,
    supervision: item.supervision,
    supervision_certs: parseSupervisionCodes(item.supervision),
    chapter: item.code.split(".")[0],
  }));

  res.json({ success: true, data: mapped });
});

// 双认证中间件：租户 JWT 或管理员 JWT
router.use((req: any, res: any, next: any) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: '\u672a\u63d0\u4f9b\u6709\u6548\u7684\u8ba4\u8bc1\u4ee4\u724c' });
    return;
  }
  try {
    const token = header.slice(7);
    const jwt = require('jsonwebtoken');
    const { env } = require('../../config/env');
    const payload = jwt.verify(token, env().JWT_SECRET);
    if (payload.tenantId) {
      req.tenant = payload;
      next();
      return;
    }
    if (payload.id && payload.role) {
      req.tenant = { tenantId: 'admin', role: 'admin', subAccountId: undefined };
      req.isAdmin = true;
      next();
      return;
    }
    res.status(403).json({ error: '\u65e0\u6cd5\u8bc6\u522b\u7528\u6237\u8eab\u4efd' });
  } catch {
    res.status(401).json({ error: '\u8ba4\u8bc1\u4ee4\u724c\u65e0\u6548\u6216\u5df2\u8fc7\u671f' });
  }
});

// HS编码搜索 (需认证)
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || typeof q !== 'string') {
    res.json([]);
    return;
  }

  const searchTerm = q.trim();
  if (!searchTerm) {
    res.json([]);
    return;
  }

  const results = await prisma.hSCode.findMany({
    where: {
      OR: [
        { code: { contains: searchTerm } },
        { description: { contains: searchTerm } },
      ],
    },
    take: 50,
  });
  res.json(results);
});

// HS编码详情(含多国税率) — 支持格式降级匹配
router.get('/:code', async (req, res) => {
  const reqCode = String(req.params.code);
  const digits = reqCode.replace(/[^0-9]/g, '');

  let item = await prisma.hSCode.findUnique({
    where: { code: reqCode },
  });
  if (!item) {
    item = await prisma.hSCode.findFirst({
      where: { code: { startsWith: digits.slice(0, 6) } },
      orderBy: { code: 'asc' },
    });
  }
  if (!item) {
    item = await prisma.hSCode.findFirst({
      where: { code: { startsWith: digits.slice(0, 4) } },
      orderBy: { code: 'asc' },
    });
  }
  if (!item) {
    res.status(404).json({ error: 'HS\u7f16\u7801\u4e0d\u5b58\u5728' });
    return;
  }
  res.json(item);
});

// 申报要素查询:按 HS 编码返回规格型号需逐项填写的申报要素清单
router.get('/:code/elements', async (req, res) => {
  const code = String(req.params.code);
  const hit = lookupDeclarationElements(code);
  if (!hit) {
    res.json({ success: true, data: { matchedCode: null, elements: [], note: '未查到该 HS 的申报要素，请以单一窗口为准' } });
    return;
  }
  res.json({
    success: true,
    data: {
      matchedCode: hit.matchedCode,
      elements: hit.elements,
      broadened: !!hit.broadened,
      note: hit.broadened
        ? `输入编码较短，已按子目 ${hit.matchedCode} 展示，请按实际10位编码核对`
        : '要素顺序与必填性以单一窗口为准；CAS/GTIN 为通用要素',
    },
  });
});

export default router;
