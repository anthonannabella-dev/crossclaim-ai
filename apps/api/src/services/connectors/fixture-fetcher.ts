/**
 * C-0013-B — 测试用 FileFetcher（**只读本地 fixture，无网络、无凭据**）
 * ---------------------------------------------------------------
 * MSG-20260928-138 批准它存在，但明确验收要求：**不得演变成生产 Connector**。
 * 生产连接器必须另行设计（OAuth/凭据/限流/版本变化都在那份设计里）。
 *
 * 文件格式：每行一条 JSON（jsonl），每行必须含 `resourceRef` 与 `payload`。
 * cursor 语义：`null` = 从头开始；否则为下一条记录的偏移量（字符串化整数）。
 */

import { readFileSync, existsSync } from 'node:fs';

import type { Fetcher, FetcherPage, FetcherRecord } from './types';

export class FixtureFetcher implements Fetcher {
  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async pull(input: { resource: string; cursor: string | null; limit: number }): Promise<FetcherPage> {
    if (!existsSync(this.filePath)) return { records: [], nextCursor: null };
    const lines = readFileSync(this.filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
    const offset = input.cursor === null ? 0 : Number.parseInt(input.cursor, 10);
    if (!Number.isFinite(offset) || offset < 0 || offset > lines.length) {
      throw new Error(`fixture cursor 非法：${input.cursor}`);
    }
    const slice = lines.slice(offset, offset + Math.max(1, input.limit));
    const records: FetcherRecord[] = slice.map((line) => {
      const parsed = JSON.parse(line) as { resourceRef?: unknown; payload?: unknown };
      const fetchedAt = this.now();
      return {
        resourceRef: typeof parsed.resourceRef === 'string' ? parsed.resourceRef : '',
        payload: (parsed.payload ?? {}) as Record<string, unknown>,
        fetchedAt,
      };
    });
    const nextOffset = offset + slice.length;
    return { records, nextCursor: nextOffset >= lines.length ? null : String(nextOffset) };
  }
}
