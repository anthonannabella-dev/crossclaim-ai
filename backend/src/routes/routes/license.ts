import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import {
  listLicenses, createLicense, updateLicense, deleteLicense, licenseAlerts,
} from '../../services/licenseService';

const router = Router();
router.use(authenticate);

// 列表（?q= 模糊搜证件号/类型/持证方）
router.get('/', requireActiveTenant, async (req, res) => {
  try {
    const data = await listLicenses(req.tenant!.tenantId, { q: req.query.q as string });
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 到期预警（?days=30）
router.get('/alerts', requireActiveTenant, async (req, res) => {
  try {
    const days = req.query.days ? Math.max(1, parseInt(req.query.days as string)) : 30;
    const data = await licenseAlerts(req.tenant!.tenantId, days);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 新建
router.post('/', requireActiveTenant, async (req, res) => {
  try {
    const data = await createLicense(req.tenant!.tenantId, req.body);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 更新
router.patch('/:id', requireActiveTenant, async (req, res) => {
  try {
    const data = await updateLicense(req.tenant!.tenantId, String(req.params.id), req.body);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 删除
router.delete('/:id', requireActiveTenant, async (req, res) => {
  try {
    const data = await deleteLicense(req.tenant!.tenantId, String(req.params.id));
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
