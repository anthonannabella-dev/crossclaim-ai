/** SEO-3 单元验收：公开只读 Checker/Calculator（匿名 / 无 PII / 无外写 / estimate-only）+ 限流。 */

import { describe, expect, it } from 'vitest';

import {
  containsPersonalData,
  runPublicSeoChecker,
  SEO_PUBLIC_TOOL_BOUNDARY,
  validatePublicSeoRequest,
  type SeoPublicCheckerPorts,
} from '../services/seo/seo-public-checker';
import {
  createInMemorySeoPublicRateLimiter,
  hashAnonymousKey,
  SEO_PUBLIC_RATE_LIMIT_BOUNDARY,
} from '../services/seo/seo-rate-limit';
import type { RecoveryRuleDefinition } from '../services/recovery-rules/recovery-rule-definition';

const NOW = new Date('2026-10-04T06:00:00.000Z');

const rule = (overrides: Partial<RecoveryRuleDefinition> = {}): RecoveryRuleDefinition => ({
  definitionVersion: 'v1',
  platform: 'CUSTOMS',
  category: 'customs',
  recoveryType: 'drawback',
  jurisdictionScope: 'COUNTRY',
  jurisdictionCodes: ['US'],
  region: null,
  title: 'US Customs drawback recovery',
  slug: 'us-customs-drawback',
  problemDescription: 'Duty paid on re-exported goods may be recoverable.',
  eligibility: {
    requiresIorIdentity: true,
    requiresAuthorizedSigner: false,
    requiresBrokerPoa: true,
    requiresFilingAuthorization: true,
    minimumEvidenceCount: 2,
  },
  eligibilityMethod: { kind: 'DECISION_TABLE', basisKey: 'engine:customs-drawback-eligibility' },
  requiredEvidence: ['evidence:entry-summary', 'evidence:export-proof'],
  calculationMethod: { kind: 'DUTY_DIFFERENCE', basisKey: 'engine:customs-duty-difference' },
  filingDeadline: { kind: 'STATUTORY', days: 90, sourceReferenceId: 'src:cfr-1900' },
  submissionMode: 'BROKER_FILED',
  feeModel: 'SUCCESS_FEE',
  supportedMode: 'ASSISTED',
  relatedRuleRefs: ['rule:customs-protest'],
  sourceReferences: [{ id: 'src:cfr-1900', label: '19 CFR 190' }],
  capabilities: { checker: true, calculator: true },
  ctaMode: 'FREE_AUDIT_THEN_START',
  ruleVersion: '2026.10.1',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  ...overrides,
});

const ports = (overrides: Partial<SeoPublicCheckerPorts> = {}): SeoPublicCheckerPorts => ({
  resolveActiveRule: async ({ slug }) => (slug === 'us-customs-drawback' ? rule() : null),
  listRegisteredBasisKeys: async () => ['engine:customs-drawback-eligibility', 'engine:customs-duty-difference'],
  getPublicInputSchema: async () => ({
    fields: { reexported: { kind: 'boolean' } },
    allowEmpty: true,
  }),
  runEligibility: async () => ({ eligible: true, reasonCodes: [] }),
  runCalculation: async ({ basisKey }) => ({
    estimate: { min: 1000, max: 2500, currency: 'USD' },
    basisKey,
    disclaimerKey: 'seo.disclaimer.estimateOnly',
  }),
  now: () => NOW,
  ...overrides,
});

describe('SEO-3 — public read-only checker/calculator', () => {
  it('匿名合法请求：返回资格结论与 ESTIMATE_ONLY 估算，且零副作用', async () => {
    const result = await runPublicSeoChecker({ slug: 'us-customs-drawback', answers: { reexported: true } }, ports());
    expect(result.ok).toBe(true);
    expect(result.code).toBe('CHECKER_RESULT');
    expect(result.ruleVersion).toBe('2026.10.1');
    expect(result.eligible).toBe(true);
    expect(result.estimate).toEqual({ min: 1000, max: 2500, currency: 'USD' });
    expect(result.estimateLabel).toBe('ESTIMATE_ONLY');
    expect(result.disclaimerKey).toBe('seo.disclaimer.estimateOnly');
    expect(result.externalWritePerformed).toBe(false);
    expect(result.tenantDataIncluded).toBe(false);
    expect(result.submissionCreated).toBe(false);
    expect(result.chargingPerformed).toBe(false);
    expect(result.productionCredentials).toBe('ABSENT');
  });

  it('PII 一律拒绝：邮箱 / 电话 / EIN-like / 长数字串 / 裸 URL', () => {
    expect(containsPersonalData('buyer@example.com')).toBe(true);
    expect(containsPersonalData('+1 (415) 555-0132')).toBe(true);
    expect(containsPersonalData('12-3456789')).toBe(true);
    expect(containsPersonalData('12345678')).toBe(true);
    expect(containsPersonalData('https://example.com/entry')).toBe(true);
    expect(containsPersonalData('re-exported')).toBe(false);

    for (const value of ['a@b.com', '+1 415 555 0132', '12-3456789', 'https://x/y']) {
      const validation = validatePublicSeoRequest({ slug: 'us-customs-drawback', answers: { note: value } });
      expect(validation.ok).toBe(false);
      if (validation.ok) return;
      expect(validation.code).toBe('PII_REJECTED');
    }
  });

  it('输入白名单：非法 slug / 非法键 / 过长字符串 / 换行 / 答案过多一律 INVALID_REQUEST', () => {
    expect(validatePublicSeoRequest({ slug: 'BAD SLUG' })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(validatePublicSeoRequest({ slug: 'us-customs-drawback', answers: { 'Bad-Key': 'x' } })).toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
    });
    expect(
      validatePublicSeoRequest({ slug: 'us-customs-drawback', answers: { note: 'x'.repeat(121) } }),
    ).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(
      validatePublicSeoRequest({ slug: 'us-customs-drawback', answers: { note: 'line1\nline2' } }),
    ).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    const tooMany = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, 1]));
    expect(validatePublicSeoRequest({ slug: 'us-customs-drawback', answers: tooMany })).toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
    });
  });

  it('规则不存在 / 已失效：SLUG_NOT_FOUND / RULE_NOT_EFFECTIVE（不发明结论）', async () => {
    const missing = await runPublicSeoChecker({ slug: 'no-such-rule' }, ports());
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('SLUG_NOT_FOUND');

    const expired = await runPublicSeoChecker(
      { slug: 'us-customs-drawback' },
      ports({
        resolveActiveRule: async () =>
          rule({ effectiveFrom: '2025-01-01T00:00:00.000Z', effectiveTo: '2025-12-31T00:00:00.000Z' }),
      }),
    );
    expect(expired.ok).toBe(false);
    expect(expired.code).toBe('RULE_NOT_EFFECTIVE');
  });

  it('引擎未注册 → NO_RECOVERY_CAPABILITY；无 checker/calculator 能力 → CHECKER_NOT_AVAILABLE', async () => {
    const unregistered = await runPublicSeoChecker(
      { slug: 'us-customs-drawback' },
      ports({ listRegisteredBasisKeys: async () => [] }),
    );
    expect(unregistered.ok).toBe(false);
    expect(unregistered.code).toBe('NO_RECOVERY_CAPABILITY');

    const noCapability = await runPublicSeoChecker(
      { slug: 'us-customs-drawback' },
      ports({
        resolveActiveRule: async () =>
          rule({
            capabilities: { checker: false, calculator: false },
            calculationMethod: { kind: 'NONE', basisKey: '' },
          }),
      }),
    );
    expect(noCapability.ok).toBe(false);
    expect(noCapability.code).toBe('CHECKER_NOT_AVAILABLE');
  });

  it('资格不符时不调用 Calculator：estimate 保持 null（不给出误导金额）', async () => {
    let calculationCalled = false;
    const result = await runPublicSeoChecker(
      { slug: 'us-customs-drawback' },
      ports({
        runEligibility: async () => ({ eligible: false, reasonCodes: ['NO_IOR_IDENTITY'] }),
        runCalculation: async () => {
          calculationCalled = true;
          return { estimate: { min: 1, max: 2, currency: 'USD' }, basisKey: 'x', disclaimerKey: 'y' };
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.eligible).toBe(false);
    expect(result.reasonCodes).toEqual(['NO_IOR_IDENTITY']);
    expect(result.estimate).toBeNull();
    expect(result.estimateLabel).toBeNull();
    expect(calculationCalled).toBe(false);
  });

  it('限流：桶容量用尽后拒绝并给出 retryAfter；补充令牌后恢复', () => {
    let clock = NOW.getTime();
    const limiter = createInMemorySeoPublicRateLimiter({
      capacity: 2,
      refillPerMinute: 60,
      now: () => new Date(clock),
    });
    const key = hashAnonymousKey('203.0.113.7', 'salt-1');

    expect(limiter.check(key)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check(key)).toMatchObject({ allowed: true, remaining: 0 });
    const denied = limiter.check(key);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    clock += 2000; // 60/min → 2 秒补充 2 个令牌（上限 2）
    expect(limiter.check(key).allowed).toBe(true);
  });

  it('匿名键只保存哈希：同输入同盐稳定、换盐不同、且不含原始值', () => {
    const a = hashAnonymousKey('203.0.113.7', 'salt-1');
    const b = hashAnonymousKey('203.0.113.7', 'salt-1');
    const c = hashAnonymousKey('203.0.113.7', 'salt-2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a.includes('203.0.113.7')).toBe(false);
    expect(SEO_PUBLIC_RATE_LIMIT_BOUNDARY.rawIdentifierStored).toBe(false);
  });

  it('边界自证：公开工具匿名只读、无库写、无 submission、不扣费、不绕 Action Guard', () => {
    expect(SEO_PUBLIC_TOOL_BOUNDARY).toEqual({
      anonymousOnly: true,
      externalWritePerformed: false,
      databaseWritePerformed: false,
      submissionCreated: false,
      chargingPerformed: false,
      tenantDataIncluded: false,
      piiAccepted: false,
      estimateLabelRequired: true,
      productionCredentials: 'ABSENT',
      actionGuardBypassed: false,
    });
  });

  it('engine 输出校验：非法 eligibility 输出 → ENGINE_OUTPUT_INVALID（fail-closed）', async () => {
    const bad = await runPublicSeoChecker(
      { slug: 'us-customs-drawback' },
      ports({
        runEligibility: async () => ({ eligible: 'yes' as never, reasonCodes: [] }),
      }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('ENGINE_OUTPUT_INVALID');

    const badReasonCodes = await runPublicSeoChecker(
      { slug: 'us-customs-drawback' },
      ports({
        runEligibility: async () => ({ eligible: true, reasonCodes: ['ok', 'x'.repeat(200)] }),
      }),
    );
    expect(badReasonCodes.code).toBe('ENGINE_OUTPUT_INVALID');
  });

  it('engine 输出校验：非法 estimate（NaN / min<0 / max<min / 坏货币）→ ENGINE_OUTPUT_INVALID', async () => {
    const cases = [
      { min: Number.NaN, max: 10, currency: 'USD' },
      { min: -1, max: 10, currency: 'USD' },
      { min: 10, max: 5, currency: 'USD' },
      { min: 1, max: 10, currency: 'US' },
    ];
    for (const estimate of cases) {
      const result = await runPublicSeoChecker(
        { slug: 'us-customs-drawback' },
        ports({
          runCalculation: async ({ basisKey }) => ({
            estimate,
            basisKey,
            disclaimerKey: 'seo.disclaimer.estimateOnly',
          }),
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('ENGINE_OUTPUT_INVALID');
    }
  });

  it('CHANGE A 接线：未知 answer key 在调用引擎前就被拒（引擎不会被调用）', async () => {
    let eligibilityCalled = false;
    const result = await runPublicSeoChecker(
      { slug: 'us-customs-drawback', answers: { reexported: true, phone: 'x' } },
      ports({
        runEligibility: async () => {
          eligibilityCalled = true;
          return { eligible: true, reasonCodes: [] };
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_REQUEST');
    expect(eligibilityCalled).toBe(false);
  });

  it('CHANGE A 接线：basisKey 未注册 public schema → NO_RECOVERY_CAPABILITY', async () => {
    const result = await runPublicSeoChecker(
      { slug: 'us-customs-drawback', answers: { reexported: true } },
      ports({ getPublicInputSchema: async () => null }),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_RECOVERY_CAPABILITY');
  });
});
