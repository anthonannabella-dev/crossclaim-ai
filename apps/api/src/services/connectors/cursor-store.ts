/**
 * C-0013-B — 游标存储（本轮落文件；未来若要持久化再单独提 Schema Delta）
 * 载荷按 MSG-20260928-138：{ cursor, updatedAt, connectionRef, resource, cursorVersion }
 * —— connectionRef + resource + cursorVersion 三者共同防止跨资源误读。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { ConnectorContractError } from './types';

export const CURSOR_VERSION = 1;

export interface CursorRecord {
  cursor: string;
  updatedAt: string;
  connectionRef: string;
  resource: string;
  cursorVersion: number;
}

export interface CursorKey {
  connectionRef: string;
  resource: string;
}

export interface CursorStore {
  read(key: CursorKey): Promise<string | null>;
  write(key: CursorKey, cursor: string, now?: () => Date): Promise<CursorRecord>;
}

const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '_');

export class FileCursorStore implements CursorStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private fileFor(key: CursorKey): string {
    return path.join(this.rootDir, `${safe(key.connectionRef)}__${safe(key.resource)}.json`);
  }

  async read(key: CursorKey): Promise<string | null> {
    const file = this.fileFor(key);
    if (!existsSync(file)) return null;
    const record = JSON.parse(readFileSync(file, 'utf8')) as CursorRecord;
    if (
      record.connectionRef !== key.connectionRef ||
      record.resource !== key.resource ||
      record.cursorVersion !== CURSOR_VERSION
    ) {
      // 跨资源/跨版本的游标一律拒绝，避免把 amazon-orders 的游标用到 amazon-adjustments 上
      throw new ConnectorContractError(
        `游标与请求不匹配：${record.connectionRef}/${record.resource}/v${record.cursorVersion}`,
      );
    }
    return record.cursor;
  }

  async write(key: CursorKey, cursor: string, now: () => Date = () => new Date()): Promise<CursorRecord> {
    mkdirSync(this.rootDir, { recursive: true });
    const record: CursorRecord = {
      cursor,
      updatedAt: now().toISOString(),
      connectionRef: key.connectionRef,
      resource: key.resource,
      cursorVersion: CURSOR_VERSION,
    };
    writeFileSync(this.fileFor(key), JSON.stringify(record, null, 2), 'utf8');
    return record;
  }
}
