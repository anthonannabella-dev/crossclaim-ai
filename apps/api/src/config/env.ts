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
