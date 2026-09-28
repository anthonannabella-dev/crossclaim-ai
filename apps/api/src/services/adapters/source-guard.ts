/**
 * 平台来源载荷边界校验（C-0003 Checkpoint 2 Round 1 / CHANGE #30）
 * ---------------------------------------------------------------
 * `AdapterRecord.source` 会被写进 `SourceTransaction.raw`（长期证据），因此必须在入库前
 * 强制而不是"文档约定"：
 *   1. 必须能安全 JSON 序列化（拒绝 BigInt / function / Symbol / 循环引用 / 非有限数字）
 *   2. 疑似凭据字段一律拒绝（authorization / token / cookie / apiKey / password …）
 *   3. 单条大小上限 256 KiB；超过不截断、直接失败（大体积原始数据应进 FileAsset）
 */

import { AdapterSourceError } from './types';

/** 单条 source 的字节上限（UTF-8 序列化后） */
export const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_DEPTH = 12;

/**
 * 疑似凭据键名（比较前统一小写并去掉 `_` `-`）：
 * 命中即拒绝入库，不做静默脱敏（避免"证据里少了字段却没人知道"）。
 */
const CREDENTIAL_KEYS = [
  'authorization',
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'idtoken',
  'apikey',
  'api',
  'cookie',
  'setcookie',
  'credential',
  'credentials',
  'privatekey',
  'accesskey',
  'secretkey',
  'bearer',
  'signature', 
  'auth',
];

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function isCredentialKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return CREDENTIAL_KEYS.includes(normalized) || normalized.endsWith('token') || normalized.endsWith('secret');
}

export interface SourceGuardContext {
  platform: string;
  /** 1-based 记录序号，仅用于报错定位 */
  rowNumber?: number;
}

/**
 * 校验单条平台载荷；不安全直接抛 AdapterSourceError（调用方不要捕获后继续落库）。
 * `source === undefined` 视为"未提供载荷"，放行。
 */
export function assertSafeSource(source: unknown, context: SourceGuardContext): void {
  if (source === undefined) return;
  const where = `适配器 ${context.platform} 第 ${context.rowNumber ?? '-'} 条`;
  const seen = new Set<object>();

  const walk = (value: unknown, path: string, depth: number): void => {
    if (value === undefined) return; // JSON 会丢字段，属可接受语义
    if (depth > MAX_DEPTH) {
      throw new AdapterSourceError(`${where} 的 source 嵌套过深（> ${MAX_DEPTH}）：${path}`);
    }
    switch (typeof value) {
      case 'string':
      case 'boolean':
        return;
      case 'number':
        if (!Number.isFinite(value)) {
          throw new AdapterSourceError(`${where} 的 source 含非有限数字（NaN/Infinity）：${path}`);
        }
        return;
      case 'bigint':
        throw new AdapterSourceError(`${where} 的 source 含 BigInt，无法安全 JSON 序列化：${path}`);
      case 'function':
        throw new AdapterSourceError(`${where} 的 source 含 function：${path}`);
      case 'symbol':
        throw new AdapterSourceError(`${where} 的 source 含 Symbol：${path}`);
      case 'object': {
        const object = value as object;
        if (seen.has(object)) {
          throw new AdapterSourceError(`${where} 的 source 存在循环引用：${path}`);
        }
        seen.add(object);
        if (value instanceof Date) {
          if (Number.isNaN(value.getTime())) {
            throw new AdapterSourceError(`${where} 的 source 含非法日期：${path}`);
          }
        } else if (Array.isArray(value)) {
          value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
        } else {
          for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (isCredentialKey(key)) {
              throw new AdapterSourceError(
                `${where} 的 source 含疑似凭据字段 "${key}"：拒绝入库（凭据只允许以引用名出现）`,
              );
            }
            walk(item, `${path}.${key}`, depth + 1);
          }
        }
        seen.delete(object);
        return;
      }
      default:
        throw new AdapterSourceError(`${where} 的 source 含不可序列化类型 ${typeof value}：${path}`);
    }
  };

  walk(source, '$', 0);

  let serialized: string;
  try {
    serialized = JSON.stringify(source) ?? '';
  } catch (err) {
    throw new AdapterSourceError(
      `${where} 的 source 无法 JSON 序列化：${err instanceof Error ? err.message : '未知错误'}`,
    );
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_SOURCE_BYTES) {
    throw new AdapterSourceError(
      `${where} 的 source 序列化后 ${bytes} 字节，超过单条上限 ${MAX_SOURCE_BYTES} 字节；` +
        '大体积原始数据应作为 FileAsset（文件资产）存储，不允许塞进 JSON 行',
    );
  }
}
