/**
 * RSI 生产问题 → GoldenFixture 流水线（RSI-INSP-05，纯函数）
 * ---------------------------------------------------------------
 * 目标（OWNER《Continuous Inspection》第 5 节）：Production Failure → 脱敏 → 新 GoldenFixture →
 * 永久进入 Regression Corpus，避免同类问题复发。
 *
 * 硬规则：
 *   · 脱敏是**强制**的：深层丢弃 PII/凭据形状键 + 文本级打码，产不出合法 fixture 就拒绝（不落库）；
 *   · 产出必须通过 GoldenFixture 契约校验（digest + 不变量 + 领域）；
 *   · 归档由注入的 sink 完成（持久化依赖 Schema Delta）。
 */

import { createHash } from 'node:crypto';

import { sanitizeSignalText } from './rsi-observer';
import {
  validateGoldenFixture,
  type RsiGoldenFixture,
  type RsiGoldenFixtureDomain,
} from './rsi-golden-fixtures';

const FORBIDDEN_KEY = /^(api_?key|api_?secret|secret|credential|credentials|password|passwd|access_?token|refresh_?token|customer_?name|email|phone|ssn|account_?number)$/i;

/** 深层脱敏：丢弃禁用键，其余字符串走文本打码（邮箱/电话/长数字/token URL/本机路径）。 */
export function sanitizeFixturePayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (typeof value === 'string') return sanitizeSignalText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeFixturePayload(entry, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(key)) continue; // 直接丢弃，不写进 fixture
      out[key] = sanitizeFixturePayload(nested, depth + 1);
    }
    return out;
  }
  return value;
}

const canonical = (value: unknown): string => JSON.stringify(value ?? null);
const digestOf = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

export interface RsiFailureRecord {
  failureId: string;
  domain: RsiGoldenFixtureDomain;
  input: unknown;
  expected: unknown;
  /** 该问题暴露出的不可破坏不变量（至少一条）。 */
  invariants: readonly string[];
  observedAt: string;
}

export type RsiFixturePipelineResult =
  | { ok: true; fixture: RsiGoldenFixture; inputDigest: string; expectedDigest: string }
  | { ok: false; reason: 'INVALID_DOMAIN' | 'NO_INVARIANTS' | 'CONTRACT_REJECTED'; details?: readonly string[] };

/** 主流水线：脱敏 → 生成 fixture → 契约校验（不通过即拒绝，绝不落库）。 */
export function buildFixtureFromFailure(failure: RsiFailureRecord): RsiFixturePipelineResult {
  if (failure.invariants.length === 0) return { ok: false, reason: 'NO_INVARIANTS' };
  const sanitizedInput = sanitizeFixturePayload(failure.input);
  const sanitizedExpected = sanitizeFixturePayload(failure.expected);
  const inputDigest = digestOf(sanitizedInput);
  const expectedDigest = digestOf(sanitizedExpected);

  const fixture: RsiGoldenFixture = {
    fixtureId: `prod-${failure.failureId}`,
    domain: failure.domain,
    sourceKind: 'PRODUCTION_SANITIZED',
    sanitized: true,
    inputDigest,
    expectedDigest,
    invariants: [...failure.invariants],
    recordedAt: failure.observedAt,
  };

  const validation = validateGoldenFixture(fixture);
  if (!validation.ok) {
    const reason = validation.reasons.includes('UNKNOWN_DOMAIN') ? 'INVALID_DOMAIN' : 'CONTRACT_REJECTED';
    return { ok: false, reason, details: validation.reasons };
  }
  return { ok: true, fixture, inputDigest, expectedDigest };
}

export interface RsiFixtureSink {
  archive(fixture: RsiGoldenFixture): Promise<{ ok: boolean; archiveRef?: string }>;
}

/** 端到端：脱敏 → 契约定型 → 归档（归档失败不回滚 fixture 生成结论，但会显式上报）。 */
export async function ingestFailureAsFixture(input: {
  failure: RsiFailureRecord;
  sink: RsiFixtureSink;
}): Promise<{ ok: boolean; fixture: RsiGoldenFixture | null; archived: boolean; reason?: string }> {
  const built = buildFixtureFromFailure(input.failure);
  if (!built.ok) return { ok: false, fixture: null, archived: false, reason: built.reason };
  const archived = await input.sink.archive(built.fixture);
  return { ok: true, fixture: built.fixture, archived: archived.ok, reason: archived.ok ? undefined : 'ARCHIVE_FAILED' };
}

export const RSI_FIXTURE_PIPELINE_BOUNDARY = {
  sanitizesBeforePersisting: true,
  dropsForbiddenKeys: true,
  rejectsInsteadOfGuessing: true,
  writesDatabase: false,
  performsExternalWrite: false,
} as const;
