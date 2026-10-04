/** SEO-3 CHANGE A/B 单元验收：语义白名单（未知 key 拒绝）+ schema 驱动数值校验。 */

import { describe, expect, it } from 'vitest';

import {
  SEO_PUBLIC_INPUT_SCHEMA_BOUNDARY,
  validatePublicAnswersAgainstSchema,
  type PublicInputSchema,
} from '../services/seo/seo-public-input-schema';

const schema: PublicInputSchema = {
  fields: {
    reexported: { kind: 'boolean', required: true },
    duty_amount: { kind: 'number', min: 0, max: 100000000 },
    days_since_import: { kind: 'integer', min: 0, max: 3650 },
    entry_type: { kind: 'enum', options: ['CONSUMPTION', 'WAREHOUSE'] },
    package_ref: { kind: 'token', maxLength: 64 },
  },
};

const run = (answers: Record<string, string | number | boolean>, s: PublicInputSchema | null = schema) =>
  validatePublicAnswersAgainstSchema({ answers, schema: s });

describe('SEO-3 CHANGE A/B — public input schema', () => {
  it('CHANGE A：格式合法但未注册的 key（phone/email/customer_name/secret）→ UNKNOWN_ANSWER_KEY', () => {
    for (const key of ['phone', 'email', 'customer_name', 'secret', 'foo']) {
      const result = run({ reexported: true, [key]: 'x' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('UNKNOWN_ANSWER_KEY');
      expect(result.field).toBe(key);
    }
  });

  it('CHANGE B：数值型 PII 不再被放过（未注册 key 先拒），且合法金额不被误杀', () => {
    expect(run({ reexported: true, phone: 14155550132 }).code).toBe('UNKNOWN_ANSWER_KEY');
    const ok = run({ reexported: true, duty_amount: 250000 });
    expect(ok.ok).toBe(true);
    expect(ok.answers?.duty_amount).toBe(250000);
  });

  it('数值校验：NaN / Infinity / 字符串冒充 / 越界 一律拒绝', () => {
    expect(run({ reexported: true, duty_amount: Number.NaN }).code).toBe('INVALID_ANSWER_TYPE');
    expect(run({ reexported: true, duty_amount: Number.POSITIVE_INFINITY }).code).toBe('INVALID_ANSWER_TYPE');
    expect(run({ reexported: true, duty_amount: '100' as never }).code).toBe('INVALID_ANSWER_TYPE');
    expect(run({ reexported: true, duty_amount: -1 }).code).toBe('ANSWER_OUT_OF_RANGE');
    expect(run({ reexported: true, duty_amount: 1e12 }).code).toBe('ANSWER_OUT_OF_RANGE');
  });

  it('整数/枚举/token 校验：小数给 integer、enum 越界、token 含 URL 或超长均拒绝', () => {
    expect(run({ reexported: true, days_since_import: 1.5 }).code).toBe('ANSWER_NOT_INTEGER');
    expect(run({ reexported: true, entry_type: 'NOPE' }).code).toBe('ANSWER_NOT_IN_ENUM');
    expect(run({ reexported: true, package_ref: 'https://x/y' }).code).toBe('ANSWER_TOKEN_INVALID');
    expect(run({ reexported: true, package_ref: 'a'.repeat(65) }).code).toBe('ANSWER_TOKEN_INVALID');
  });

  it('必填缺失 / 未知 schema（未注册能力）→ fail-closed', () => {
    expect(run({}).code).toBe('REQUIRED_ANSWER_MISSING');
    expect(run({ duty_amount: 1 }, null).code).toBe('SCHEMA_NOT_REGISTERED');
  });

  it('通过校验时只保留 schema 允许的字段', () => {
    const result = run({ reexported: true, duty_amount: 10 });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.answers ?? {})).toEqual(['reexported', 'duty_amount']);
  });

  it('边界自证：纯校验、不外写、不对数值套 PII 正则', () => {
    expect(SEO_PUBLIC_INPUT_SCHEMA_BOUNDARY).toEqual({
      pureValidationOnly: true,
      externalWritePerformed: false,
      databaseWritePerformed: false,
      piiRegexAppliedToNumbers: false,
      productionCredentials: 'ABSENT',
    });
  });
});
