import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../config/logger';

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (transporter) return transporter;
  const config = env();
  if (!config.SMTP_HOST) {
    logger.warn('[Email] SMTP not configured, emails will be logged only');
    return null;
  }
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: {
      user: config.SMTP_USER || '',
      pass: config.SMTP_PASS || '',
    },
  });
  return transporter;
}

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const config = env();
  const transport = getTransporter();

  if (!transport) {
    logger.info(`[Email] Would send to ${to}: "${subject}"`);
    logger.info(`[Email] Body: ${html.substring(0, 200)}...`);
    return true; // pretend success in dev mode
  }

  try {
    await transport.sendMail({
      from: config.SMTP_FROM,
      to,
      subject,
      html,
    });
    logger.info(`[Email] Sent "${subject}" to ${to}`);
    return true;
  } catch (err: any) {
    logger.error(`[Email] Failed to send to ${to}: ${err.message}`);
    return false;
  }
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<boolean> {
  const host = env().PUBLIC_HOST;
  const resetUrl = `https://${host}/reset-password?token=${token}`;
  return sendEmail(
    email,
    '密码重置 - 出口报关合规AI SaaS',
    `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>密码重置</h2>
      <p>您请求了密码重置，点击下方链接设置新密码：</p>
      <a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background: #1677ff; color: #fff; text-decoration: none; border-radius: 6px;">
        重置密码
      </a>
      <p style="color: #999; margin-top: 24px;">此链接30分钟内有效。如非您本人操作，请忽略此邮件。</p>
      <p style="color: #999;">链接: ${resetUrl}</p>
    </div>
    `
  );
}

export async function sendVerificationEmail(email: string, token: string): Promise<boolean> {
  const host = env().PUBLIC_HOST;
  const verifyUrl = `https://${host}/verify-email?token=${token}`;
  return sendEmail(
    email,
    '请验证您的企业邮箱 - 出口报关合规AI SaaS',
    `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>邮箱验证</h2>
      <p>感谢注册！请点击下方链接验证您的企业邮箱：</p>
      <a href="${verifyUrl}" style="display: inline-block; padding: 12px 24px; background: #1677ff; color: #fff; text-decoration: none; border-radius: 6px;">
        验证邮箱
      </a>
      <p style="color: #999; margin-top: 24px;">此链接24小时内有效。</p>
      <p style="color: #999;">链接: ${verifyUrl}</p>
    </div>
    `
  );
}

export async function sendTrialExpiringEmail(email: string, companyName: string, daysLeft: number): Promise<boolean> {
  return sendEmail(
    email,
    `您的试用期即将在${daysLeft}天后结束 - 出口报关合规AI SaaS`,
    `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>试用期即将到期</h2>
      <p>${companyName}，您好！</p>
      <p>您的7天全功能试用将在 <strong>${daysLeft} 天</strong>后结束，届时部分功能将受限。</p>
      <p>如需继续使用全部功能，请升级为企业版套餐。</p>
      <a href="https://${env().PUBLIC_HOST}/settings/billing" style="display: inline-block; padding: 12px 24px; background: #1677ff; color: #fff; text-decoration: none; border-radius: 6px;">
        查看套餐
      </a>
    </div>
    `
  );
}
