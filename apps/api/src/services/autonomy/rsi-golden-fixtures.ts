/**
 * RSI GoldenFixture 语料契约（RSI-INSP-04，纯函数，零 IO）
 * ---------------------------------------------------------------
 * 目的：把关键历史案例与已验证输入输出固化为**永久 regression 资产**，让同类问题不再复发。
 * 依据 OWNER《Continuous Inspection》第 5 节：覆盖 Amazon/TikTok/Walmart settlement、Shopify、
 * carrier invoices、POD evidence、recovery opportunity、claim package、Customs matching/eligibility、
 * authorization、payment/fee guard boundaries。
 *
 * 硬规则：
 *   · 生产来源 fixture **必须已脱敏**（sanitized=true），否则拒收；
 *   · 不得包含客户数据/PII/凭据字段（按键名拒收）；
 *   · 每个 fixture 必须声明 digest（64 hex）与至少一条不可破坏的不变量；
 *   · 覆盖报告用于 Weekly Review 的能力缺口判定（缺域 = capability gap）。
 */

export const RSI_GOLDEN_FIXTURE_DOMAINS = [
  'AMAZON_SETTLEMENT',
  'TIKTOK_SETTLEMENT',
  'WALMART_SETTLEMENT',
  'SHOPIFY',
  'CARRIER_INVOICE',
  'POD_EVIDENCE',
  'RECOVERY_OPPORTUNITY',
  'CLAIM_PACKAGE',
  'CUSTOMS_MATCHING',
  'CUSTOMS_ELIGIBILITY',
  'AUTHORIZATION',
  'PAYMENT_FEE_GUARD',
] as const;
export type RsiGoldenFixtureDomain = (typeof RSI_GOLDEN_FIXTURE_DOMAINS)[number];

export interface RsiGoldenFixture {
  fixtureId: string;
  domain: RsiGoldenFixtureDomain;
  sourceKind: 'SYNTHETIC' | 'PRODUCTION_SANITIZED';
  /** 生产来源必须为 true，否则拒收。 */
  sanitized: boolean;
  inputDigest: string;
  expectedDigest: string;
  /** 至少一条不可破坏的不变量（例如 no_external_write、viewer_cannot_submit）。 */
  invariants: readonly string[];
  recordedAt: string;
}

export const RSI_GOLDEN_REJECTION_REASONS = [
  'UNKNOWN_DOMAIN',
  'UNSANITIZED_PRODUCTION_SOURCE',
  'INVALID_DIGEST',
  'NO_INVARIANTS',
  'FORBIDDEN_FIELD',
] as const;
export type RsiGoldenRejectionReason = (typeof RSI_GOLDEN_REJECTION_REASONS)[number];

export type RsiGoldenValidation =
  | { ok: true }
  | { ok: false; reasons: readonly RsiGoldenRejectionReason[] };

const DIGEST_RE = /^[0-9a-f]{64}$/;
const FORBIDDEN_KEYS = /^(api_?key|api_?secret|secret|credential|credentials|password|access_?token|refresh_?token|customer_?name|email|phone|ssn|account_?number)$/i;

const hasForbiddenField = (value: unknown, depth = 0): boolean => {
  if (depth > 4 || value === null || typeof value !== 'object') return false;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.test(key)) return true;
    if (hasForbiddenField(nested, depth + 1)) return true;
  }
  return false;
};

export function validateGoldenFixture(fixture: RsiGoldenFixture): RsiGoldenValidation {
  const reasons: RsiGoldenRejectionReason[] = [];
  if (!(RSI_GOLDEN_FIXTURE_DOMAINS as readonly string[]).includes(fixture.domain)) reasons.push('UNKNOWN_DOMAIN');
  if (fixture.sourceKind === 'PRODUCTION_SANITIZED' && fixture.sanitized !== true) {
    reasons.push('UNSANITIZED_PRODUCTION_SOURCE');
  }
  if (!DIGEST_RE.test(fixture.inputDigest) || !DIGEST_RE.test(fixture.expectedDigest)) reasons.push('INVALID_DIGEST');
  if ((fixture.invariants ?? []).length === 0) reasons.push('NO_INVARIANTS');
  if (hasForbiddenField(fixture)) reasons.push('FORBIDDEN_FIELD');
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export interface RsiGoldenCoverageReport {
  covered: readonly RsiGoldenFixtureDomain[];
  missing: readonly RsiGoldenFixtureDomain[];
  /** 缺域即 capability gap（Weekly Review 据此产 Incident）。 */
  capabilityGap: boolean;
  /** 被拒收的 fixture（必须显式上报，不静默丢弃）。 */
  rejected: readonly { fixtureId: string; reasons: readonly RsiGoldenRejectionReason[] }[];
}

export function goldenCoverageReport(fixtures: readonly RsiGoldenFixture[]): RsiGoldenCoverageReport {
  const accepted: RsiGoldenFixture[] = [];
  const rejected: { fixtureId: string; reasons: readonly RsiGoldenRejectionReason[] }[] = [];
  for (const fixture of fixtures) {
    const validation = validateGoldenFixture(fixture);
    if (validation.ok) accepted.push(fixture);
    else rejected.push({ fixtureId: fixture.fixtureId, reasons: validation.reasons });
  }

  const coveredSet = new Set(accepted.map((fixture) => fixture.domain));
  const covered = RSI_GOLDEN_FIXTURE_DOMAINS.filter((domain) => coveredSet.has(domain));
  const missing = RSI_GOLDEN_FIXTURE_DOMAINS.filter((domain) => !coveredSet.has(domain));
  return {
    covered,
    missing,
    capabilityGap: missing.length > 0,
    rejected,
  };
}

export const RSI_GOLDEN_FIXTURE_BOUNDARY = {
  requiresSanitizedProductionSources: true,
  rejectsForbiddenFields: true,
  silentlyDropsRejectedFixtures: false,
  writesDatabase: false,
  performsExternalWrite: false,
} as const;
