/**
 * C-0013-B — quarantine（无法归一化的记录）
 * ---------------------------------------------------------------
 * 字段白名单（MSG-20260928-128 / -138）：
 *   { connectorId, platformType, normalizerVersion, reasonCode, inputFingerprint, occurredAt }
 * 禁止：rawPayload / accessToken / customerData，以及任何业务判断词
 * （AMOUNT_TOO_SMALL / NOT_RECOVERABLE / LOW_VALUE —— 那是 Rule Engine 的事）。
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { QUARANTINE_REASON_CODES, type QuarantineReasonCode } from './types';

export interface QuarantineEntry {
  connectorId: string;
  platformType: string;
  normalizerVersion: string;
  reasonCode: QuarantineReasonCode;
  inputFingerprint: string;
  occurredAt: string;
}

export const QUARANTINE_ALLOWED_KEYS = [
  'connectorId',
  'platformType',
  'normalizerVersion',
  'reasonCode',
  'inputFingerprint',
  'occurredAt',
] as const;

const FORBIDDEN_KEYS = ['rawPayload', 'payload', 'accessToken', 'token', 'customerData', 'email', 'phone'];

/** 输入指纹：只证明「同一输入被隔离过」，不含 payload。 */
export function inputFingerprintOf(connectorId: string, resourceRef: string): string {
  return createHash('sha256').update(`${connectorId}|${resourceRef}`, 'utf8').digest('hex');
}

export function assertQuarantineEntry(entry: QuarantineEntry): void {
  const keys = Object.keys(entry);
  for (const key of keys) {
    if (!(QUARANTINE_ALLOWED_KEYS as readonly string[]).includes(key)) {
      throw new Error(`quarantine 出现白名单外字段：${key}`);
    }
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new Error(`quarantine 禁止字段：${key}`);
    }
  }
  if (!(QUARANTINE_REASON_CODES as readonly string[]).includes(entry.reasonCode)) {
    throw new Error(`quarantine 原因码不在白名单：${entry.reasonCode}`);
  }
}

export interface QuarantineSink {
  write(entry: QuarantineEntry): Promise<void>;
}

/** 落文件：每行一条 JSON（jsonl），便于人工复核与后续统计。 */
export class JsonlQuarantineSink implements QuarantineSink {
  constructor(
    private readonly dir: string,
    private readonly runId: string,
  ) {}

  async write(entry: QuarantineEntry): Promise<void> {
    assertQuarantineEntry(entry);
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(path.join(this.dir, `${this.runId}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

/** 测试/一次性运行用：只收集到内存，不落盘。 */
export class InMemoryQuarantineSink implements QuarantineSink {
  readonly entries: QuarantineEntry[] = [];

  async write(entry: QuarantineEntry): Promise<void> {
    assertQuarantineEntry(entry);
    this.entries.push(entry);
  }
}
