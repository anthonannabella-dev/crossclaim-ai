/**
 * SEO-3 CHANGE A/B — 公开工具输入的**语义白名单 + schema 驱动数值校验**
 * ---------------------------------------------------------------
 * 来源：架构方 PUBLIC API SECURITY 审计（reviewed 3066ac2）的两项必修：
 *   · CHANGE A：答案 key 不能只做格式校验；必须由 registry 按 basisKey 给出允许字段，
 *     未知 key → UNKNOWN_ANSWER_KEY（→ INVALID_REQUEST），且必须在调用引擎**之前**拒绝。
 *   · CHANGE B：数值必须按字段 schema 校验（finite / 类型 / 整数或小数 / min-max），
 *     不能用"number 直接 continue"放过，也不能用通用正则把 6 位以上数字一律当 PII。
 *
 * 本模块是纯函数 + 类型定义，不访问网络/数据库、不产生副作用。
 */

export type PublicInputField =
  | { kind: 'boolean'; required?: boolean }
  | { kind: 'integer'; min: number; max: number; required?: boolean }
  | { kind: 'number'; min: number; max: number; required?: boolean }
  | { kind: 'enum'; options: readonly string[]; required?: boolean }
  | { kind: 'token'; maxLength: number; required?: boolean };

export interface PublicInputSchema {
  fields: Record<string, PublicInputField>;
  allowEmpty?: boolean;
}

export interface PublicInputSchemaRegistry {
  /** basisKey → schema；返回 null 表示该能力不可公开（fail-closed）。 */
  getPublicInputSchema(basisKey: string): PublicInputSchema | null;
}

export type PublicAnswerValue = string | number | boolean;

export type PublicAnswerValidationCode =
  | 'UNKNOWN_ANSWER_KEY'
  | 'INVALID_ANSWER_TYPE'
  | 'ANSWER_OUT_OF_RANGE'
  | 'ANSWER_NOT_INTEGER'
  | 'ANSWER_NOT_IN_ENUM'
  | 'ANSWER_TOKEN_INVALID'
  | 'REQUIRED_ANSWER_MISSING'
  | 'SCHEMA_NOT_REGISTERED';

export interface PublicAnswerValidationResult {
  ok: boolean;
  code: PublicAnswerValidationCode | 'OK';
  /** 出错时的字段名（便于日志/诊断，不含用户数据）。 */
  field?: string;
  /** 通过校验的答案（仅含 schema 允许的字段）。 */
  answers?: Record<string, PublicAnswerValue>;
}

const TOKEN_RE = /^[A-Za-z0-9._:@#/-]{1,96}$/;
const RAW_URL_RE = /^(https?:\/\/|javascript:|data:|file:)/i;

const fail = (code: PublicAnswerValidationCode, field?: string): PublicAnswerValidationResult => ({
  ok: false,
  code,
  ...(field ? { field } : {}),
});

/**
 * 按 schema 校验匿名答案（顺序即语义：先拒未知 key，再逐字段类型/范围）。
 * 注意：字符串的 PII 扫描仍由调用方（seo-public-checker 的 containsPersonalData）负责；
 * 这里**不**对数值做 PII 正则，避免误杀合法金额。
 */
export function validatePublicAnswersAgainstSchema(input: {
  answers: Record<string, PublicAnswerValue>;
  schema: PublicInputSchema | null;
}): PublicAnswerValidationResult {
  const schema = input.schema;
  if (schema === null) return fail('SCHEMA_NOT_REGISTERED');

  const answers = input.answers ?? {};
  const keys = Object.keys(answers);

  // CHANGE A：未知 key 一律拒绝（在进入引擎之前）。
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(schema.fields, key)) return fail('UNKNOWN_ANSWER_KEY', key);
  }
  if (keys.length === 0 && schema.allowEmpty === false) return fail('REQUIRED_ANSWER_MISSING');

  const normalized: Record<string, PublicAnswerValue> = {};
  for (const [key, field] of Object.entries(schema.fields)) {
    const value = answers[key];
    if (value === undefined) {
      if (field.required) return fail('REQUIRED_ANSWER_MISSING', key);
      continue;
    }

    switch (field.kind) {
      case 'boolean':
        if (typeof value !== 'boolean') return fail('INVALID_ANSWER_TYPE', key);
        break;
      case 'integer':
        if (typeof value !== 'number' || !Number.isFinite(value)) return fail('INVALID_ANSWER_TYPE', key);
        if (!Number.isInteger(value)) return fail('ANSWER_NOT_INTEGER', key);
        if (value < field.min || value > field.max) return fail('ANSWER_OUT_OF_RANGE', key);
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) return fail('INVALID_ANSWER_TYPE', key);
        if (value < field.min || value > field.max) return fail('ANSWER_OUT_OF_RANGE', key);
        break;
      case 'enum':
        if (typeof value !== 'string' || !field.options.includes(value)) return fail('ANSWER_NOT_IN_ENUM', key);
        break;
      case 'token':
        if (
          typeof value !== 'string' ||
          value.length === 0 ||
          value.length > field.maxLength ||
          RAW_URL_RE.test(value) ||
          !TOKEN_RE.test(value)
        ) {
          return fail('ANSWER_TOKEN_INVALID', key);
        }
        break;
    }
    normalized[key] = value;
  }

  return { ok: true, code: 'OK', answers: normalized };
}

/** 边界自证：本模块纯校验，不产生副作用。 */
export const SEO_PUBLIC_INPUT_SCHEMA_BOUNDARY = {
  pureValidationOnly: true,
  externalWritePerformed: false,
  databaseWritePerformed: false,
  piiRegexAppliedToNumbers: false,
  productionCredentials: 'ABSENT',
} as const;
