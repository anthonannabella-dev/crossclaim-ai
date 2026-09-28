import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

export function encrypt(text: string, key: Buffer): { encrypted: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return { encrypted, iv: iv.toString('hex'), tag };
}

export function decrypt(encrypted: string, key: Buffer, iv: string, tag: string): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// 敏感信息脱敏
export function maskPhone(phone: string): string {
  if (phone.length < 7) return '***';
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}

export function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (name.length <= 2) return `*@${domain}`;
  return name[0] + '***' + name[name.length - 1] + '@' + domain;
}

export function maskIdCard(idCard: string): string {
  if (idCard.length < 10) return '******';
  return idCard.slice(0, 3) + '***********' + idCard.slice(-4);
}

// 哈希密码
import bcrypt from 'bcryptjs';
export const hashPassword = (pw: string) => bcrypt.hash(pw, 12);
export const comparePassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
