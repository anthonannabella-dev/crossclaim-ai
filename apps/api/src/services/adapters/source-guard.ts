/**
 * 平台来源载荷边界校验（C-0003 Checkpoint 2 · CHANGE #30 / #33）
 * ---------------------------------------------------------------
 * `AdapterRecord.source` 会被写进 `SourceTransaction.raw`（长期证据），因此它必须是
 * **严格 JSON-safe value**：校验通过 == Prisma 一定能原样保存，不做隐式转换。
 *
 * 只允许：null / string / finite number / boolean / array / plain object。
 * 一律拒绝：Date、BigInt、function、Symbol、Map、Set、custom class、循环引用，
 *          以及对象属性值为 undefined（JSON 会丢字段，落库内容会与校验内容不一致）。
 * 另外：疑似凭据键名直接拒绝；单条序列化后不得超过 256 KiB。
 *
 * 平台 HTTP API 的原始 JSON 本来就只有字符串日期，因此 source 不需要 Date 支持。
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
  return (
    CREDENTIAL_KEYS.includes(normalized) ||
    normalized.endsWith('token') ||
    normalized.endsWith('secret')
  );
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

export interface SourceGuardContext {
  platform: string;
  /** 1-based 记录序号，仅用于报错定位 */
  rowNumber?: number;
}

/**
 * 校验单条平台载荷；不安全直接抛 AdapterSourceError（调用方不要捕获后继续落库）。
 * 仅**顶层** `undefined` 视为"未提供载荷"放行；对象 / 数组内部的 undefined 一律拒绝。
 */
export function assertSafeSource(source: unknown, context: SourceGuardContext): void {
  if (source === undefined) return;
  const where = `适配器 ${context.platform} 第 ${context.rowNumber ?? '-'} 条`;
  const seen = new Set<object>();

  const walk = (value: unknown, path: string, depth: number, allowUndefined: boolean): void => {
    if (value === undefined) {
      if (allowUndefined) return;
      throw new AdapterSourceError(`${where} 的 source 含 undefined（JSON 会丢字段）：${path}`);
    }
    if (depth > MAX_DEPTH) {
      throw new AdapterSourceError(`${where} 的 source 嵌套过深（> ${MAX_DEPTH}）：${path}`);
    }
    if (value === null) return;

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
        throw new AdapterSourceError(`${where} 的 source 含 BigInt，不是 JSON-safe：${path}`);
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
        if (Array.isArray(value)) {
          value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1, false));
        } else if (!isPlainObject(object)) {
          const typeName = (object as { constructor?: { name?: string } }).constructor?.name;
          throw new AdapterSourceError(
            `${where} 的 source 含非纯 JSON 对象（${typeName ?? 'non-plain object'}）：${path}；` +
              'Date / Map / Set / class 实例一律拒绝',
          );
        } else {
          for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (isCredentialKey(key)) {
              throw new AdapterSourceError(
                `${where} 的 source 含疑似凭据字段 "${key}"：拒绝入库（凭据只允许以引用名出现）`,
              );
            }
            walk(item, `${path}.${key}`, depth + 1, false);
          }
        }
        seen.delete(object);
        return;
      }
      default:
        throw new AdapterSourceError(`${where} 的 source 含不可序列化类型 ${typeof value}：${path}`);
    }
  };

  walk(source, '$', 0, true);

  // 到这里内容已是纯 JSON 类型；再做一次序列化验证 + 体积上限
  const serialized = JSON.stringify(source) ?? '';
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_SOURCE_BYTES) {
    throw new AdapterSourceError(
      `${where} 的 source 序列化后 ${bytes} 字节，超过单条上限 ${MAX_SOURCE_BYTES} 字节；` +
        '大体积原始数据应作为 FileAsset（文件资产）存储，不允许塞进 JSON 行',
    );
  }
}
