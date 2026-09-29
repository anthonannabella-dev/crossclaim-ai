/**
 * C-0015 / MSG-20260929-17 Q2 — 提交载荷构造器 + 干跑校验器（**离线**）
 * ---------------------------------------------------------------
 * 架构方裁定（MSG-20260929-17）：
 *   · 自动提交 Claim 仍为 FORBIDDEN（supportsClaimSubmission=false，闸门恒 NEEDS_MANUAL）
 *   · 允许：Submission Payload Builder + Dry Run Validator（无网络 / 无 API / 无凭据）
 *   · 不允许：任何真实请求、任何凭据注入、任何自动扣佣
 *
 * 本模块是**纯函数**：不发请求、不读环境变量、不读凭据、不写数据库。
 * 产物只是「如果要人工提交，应该长什么样」的载荷与自检结论。
 */

import { createHash } from 'node:crypto';

export const BUILDER_VERSION = 'submission-payload/v1';

/** 硬开关：本模块永不传输。任何真实提交都需要架构方新裁决 + 人工闸门。 */
export const SUBMISSION_TRANSPORT_ENABLED = false;

export const SUBMISSION_PLATFORMS = ['AMAZON', 'TIKTOK', 'WALMART'] as const;
export type SubmissionPlatform = (typeof SUBMISSION_PLATFORMS)[number];

/** 高额阈值与 recovery-review 保持一致（> $1000 需人工复核） */
export const HIGH_VALUE_THRESHOLD = '1000.0000';

export interface SubmissionInput {
  platform: SubmissionPlatform;
  /** 例如 FBA_REIMBURSEMENT / DNR_DISPUTE / WFS_WAREHOUSE_LOSS */
  claimType: string;
  orderRef: string;
  trackingNo?: string | null;
  /** 4 位小数以内的十进制字符串 */
  amount: string;
  currency: string;
  /** 申诉正文（人工确认后使用） */
  appealText: string;
  /** 证据引用（文件名 / 证据 id / 上传登记 id），至少 1 条 */
  evidenceRefs: string[];
  locale?: string;
}

export interface SubmissionPayload {
  platform: SubmissionPlatform;
  claimType: string;
  body: Record<string, unknown>;
  meta: {
    builderVersion: string;
    builtAt: string;
    payloadSha256: string;
    dryRunOnly: true;
    requiresHumanReview: boolean;
  };
}

export type DryRunStatus = 'DRY_RUN_OK' | 'DRY_RUN_BLOCKED';

export interface DryRunCheck {
  code: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

export interface DryRunResult {
  status: DryRunStatus;
  checks: DryRunCheck[];
  blockers: string[];
  /** 供人工与审计查看的稳定指纹 */
  payloadSha256: string;
}

const AMOUNT_RE = /^\d+(\.\d{1,4})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?\d[\d\s-]{7,}\d)/;
const SECRET_KEY_RE = /(secret|token|password|passwd|api[_-]?key|authorization|bearer|credential)/i;
const BEARER_VALUE_RE =
  /(?:bearer\s+[A-Za-z0-9._-]{16,}|sk_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16})/i;

export const APPEAL_TEXT_MAX = 4000;
export const PAYLOAD_SIZE_MAX_BYTES = 64 * 1024;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isHighValue(amount: string): boolean {
  if (!AMOUNT_RE.test(amount)) return false;
  return Number(amount) > Number(HIGH_VALUE_THRESHOLD);
}

/** 平台字段名映射：只决定「放哪个键」，不改变任何业务含义。 */
function buildBody(input: SubmissionInput): Record<string, unknown> {
  const base = {
    claim_type: input.claimType,
    order_reference: input.orderRef,
    tracking_number: input.trackingNo ?? null,
    claimed_amount: input.amount,
    claimed_currency: input.currency,
    appeal_text: input.appealText,
    evidence_references: [...input.evidenceRefs],
    locale: input.locale ?? 'en-US',
  };
  if (input.platform === 'AMAZON') {
    return { case_category: 'SELLER_FULFILLMENT', ...base };
  }
  if (input.platform === 'TIKTOK') {
    return { dispute_reason: 'SHIPMENT_NOT_RECEIVED', ...base };
  }
  return { dispute_reason: 'WAREHOUSE_LOSS', ...base };
}

/** 构造载荷（纯函数）。绝不发起任何请求，也绝不注入凭据。 */
export function buildSubmissionPayload(
  input: SubmissionInput,
  deps: { now?: () => Date } = {},
): SubmissionPayload {
  const at = (deps.now ?? (() => new Date()))();
  const body = buildBody(input);
  const serialized = JSON.stringify(body);
  return {
    platform: input.platform,
    claimType: input.claimType,
    body,
    meta: {
      builderVersion: BUILDER_VERSION,
      builtAt: at.toISOString(),
      payloadSha256: sha256(serialized),
      dryRunOnly: true,
      requiresHumanReview: isHighValue(input.amount),
    },
  };
}

/** 干跑校验：只回答「这份载荷能不能交给人工去提交」，不改任何东西。 */
export function validateSubmissionDryRun(payload: SubmissionPayload): DryRunResult {
  const checks: DryRunCheck[] = [];
  const blockers: string[] = [];
  const body = payload.body as Record<string, unknown>;

  const push = (code: string, ok: boolean, detail: string) => {
    checks.push({ code, status: ok ? 'PASS' : 'FAIL', detail });
    if (!ok) blockers.push(code);
  };

  const orderRef = String(body.order_reference ?? '').trim();
  push('ORDER_REFERENCE_PRESENT', orderRef !== '', 'order_reference 必填');

  const appealText = String(body.appeal_text ?? '');
  push('APPEAL_TEXT_PRESENT', appealText.trim() !== '', 'appeal_text 必填');
  push(
    'APPEAL_TEXT_LENGTH',
    appealText.trim().length > 0 && appealText.length <= APPEAL_TEXT_MAX,
    'appeal_text 长度必须在 1..' + APPEAL_TEXT_MAX,
  );
  push(
    'APPEAL_TEXT_FREE_TEXT_CLEAN',
    !EMAIL_RE.test(appealText) && !PHONE_RE.test(appealText),
    '自由文本里不允许出现邮箱或电话（须先掩码）',
  );

  const amount = String(body.claimed_amount ?? '');
  push('AMOUNT_FORMAT', AMOUNT_RE.test(amount), '金额必须是 4 位小数以内的十进制字符串');
  const currency = String(body.claimed_currency ?? '');
  push('CURRENCY_FORMAT', CURRENCY_RE.test(currency), '币种必须是 3 位大写字母');

  const evidence = Array.isArray(body.evidence_references) ? body.evidence_references : [];
  push('EVIDENCE_PRESENT', evidence.length > 0, '至少 1 条证据引用（POD 等以文件上传登记）');

  const keys = Object.keys(body);
  push(
    'NO_SECRET_KEYS',
    !keys.some((key) => SECRET_KEY_RE.test(key)),
    '载荷不得出现凭据类字段名',
  );
  const serialized = JSON.stringify(body);
  push('NO_SECRET_VALUES', !BEARER_VALUE_RE.test(serialized), '载荷不得出现 token / key 形态的值');
  push(
    'PAYLOAD_SIZE',
    Buffer.byteLength(serialized, 'utf8') <= PAYLOAD_SIZE_MAX_BYTES,
    '载荷体积上限 ' + PAYLOAD_SIZE_MAX_BYTES + ' 字节',
  );

  return {
    status: blockers.length === 0 ? 'DRY_RUN_OK' : 'DRY_RUN_BLOCKED',
    checks,
    blockers,
    payloadSha256: payload.meta.payloadSha256,
  };
}

/** 人工提交前的强制口径：即使干跑通过，也必须人工确认；自动提交恒不可用。 */
export function describeManualGate(payload: SubmissionPayload): {
  supportsClaimSubmission: false;
  requiresManualApproval: true;
  requiresOwnerApproval: boolean;
} {
  return {
    supportsClaimSubmission: false,
    requiresManualApproval: true,
    requiresOwnerApproval: payload.meta.requiresHumanReview,
  };
}
