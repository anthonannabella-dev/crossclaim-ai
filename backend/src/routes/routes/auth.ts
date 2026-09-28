import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import prisma from '../../config/database';
import { env } from '../../config/env';
import { authenticate } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimiter';
import axios from 'axios';
import { hashPassword } from '../../utils/crypto';

const router = Router();

// ========== 企业密码登录 ==========
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const tenant = await prisma.tenant.findUnique({ where: { contactEmail: email } });
    if (!tenant) { res.status(401).json({ error: '邮箱或密码错误' }); return; }
    if (tenant.lockedUntil && tenant.lockedUntil > new Date()) {
      const m = Math.ceil((tenant.lockedUntil.getTime() - Date.now()) / 60000);
      res.status(429).json({ error: `账户已锁定，${m}分钟后重试` }); return;
    }
    const { comparePassword } = await import('../../utils/crypto');
    const valid = await comparePassword(password, tenant.passwordHash);
    if (!valid) {
      const na = tenant.failedLoginAttempts + 1;
      if (na >= 100) {
        await prisma.tenant.update({ where: { id: tenant.id }, data: { failedLoginAttempts: na, lockedUntil: new Date(Date.now() + 15 * 60 * 1000) } });
        res.status(429).json({ error: '登录失败次数过多，已锁定15分钟' }); return;
      }
      await prisma.tenant.update({ where: { id: tenant.id }, data: { failedLoginAttempts: na } });
      res.status(401).json({ error: '邮箱或密码错误' }); return;
    }
    if (tenant.status === 'DISABLED') { res.status(403).json({ error: '账号被封禁' }); return; }
    if (tenant.failedLoginAttempts > 0 || tenant.lockedUntil)
      await prisma.tenant.update({ where: { id: tenant.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    const token = jwt.sign({ id: tenant.id, tenantId: tenant.id, role: 'admin', type: 'email' }, env().JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: tenant.id, companyName: tenant.companyName, contactName: tenant.contactName, contactEmail: tenant.contactEmail } });
  } catch (err) { console.error('login:', err); res.status(500).json({ error: '登录失败' }); }
});

// ========== 企业注册 ==========
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { companyName, contactName, contactPhone, contactEmail, password, legalConsents } = req.body;
    if (!companyName || !contactName || !contactPhone || !contactEmail || !password) {
      res.status(400).json({ error: '请填写所有必填项' }); return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: '密码至少8位' }); return;
    }
    if (!Array.isArray(legalConsents) || legalConsents.length < 3) {
      res.status(400).json({ error: '请勾选同意全部法务协议' }); return;
    }
    const existing = await prisma.tenant.findUnique({ where: { contactEmail } });
    if (existing) {
      res.status(409).json({ error: '该邮箱已注册，请直接登录' }); return;
    }
    const tenant = await prisma.tenant.create({
      data: {
        companyName,
        contactName,
        contactPhone,
        contactEmail,
        passwordHash: await hashPassword(password),
        status: 'TRIAL',
        planTier: 'ENTERPRISE',
        trialEndAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        legalConsents: {
          create: legalConsents.map((type: string) => ({
            agreementType: type,
            version: '2026.06',
          })),
        },
      },
    });
    const token = jwt.sign({ tenantId: tenant.id, role: 'admin', type: 'email' }, env().JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({
      token,
      user: {
        id: tenant.id,
        companyName: tenant.companyName,
        contactName: tenant.contactName,
        contactEmail: tenant.contactEmail,
        contactPhone: tenant.contactPhone,
        status: tenant.status,
        planTier: tenant.planTier,
        trialEndAt: tenant.trialEndAt,
      },
    });
  } catch (err) {
    console.error('register:', err);
    res.status(500).json({ error: '注册失败，请稍后重试' });
  }
});

// ========== 手机验证码登录 ==========
const smsCodes = new Map<string, { code: string; expiresAt: number }>();

router.post('/sms/send', authLimiter, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) { res.status(400).json({ error: '请输入手机号' }); return; }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    smsCodes.set(phone, { code, expiresAt: Date.now() + 5 * 60 * 1000 });
    const { sendSmsCode } = await import('../../services/smsService');
    const sent = await sendSmsCode(phone, code).catch(() => false);
    const isDev = process.env.NODE_ENV !== 'production';
    res.json({ message: '验证码已发送', ...(isDev ? { debugCode: code } : {}), sent });
  } catch (err) { res.status(500).json({ error: '发送失败' }); }
});

router.post('/sms/login', authLimiter, async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) { res.status(400).json({ error: '参数不完整' }); return; }
    const record = smsCodes.get(phone);
    if (!record || record.code !== code) { res.status(401).json({ error: '验证码错误' }); return; }
    if (Date.now() > record.expiresAt) { smsCodes.delete(phone); res.status(401).json({ error: '验证码已过期' }); return; }
    smsCodes.delete(phone);
    let tenant = await prisma.tenant.findFirst({ where: { contactPhone: phone } });
    let isNewUser = false;
    if (!tenant) {
      tenant = await prisma.tenant.create({
        data: {
          companyName: `用户${phone.slice(-4)}`, contactName: '', contactPhone: phone,
          contactEmail: `${phone}@phone.local`, passwordHash: '',
          status: 'TRIAL', planTier: 'ENTERPRISE',
          trialEndAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      isNewUser = true;
    }
    const token = jwt.sign({ id: tenant.id, tenantId: tenant.id, role: 'admin', type: 'phone' }, env().JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, isNewUser, user: { id: tenant.id, companyName: tenant.companyName, contactName: tenant.contactName, contactPhone: tenant.contactPhone } });
  } catch (err) { res.status(500).json({ error: '登录失败' }); }
});

// ========== 微信扫码登录 ==========
router.get('/wechat/qr-url', async (req, res) => {
  try {
    const cfg = env();
    if (!cfg.WECHAT_APP_ID) { res.status(400).json({ error: '微信开放平台未配置' }); return; }
    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = `${process.env.BASE_URL || 'http://localhost:3000'}/api/auth/wechat/callback`;
    const qrUrl = `https://open.weixin.qq.com/connect/qrconnect?appid=${cfg.WECHAT_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`;
    res.json({ qrUrl, state });
  } catch (err) { res.status(500).json({ error: '获取二维码失败' }); }
});

router.get('/wechat/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code || typeof code !== 'string') { res.status(400).json({ error: '微信授权失败' }); return; }
    const cfg = env();
    if (!cfg.WECHAT_APP_ID) { res.status(500).json({ error: '微信未配置' }); return; }
    const tr = await axios.get('https://api.weixin.qq.com/sns/oauth2/access_token', {
      params: { appid: cfg.WECHAT_APP_ID, secret: cfg.WECHAT_APP_SECRET || '', code, grant_type: 'authorization_code' },
    });
    const td = tr.data;
    if (td.errcode) { res.status(400).json({ error: td.errmsg }); return; }
    const ur = await axios.get('https://api.weixin.qq.com/sns/userinfo', { params: { access_token: td.access_token, openid: td.openid, lang: 'zh_CN' } });
    const wx = ur.data;
    let tenant = await prisma.tenant.findFirst({ where: { OR: [{ wechatOpenId: td.openid }, ...(td.unionid ? [{ wechatUnionId: td.unionid }] : [])] } });
    let isNew = false;
    if (!tenant) {
      tenant = await prisma.tenant.create({
        data: {
          companyName: wx.nickname || `微信用户${td.openid.slice(-4)}`, contactName: wx.nickname || '',
          contactPhone: '', contactEmail: `${td.openid}@wechat.local`, passwordHash: '',
          wechatOpenId: td.openid, wechatUnionId: td.unionid || '', wechatNickname: wx.nickname || '', wechatAvatar: wx.headimgurl || '',
          status: 'TRIAL', planTier: 'ENTERPRISE', trialEndAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      isNew = true;
    }
    const jwtToken = jwt.sign({ id: tenant.id, role: 'admin', type: 'wechat' }, env().JWT_SECRET, { expiresIn: '30d' });
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:80'}/auth/callback?token=${jwtToken}&isNewUser=${isNew}`);
  } catch (err) { console.error('wx callback:', err); res.status(500).json({ error: '微信登录失败' }); }
});

// ========== 管理员登录 ==========
router.post('/admin-login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await prisma.admin.findUnique({ where: { username } });
    if (!admin) { res.status(401).json({ error: '账号或密码错误' }); return; }
    const { comparePassword } = await import('../../utils/crypto');
    if (!await comparePassword(password, admin.passwordHash)) { res.status(401).json({ error: '账号或密码错误' }); return; }
    const token = jwt.sign({ id: admin.id, role: admin.role }, env().JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, admin: { ...admin, passwordHash: undefined } });
  } catch (err) { res.status(500).json({ error: '登录失败' }); }
});

// ========== 邮箱验证 ==========
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== 'string') { res.status(400).json({ error: '无效链接' }); return; }
    const vt = await prisma.emailVerificationToken.findUnique({ where: { token } });
    if (!vt || vt.usedAt || vt.expiresAt < new Date()) { res.status(400).json({ error: '链接无效或已过期' }); return; }
    await prisma.$transaction([
      prisma.tenant.updateMany({ where: { contactEmail: vt.email }, data: { emailVerified: true } }),
      prisma.emailVerificationToken.update({ where: { id: vt.id }, data: { usedAt: new Date() } }),
    ]);
    res.json({ message: '邮箱验证成功' });
  } catch (err) { res.status(500).json({ error: '验证失败' }); }
});

router.post('/resend-verification', authenticate, async (req, res) => {
  try {
    const uid = (req as any).user?.id || (req as any).tenant?.tenantId;
    const tenant = await prisma.tenant.findUnique({ where: { id: uid } });
    if (!tenant) { res.status(404).json({ error: '账号不存在' }); return; }
    if (tenant.emailVerified) { res.json({ message: '已验证' }); return; }
    await prisma.emailVerificationToken.updateMany({ where: { email: tenant.contactEmail, usedAt: null }, data: { usedAt: new Date() } });
    const tok = crypto.randomBytes(32).toString('hex');
    await prisma.emailVerificationToken.create({ data: { email: tenant.contactEmail, token: tok, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
    const { sendVerificationEmail } = await import('../../services/emailService');
    await sendVerificationEmail(tenant.contactEmail, tok);
    res.json({ message: '已发送' });
  } catch (err) { res.status(500).json({ error: '发送失败' }); }
});

// ========== 密码重置 ==========
router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) { res.status(400).json({ error: '请输入邮箱' }); return; }
    const tenant = await prisma.tenant.findUnique({ where: { contactEmail: email } });
    if (!tenant) { res.json({ message: '如已注册，重置链接已发送' }); return; }
    await prisma.passwordResetToken.updateMany({ where: { tenantId: tenant.id, usedAt: null }, data: { usedAt: new Date() } });
    const tok = crypto.randomBytes(32).toString('hex');
    await prisma.passwordResetToken.create({ data: { tenantId: tenant.id, token: tok, expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
    const { sendPasswordResetEmail } = await import('../../services/emailService');
    await sendPasswordResetEmail(email, tok);
    res.json({ message: '如已注册，重置链接已发送' });
  } catch (err) { res.status(500).json({ error: '发送失败' }); }
});

router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword || newPassword.length < 8) { res.status(400).json({ error: '参数无效' }); return; }
    const rt = await prisma.passwordResetToken.findUnique({ where: { token } });
    if (!rt || rt.usedAt || rt.expiresAt < new Date()) { res.status(400).json({ error: '链接无效或已过期' }); return; }
    const { hashPassword } = await import('../../utils/crypto');
    await prisma.$transaction([
      prisma.tenant.update({ where: { id: rt.tenantId }, data: { passwordHash: await hashPassword(newPassword) } }),
      prisma.passwordResetToken.update({ where: { id: rt.id }, data: { usedAt: new Date() } }),
    ]);
    res.json({ message: '密码已重置' });
  } catch (err) { res.status(500).json({ error: '重置失败' }); }
});

// ========== 当前用户 ==========
router.get('/me', authenticate, async (req, res) => {
  const uid = (req as any).user?.id || (req as any).tenant?.tenantId;
  const tenant = await prisma.tenant.findUnique({ where: { id: uid } });
  if (tenant) (tenant as any).passwordHash = undefined;
  res.json(tenant);
});

export default router;
