/**
 * 环境变量读取与校验（零依赖，fail fast）
 * ---------------------------------------------------------------
 * 原则：
 *   - 缺失的**必需**变量要在启动时立刻报错，并一次列全，不要一个个撞
 *   - 密钥类变量只接受"引用名"或真实值，但**从不打印值**
 *   - 提供 defaults 的变量在缺失时给出默认并（可选）记警告
 */

export interface EnvSpec {
  name: string;
  required: boolean;
  defaultValue?: string;
  /** 说明用途，出错时展示 */
  description: string;
}

export const ENV_SPECS: EnvSpec[] = [
  { name: 'DATABASE_URL', required: true, description: 'PostgreSQL 连接串' },
  { name: 'NODE_ENV', required: false, defaultValue: 'development', description: '运行环境' },
  { name: 'PORT', required: false, defaultValue: '3000', description: 'HTTP 端口' },
  { name: 'LOG_LEVEL', required: false, defaultValue: 'info', description: 'debug|info|warn|error' },
  { name: 'TEMPORAL_ADDRESS', required: false, defaultValue: 'localhost:7233', description: 'Temporal 地址' },
  { name: 'AI_SERVICE_URL', required: false, defaultValue: 'http://localhost:8003', description: 'AI 服务地址' },
  { name: 'S3_ENDPOINT', required: false, defaultValue: '', description: '对象存储端点' },
  { name: 'S3_BUCKET', required: false, defaultValue: '', description: '对象存储桶' },
  { name: 'S3_REGION', required: false, defaultValue: 'us-east-1', description: '对象存储区域' },
  { name: 'S3_ACCESS_KEY_REF', required: false, description: '对象存储 accessKey 的**引用名**（不是取值）' },
  { name: 'S3_SECRET_KEY_REF', required: false, description: '对象存储 secretKey 的**引用名**（不是取值）' },
  { name: 'STORAGE_DRIVER', required: false, defaultValue: 'local', description: '存储驱动：local|s3' },
  { name: 'STORAGE_LOCAL_ROOT', required: false, defaultValue: './.storage', description: 'local 驱动的对象根目录' },
  { name: 'STORAGE_PUBLIC_BASE_URL', required: false, defaultValue: 'http://localhost:3000', description: '签名下载地址的对外基址' },
  { name: 'STORAGE_URL_SECRET', required: false, description: '签名下载令牌密钥（真实值放密钥管理，不写进仓库）' },
  { name: 'STORAGE_TOKEN_KEY', required: false, description: '下载令牌加密专用密钥（可选；未配置则由 STORAGE_URL_SECRET 派生）' },
  { name: 'STORAGE_SIGNED_URL_TTL_SECONDS', required: false, defaultValue: '300', description: '签名下载地址默认有效期（秒）' },
  { name: 'AUDIT_IP_SALT', required: false, description: '审计 IP 哈希盐值（真实值放密钥管理；未配置时本地开发回退用 STORAGE_URL_SECRET）' },
  { name: 'METRICS_ENABLED', required: false, defaultValue: 'false', description: '是否暴露 GET /metrics（Prometheus 文本）；默认 false' },
];

export class EnvError extends Error {
  constructor(public readonly missing: string[]) {
    super(
      '缺少必需环境变量: ' + missing.join(', ') + '。' +
        '请参考 apps/api/.env.example 配置后重试。',
    );
    this.name = 'EnvError';
  }
}

/**
 * 从给定来源加载配置。
 * @param source 默认 process.env；测试可注入
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];

  for (const spec of ENV_SPECS) {
    const raw = source[spec.name];
    const value = raw === undefined || raw === '' ? spec.defaultValue : raw;

    if (value === undefined || value === '') {
      if (spec.required) missing.push(spec.name);
      continue;
    }
    out[spec.name] = value;
  }

  if (missing.length > 0) throw new EnvError(missing);
  return out;
}

/** 供健康检查/诊断使用：只报告"是否已设置"，不回显值 */
export function envPresence(source: Record<string, string | undefined> = process.env): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const spec of ENV_SPECS) {
    out[spec.name] = Boolean(source[spec.name]);
  }
  return out;
}
