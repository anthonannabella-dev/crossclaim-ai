import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('file:./dev.db'),
  REDIS_URL: z.string().optional().default('redis://localhost:6379'),

  // CORS / Public — 生产环境必须通过 .env 明确设置
  CORS_ORIGIN: z.string().optional().default(''),
  PUBLIC_HOST: z.string().optional().default('localhost'),

  // Auth — 无默认值，生产环境必须通过 .env 设置
  JWT_SECRET: z.string().default(''),

  // SMTP / Email
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional().default('noreply@customs-saas.com'),

  // MinIO
  MINIO_ENDPOINT: z.string().optional().default('seaweedfs'),
  MINIO_PORT: z.coerce.number().optional().default(8333),
  MINIO_ACCESS_KEY: z.string().optional().default(''),
  MINIO_SECRET_KEY: z.string().optional().default(''),

  // DeepSeek
  DEEPSEEK_API_KEY: z.string().optional(),

  // WeChat
  WECHAT_APP_ID: z.string().optional(),
  WECHAT_APP_SECRET: z.string().optional(),
  WECHAT_MCH_ID: z.string().optional(),
  WECHAT_API_KEY: z.string().optional(),
  WECHAT_API_V3_KEY: z.string().optional(),

  // Alipay
  ALIPAY_APP_ID: z.string().optional(),
  ALIPAY_PRIVATE_KEY: z.string().optional(),
  ALIPAY_PUBLIC_KEY: z.string().optional(),

  // OCR
  OCR_SERVICE_URL: z.string().optional().default('http://ocr:8002'),

  ALIYUN_OCR_ACCESS_KEY_ID: z.string().optional(),
  ALIYUN_OCR_ACCESS_KEY_SECRET: z.string().optional(),
  ALIYUN_OCR_ENDPOINT: z.string().optional(),
  ALIYUN_OCR_CONCURRENCY: z.string().optional(),
  ALIYUN_OCR_QPS: z.string().optional(),

  // 海关代码表
  // STRICT_CUSTOMS_CODES=1 时, 国别/币制/计量单位未能映射成海关代码将作为 error 阻断申报(默认 warning)
  STRICT_CUSTOMS_CODES: z.string().optional(),
  // 指向官方全量代码表 JSON(结构见 data/customs-code-tables.sample.json), 加载后覆盖/补全内置子集
  CUSTOMS_CODE_TABLE_PATH: z.string().optional(),

  // Webhooks / Bots
  FEISHU_WEBHOOK_URL: z.string().optional(),
  FEISHU_APP_SECRET: z.string().optional(),
  DINGTALK_WEBHOOK_URL: z.string().optional(),
  DINGTALK_APP_SECRET: z.string().optional(),
  WECOM_WEBHOOK_URL: z.string().optional(),

  // SMS
  ALIYUN_SMS_ACCESS_KEY: z.string().optional(),
  ALIYUN_SMS_ACCESS_SECRET: z.string().optional(),
  ALIYUN_SMS_SIGN: z.string().optional().default('报关SaaS'),
  ALIYUN_SMS_TEMPLATE: z.string().optional(),
  TENCENT_SMS_SECRET_ID: z.string().optional(),
  TENCENT_SMS_SECRET_KEY: z.string().optional(),
  TENCENT_SMS_SIGN: z.string().optional().default('报关SaaS'),
  TENCENT_SMS_TEMPLATE: z.string().optional(),
  TENCENT_SMS_APP_ID: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env;

export function loadEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
    // 安全校验：生产环境必须有 JWT_SECRET 和 CORS_ORIGIN
    if (_env.NODE_ENV === 'production') {
      if (!_env.JWT_SECRET) {
        throw new Error(
          'FATAL: JWT_SECRET is required in production. ' +
          'Generate one: openssl rand -base64 48 | tr -d "+/=" | head -c64'
        );
      }
      if (!_env.CORS_ORIGIN) {
        throw new Error(
          'FATAL: CORS_ORIGIN is required in production. ' +
          'Set it to your frontend domain (e.g., https://your-domain.com)'
        );
      }
    }
  }
  return _env;
}


export function validateEnv(): string[] {
  const e = _env;
  const warnings: string[] = [];

  // SMTP: 如果 SMTP_HOST 配置了但 SMTP_USER 为空
  if (e.SMTP_HOST && !e.SMTP_USER) {
    warnings.push('SMTP_HOST 已配置但 SMTP_USER 为空 — 邮件发送将失败');
  }
  if (e.SMTP_HOST && !e.SMTP_PASS) {
    warnings.push('SMTP_HOST 已配置但 SMTP_PASS 为空 — 邮件发送将失败');
  }

  // 通知渠道：检查配置完整性
  if (e.FEISHU_WEBHOOK_URL && !e.FEISHU_APP_SECRET) {
    warnings.push('FEISHU_WEBHOOK_URL 已配置但 FEISHU_APP_SECRET 为空');
  }
  if (e.DINGTALK_WEBHOOK_URL && !e.DINGTALK_APP_SECRET) {
    warnings.push('DINGTALK_WEBHOOK_URL 已配置但 DINGTALK_APP_SECRET 为空');
  }

  // 支付：沙箱密钥检查
  if (e.WECHAT_APP_ID && (e.WECHAT_APP_ID.includes('sandbox') || !e.WECHAT_MCH_ID)) {
    warnings.push('微信支付配置为沙箱模式 — 生产环境请替换真实商户密钥');
  }
  if (e.ALIPAY_APP_ID && (e.ALIPAY_APP_ID.includes('sandbox') || !e.ALIPAY_PRIVATE_KEY)) {
    warnings.push('支付宝配置为沙箱模式 — 生产环境请替换真实商户密钥');
  }

  // MinIO
  if (e.MINIO_ACCESS_KEY === 'admin' && e.NODE_ENV === 'production') {
    warnings.push('生产环境建议修改 MinIO 默认账号 admin');
  }

  // DeepSeek
  if (!e.DEEPSEEK_API_KEY) {
    warnings.push('DEEPSEEK_API_KEY 未配置 — AI 功能（智能归类/诊断等）将不可用');
  }

  // 短信
  if (!e.ALIYUN_SMS_ACCESS_KEY && !e.TENCENT_SMS_SECRET_ID) {
    warnings.push('未配置短信服务 — 验证码将走调试模式（打印到日志）');
  }

  return warnings;
}

export const env = () => loadEnv();
