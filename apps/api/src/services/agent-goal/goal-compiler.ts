// AGENT EXPERIENCE LAYER / P1 — Goal Compiler（确定性优先，不用模型）
// ---------------------------------------------------------------------------
// 职责边界（HOST 第 4 条）：只能「理解用户意图 / 选择白名单 goal type / 生成候选 scope /
// 候选时间范围 / 候选执行偏好」。**不得**输出 service / function / action 名称后直接调用。
//
// 实现策略：v1 全部为**确定性规则**解析（`modelCallCount = 0`）。
//   * 只有确实需要自然语言理解时才允许进入既有 Model Gateway（后续单元），
//     且必须复用 AI necessity gate / cost policy / budget / cache —— 本单元不引入任何模型调用。
//   * 无法确定性支持的意图 → `GOAL_UNSUPPORTED_INTENT`（fail safely，不猜测）。
//   * 文本中出现动作目录名 / 工具名 / 越权指令 → `GOAL_INJECTION_SUSPECTED`（拒绝）。

import { ACTION_GUARD_CATALOG } from '../action-guard/action-guard';
import { GOAL_PROVIDER_DOMAINS } from './goal-contract';
import {
  GOAL_MAX_INTENT_LENGTH,
  GOAL_MAX_MONTHS,
  type AgentGoalDraft,
  type GoalApprovalCurrency,
  type GoalDomain,
  type GoalProvider,
  type GoalExecutionMode,
  type GoalTimeRange,
  type GoalType,
} from './goal-contract';

export const GOAL_COMPILER_VERSION = 'agent-goal-compiler/v1';

export type GoalCompileFailureReason =
  | 'GOAL_EMPTY_INTENT'
  | 'GOAL_INTENT_TOO_LONG'
  | 'GOAL_UNSUPPORTED_INTENT'
  | 'GOAL_INJECTION_SUSPECTED';

export type GoalCompileResult =
  | { readonly ok: true; readonly draft: AgentGoalDraft; readonly matchedSignals: readonly string[]; readonly modelCallCount: 0 }
  | { readonly ok: false; readonly reason: GoalCompileFailureReason; readonly detail: string; readonly modelCallCount: 0 };

/** 域信号：只使用既有 `RecoveryDomain` 词汇 + 平台/渠道别名 */
/** FINAL4：provider/平台意图信号（确定性；无模型调用） */
const PROVIDER_SIGNALS: ReadonlyArray<{ provider: GoalProvider; patterns: readonly RegExp[] }> = [
  { provider: 'AMAZON', patterns: [/amazon/i, /fba/i, /亚马逊/] },
  { provider: 'WALMART', patterns: [/walmart/i, /沃尔玛/] },
  { provider: 'TIKTOK', patterns: [/tiktok/i, /抖音/] },
  { provider: 'EBAY', patterns: [/ebay/i] },
  { provider: 'SHOPIFY', patterns: [/shopify/i] },
  { provider: 'STRIPE', patterns: [/stripe/i] },
  { provider: 'PAYPAL', patterns: [/paypal/i] },
  { provider: 'UPS', patterns: [/\bups\b/i] },
  { provider: 'FEDEX', patterns: [/fedex/i, /联邦快递/] },
  { provider: 'DHL', patterns: [/\bdhl\b/i] },
  { provider: 'FREIGHT_FORWARDER', patterns: [/freight/i, /货代/] },
  { provider: 'INSURANCE', patterns: [/insurance/i, /保险/] },
  { provider: 'CBP', patterns: [/\bcbp\b/i] },
];

const DOMAIN_SIGNALS: ReadonlyArray<{ domain: GoalDomain; patterns: readonly RegExp[] }> = [
  {
    domain: 'PLATFORM',
    patterns: [/platform/i, /amazon/i, /fba/i, /tiktok/i, /walmart/i, /shopify/i, /\bseller\b/i, /平台/, /亚马逊/, /卖家/],
  },
  {
    domain: 'LOGISTICS',
    patterns: [/logistics/i, /carrier/i, /\bups\b/i, /fedex/i, /\bdhl\b/i, /freight/i, /shipping/i, /物流/, /运费/, /快递/],
  },
  {
    domain: 'CUSTOMS',
    patterns: [
      /customs/i,
      /\bduty\b/i,
      /\bduties\b/i,
      /tariff/i,
      /\b7501\b/i,
      /\bentry\b/i,
      /\bimport(?:s|ed|ing)?\b/i,
      /关税/,
      /海关/,
      /报关/,
      /进口/,
    ],
  },
  {
    domain: 'INDEPENDENT_SITE',
    patterns: [/independent\s*site/i, /chargeback/i, /charge\s*back/i, /独立站/, /拒付/],
  },
];

const RECOVER_SIGNAL = /(追回|找回|索赔|recover|recovery|reimburs|refund|要回来|可追回|money\s*back)/i;
const FIND_SIGNAL = /(找|发现|扫描|检查|盘点|看看|find|scan|discover|check|audit|review|look)/i;
const ATTENTION_SIGNAL = /(需要我|要我|待办|我的待办|需要批准|需要审批|needs?\s*my\s*attention|action\s*items?|to[- ]?do)/i;
const DISCOVER_ONLY_SIGNAL = /(只看|只检查|先看|先检查|别动|不要执行|只发现|仅发现|don'?t\s*act|do\s*not\s*act|discover\s*only|only\s*(find|check|show))/i;
const AUTO_SIGNAL = /(自动|直接处理|直接执行|无需确认|不用问我|auto(matically)?|just\s*(do|process)\s*it)/i;
const APPROVAL_EACH_SIGNAL = /(每个都(要|需要)?(批准|审批)|每次(都)?(要|需要)?(批准|审批)|approve\s*each|always\s*ask)/i;

const MONTHS_SIGNAL = /(\d{1,2})\s*(?:个)?\s*(?:月|months?)/i;
/** HISTORICAL_RECOVERY_SCAN_V1：显式「年」信号（阿拉伯数字 + 中文数字），必须先于默认 12 个月判定 */
const YEARS_DIGIT_SIGNAL = /(\d{1,3})\s*(?:个)?\s*(?:年|years?|yrs?)/i;
const YEARS_CJK_SIGNAL = /([一二两三四五六七八九十]{1,3})\s*年/;
const CJK_DIGITS: Readonly<Record<string, number>> = {
  '一': 1,
  '二': 2,
  '两': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '七': 7,
  '八': 8,
  '九': 9,
};
const LAST_YEAR_SIGNAL = /(过去|最近|last|past)\s*(?:一|1|one)?\s*(?:年|year)/i;
const YTD_SIGNAL = /(今年|本年|year\s*to\s*date|\bytd\b)/i;
const ALL_TIME_SIGNAL = /(全部|所有|历史|有史以来|all\s*time|\ball\b|ever)/i;

const AMOUNT_SIGNAL = /(?:\$|usd|us\$|美元|美金)\s*([\d][\d,]{0,12})|([\d][\d,]{0,12})\s*(?:美元|美金|usd|\$)/i;

/**
 * 注入检测：文本试图指定动作 / 工具 / 服务，或试图绕过守卫 —— 一律拒绝。
 * 注意：这里只做「拒绝」，不做「清洗后继续」——避免任何静默降级。
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:service|tool|function|endpoint|webhook|sql|query)\s*[:=]/i,
  /\b(?:ignore|disregard|forget)\b[^.]{0,40}\b(?:instruction|rule|guard|policy|approval)s?\b/i,
  // 中文「忽略 / 无视 / 不遵守 … 规则 / 审批 / 授权 / 守卫 / 政策」一律视为注入
  /(忽略|无视|忘记|不要遵守|不遵守|不用管)[^。.]{0,24}(规则|指令|审批|授权|限制|守卫|政策|约束|gate)/,
  /\b(?:system\s*prompt|developer\s*message|jailbreak)\b/i,
  /\b(?:sudo|root\s*access|grant\s*(?:admin|owner))\b/i,
  /<\s*script/i,
  /(?:bypass|绕过|跳过|绕开)[^。.]{0,24}(?:guard|approval|审批|授权|限制|gate|守卫|校验)/i,
  /\b(?:execute|call|invoke)\s+(?:the\s+)?[a-z][\w.]*\s*\(/i,
];

const ACTION_TOKENS: readonly string[] = Object.keys(ACTION_GUARD_CATALOG);

export function detectGoalInjection(text: string): { suspected: boolean; detail: string } {
  for (const token of ACTION_TOKENS) {
    if (text.toLowerCase().includes(token.toLowerCase())) {
      return { suspected: true, detail: 'action-token:' + token };
    }
  }
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return { suspected: true, detail: 'pattern:' + pattern.source };
    }
  }
  return { suspected: false, detail: '' };
}

function resolveDomains(text: string): { domains: GoalDomain[]; signals: string[] } {
  const domains: GoalDomain[] = [];
  const signals: string[] = [];
  for (const entry of DOMAIN_SIGNALS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      domains.push(entry.domain);
      signals.push('DOMAIN:' + entry.domain);
    }
  }
  return { domains, signals };
}

function resolveProviders(text: string): GoalProvider[] {
  const providers: GoalProvider[] = [];
  for (const entry of PROVIDER_SIGNALS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) providers.push(entry.provider as GoalProvider);
  }
  return providers.sort();
}

/** 中文数字 → 数值（支持 一…十 / 十一…十九 / 二十…九十九） */
function parseCjkNumber(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  if (text === '十') return 10;
  if (!text.includes('十')) return CJK_DIGITS[text] ?? null;
  const [tensRaw, onesRaw] = text.split('十');
  const tens = tensRaw === '' ? 1 : (CJK_DIGITS[tensRaw] ?? null);
  if (tens === null) return null;
  const ones = onesRaw === '' ? 0 : (CJK_DIGITS[onesRaw] ?? null);
  if (ones === null) return null;
  return tens * 10 + ones;
}

/**
 * 显式「年」解析（deterministic-first；不做任何意图猜测）。
 * 命中即返回请求月数，**不静默回落默认 12 个月**。
 */
function resolveRequestedYears(text: string): number | null {
  const digit = YEARS_DIGIT_SIGNAL.exec(text);
  if (digit) {
    const years = Number(digit[1]);
    return Number.isFinite(years) && years > 0 ? Math.trunc(years) : null;
  }
  const cjk = YEARS_CJK_SIGNAL.exec(text);
  if (cjk) return parseCjkNumber(cjk[1]);
  return null;
}

function resolveTimeRange(text: string): { timeRange: GoalTimeRange; signal: string | null } {
  const months = MONTHS_SIGNAL.exec(text);
  if (months) {
    return { timeRange: { kind: 'LAST_N_MONTHS', months: Number(months[1]) }, signal: 'TIME:LAST_N_MONTHS' };
  }
  const requestedYears = resolveRequestedYears(text);
  if (requestedYears !== null) {
    const requestedMonths = requestedYears * 12;
    if (requestedMonths > GOAL_MAX_MONTHS) {
      // 显式请求超上限：夹紧到 bounded max 并**记录信号**（可审计，绝不静默）
      return {
        timeRange: { kind: 'LAST_N_MONTHS', months: GOAL_MAX_MONTHS },
        signal: 'TIME:CLAMPED_TO_MAX',
      };
    }
    return { timeRange: { kind: 'LAST_N_MONTHS', months: requestedMonths }, signal: 'TIME:LAST_N_YEARS' };
  }
  if (LAST_YEAR_SIGNAL.test(text)) {
    return { timeRange: { kind: 'LAST_N_MONTHS', months: 12 }, signal: 'TIME:LAST_12_MONTHS' };
  }
  if (YTD_SIGNAL.test(text)) return { timeRange: { kind: 'YEAR_TO_DATE' }, signal: 'TIME:YEAR_TO_DATE' };
  if (ALL_TIME_SIGNAL.test(text)) return { timeRange: { kind: 'ALL_TIME' }, signal: 'TIME:ALL_TIME' };
  return { timeRange: { kind: 'LAST_N_MONTHS', months: 12 }, signal: 'TIME:DEFAULT_12_MONTHS' };
}

function resolveApprovalThreshold(text: string): { threshold: AgentGoalDraft['approvalThreshold']; signal: string | null } {
  const match = AMOUNT_SIGNAL.exec(text);
  if (!match) return { threshold: null, signal: null };
  const raw = (match[1] ?? match[2] ?? '').replace(/,/g, '');
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) return { threshold: null, signal: null };
  const currency: GoalApprovalCurrency = 'USD';
  return { threshold: { currency, amount }, signal: 'THRESHOLD_PREFERENCE:' + currency + ':' + amount };
}

function resolveExecutionMode(text: string): GoalExecutionMode {
  if (DISCOVER_ONLY_SIGNAL.test(text)) return 'DISCOVER_ONLY';
  if (APPROVAL_EACH_SIGNAL.test(text)) return 'REQUIRE_APPROVAL_EACH';
  if (AUTO_SIGNAL.test(text)) return 'AUTO_WHEN_AUTHORIZED';
  // 默认**保守**：不因未声明而自动执行
  return 'REQUIRE_APPROVAL_EACH';
}

/**
 * 确定性编译：自然语言 → 候选结构化 goal。
 * 不做模型调用；不输出动作 / 服务 / 工具；不可确定性支持 → 失败返回。
 */
export function compileAgentGoal(input: { text: string }): GoalCompileResult {
  const text = String(input?.text ?? '').trim();
  if (text === '') {
    return { ok: false, reason: 'GOAL_EMPTY_INTENT', detail: '输入为空', modelCallCount: 0 };
  }
  if (text.length > GOAL_MAX_INTENT_LENGTH) {
    return { ok: false, reason: 'GOAL_INTENT_TOO_LONG', detail: '输入超长', modelCallCount: 0 };
  }

  const injection = detectGoalInjection(text);
  if (injection.suspected) {
    return { ok: false, reason: 'GOAL_INJECTION_SUSPECTED', detail: injection.detail, modelCallCount: 0 };
  }

  const { domains, signals } = resolveDomains(text);
  const providers = resolveProviders(text);
  // FINAL5：provider 意图决定域（canonical 映射同源），避免“Shopify 归 PLATFORM / admission 归 INDEPENDENT_SITE”这类不一致
  for (const provider of providers) {
    const mapped = GOAL_PROVIDER_DOMAINS[provider as keyof typeof GOAL_PROVIDER_DOMAINS];
    if (mapped !== undefined && !domains.includes(mapped)) domains.push(mapped);
  }
  const { timeRange, signal: timeSignal } = resolveTimeRange(text);
  const { threshold, signal: thresholdSignal } = resolveApprovalThreshold(text);
  const wantsAttention = ATTENTION_SIGNAL.test(text);
  const readOnly = DISCOVER_ONLY_SIGNAL.test(text);
  const recoverish = RECOVER_SIGNAL.test(text);
  const findish = FIND_SIGNAL.test(text);

  let goalType: GoalType;
  let executionMode: GoalExecutionMode;

  if (wantsAttention) {
    goalType = 'REVIEW_ATTENTION';
    executionMode = 'DISCOVER_ONLY';
  } else if (readOnly) {
    goalType = 'DISCOVER_ONLY';
    executionMode = 'DISCOVER_ONLY';
  } else if (domains.length === 1 && findish && !recoverish) {
    goalType = 'AUDIT_DOMAIN';
    executionMode = resolveExecutionMode(text);
  } else if (domains.length > 0 && (recoverish || findish)) {
    goalType = 'DISCOVER_AND_RECOVER';
    executionMode = resolveExecutionMode(text);
  } else {
    return {
      ok: false,
      reason: 'GOAL_UNSUPPORTED_INTENT',
      detail: '无法在受支持 goal type / domain 白名单内确定意图',
      modelCallCount: 0,
    };
  }

  const matchedSignals = [
    ...signals,
    timeSignal,
    thresholdSignal,
    wantsAttention ? 'INTENT:REVIEW_ATTENTION' : null,
    readOnly ? 'MODE:READ_ONLY_HINT' : null,
    recoverish ? 'INTENT:RECOVER' : null,
  ].filter((value): value is string => value !== null);

  const draft: AgentGoalDraft = {
    goalType,
    domains,
    providers,
    timeRange,
    executionMode,
    approvalThreshold: threshold,
    matchedSignals,
  };

  return { ok: true, draft, matchedSignals, modelCallCount: 0 };
}

export const GOAL_COMPILER_BOUNDARY = {
  version: GOAL_COMPILER_VERSION,
  deterministicFirst: true,
  modelCallCount: 0,
  usesModelGateway: false,
  emitsActionNames: false,
  emitsServiceOrToolNames: false,
  unknownIntentFailsSafely: true,
  injectionRejectedNotSanitized: true,
  defaultExecutionModeIsConservative: 'REQUIRE_APPROVAL_EACH',
  forbidden: [
    'calling a model without the AI necessity gate / cost policy / budget / cache',
    'emitting a service, tool or function name for later invocation',
    'emitting action names outside ACTION_GUARD_CATALOG',
    'guessing an unsupported intent instead of failing safely',
  ],
} as const;
