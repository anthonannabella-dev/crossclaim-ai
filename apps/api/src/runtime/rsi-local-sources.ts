/**
 * RSI 本地只读事件源（宿主 artifact → 事件源适配器）
 * ---------------------------------------------------------------
 * 从**本地只读 artifact** 构造事件源：CI 结果 JSON、裁决 JSON、测试结果 JSON。
 *   · 文件读取通过注入的 `readFile` 完成（默认不触发真实 IO，便于测试）；
 *   · 文件缺失 / JSON 非法 → 该源返回 undefined（**静默**，不猜结果、不抛错阻断循环）；
 *   · 只读：不写文件、不调用网络、不读凭据。
 */

import type { RsiCiOutcome, RsiVerdictOutcome } from './rsi-event-sources';
import type { RsiEventSources } from './rsi-event-loop';

export type RsiReadFile = (path: string) => Promise<string>;

export interface RsiLocalSourcePaths {
  ciResultsPath?: string;
  verdictPath?: string;
  testResultsPath?: string;
}

const safeParse = <T>(raw: string): T | undefined => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

export function parseCiResults(raw: string): readonly RsiCiOutcome[] | undefined {
  const parsed = safeParse<unknown>(raw);
  if (!Array.isArray(parsed)) return undefined;
  const outcomes: RsiCiOutcome[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.runId !== 'string' || typeof row.head !== 'string') continue;
    const status = row.status;
    if (status !== 'completed' && status !== 'in_progress' && status !== 'queued') continue;
    const conclusion = row.conclusion;
    if (conclusion !== 'success' && conclusion !== 'failure' && conclusion !== null) continue;
    outcomes.push({ runId: row.runId, head: row.head, status, conclusion });
  }
  return outcomes;
}

export function parseVerdict(raw: string): RsiVerdictOutcome | undefined {
  const parsed = safeParse<Record<string, unknown>>(raw);
  if (parsed === undefined) return undefined;
  const messageId = parsed.messageId;
  const verdict = parsed.verdict;
  if (typeof messageId !== 'string') return undefined;
  if (verdict !== 'PASS' && verdict !== 'REVISE' && verdict !== 'BLOCK') return undefined;
  return { messageId, verdict };
}

export function parseTestResults(raw: string): { fingerprint: string; passed: boolean } | undefined {
  const parsed = safeParse<Record<string, unknown>>(raw);
  if (parsed === undefined) return undefined;
  if (typeof parsed.fingerprint !== 'string' || typeof parsed.passed !== 'boolean') return undefined;
  return { fingerprint: parsed.fingerprint, passed: parsed.passed };
}

async function readOptional(
  readFile: RsiReadFile,
  path: string | undefined,
): Promise<string | undefined> {
  if (path === undefined) return undefined;
  try {
    return await readFile(path);
  } catch {
    return undefined; // 缺失即静默
  }
}

export function createLocalEventSources(input: {
  readFile: RsiReadFile;
  paths: RsiLocalSourcePaths;
}): RsiEventSources {
  const { readFile, paths } = input;
  return {
    readCi: async () => {
      const raw = await readOptional(readFile, paths.ciResultsPath);
      return raw === undefined ? undefined : parseCiResults(raw);
    },
    readVerdict: async () => {
      const raw = await readOptional(readFile, paths.verdictPath);
      return raw === undefined ? undefined : parseVerdict(raw);
    },
    readTests: async () => {
      const raw = await readOptional(readFile, paths.testResultsPath);
      return raw === undefined ? undefined : parseTestResults(raw);
    },
  };
}

export const RSI_LOCAL_SOURCES_BOUNDARY = {
  readOnly: true,
  writesFiles: false,
  performsNetworkCalls: false,
  readsCredentials: false,
  silentOnMissingArtifact: true,
} as const;
