/**
 * 结构化日志（零依赖）
 * ---------------------------------------------------------------
 * 为什么不用 winston/pino：Wave 0 追求**零新增依赖**，
 * 且结构化 JSON 日志的核心需求（级别过滤 + 敏感字段脱敏 + 机器可读）
 * 用几十行就能满足。后续若需要 transports/采样，再引入 pino（MIT）。
 *
 * 硬要求：日志**不得**带出密钥。见 REDACT_KEYS。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 命中这些键名的字段一律脱敏（大小写不敏感，子串匹配） */
const REDACT_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'credentialref',
  'privatekey',
  'accesskey',
];

const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_-]/g, '');
  return REDACT_KEYS.some((s) => k.includes(s.replace(/[_-]/g, '')));
}

/** 递归脱敏；同时处理循环引用与超深对象 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[DEPTH_LIMIT]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    // Bearer / Basic 授权头直接整体替换
    return /^(bearer|basic)\s+\S+/i.test(value) ? REDACTED : value;
  }
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** 固定附加字段（如 service 名、requestId） */
  bindings?: Record<string, unknown>;
  /** 输出目标，默认 stdout（便于收集）；测试里可注入 */
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level: LogLevel = options.level ?? 'info';
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'));

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...(redact(bindings) as Record<string, unknown>),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    sink(JSON.stringify(record));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger({ level, bindings: { ...bindings, ...extra }, sink }),
  };
}
