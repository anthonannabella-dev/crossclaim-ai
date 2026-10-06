// SI/RSI GAP-CLOSURE — 单元 C — Experience Memory v1（结构化 / 可审计 / 可回滚 / server-derived）
// ---------------------------------------------------------------------------
// 定位：把「真实业务结果」沉淀成**结构化经验**，供 recommendation / ranking / confidence / planning 使用。
//   基本链：Outcome → Evidence → Decision → Action → Result → Experience Extraction → Experience Record
//           → Aggregation → Decision Support
// 复用：上游 Outcome / Learning Evidence 的结构复用既有 `services/outcome-learning/*`（outcome-record /
//   outcome-lineage / learning-evidence），本模块**不重造** outcome 记录。
//
// 硬边界（HOST 单元 C 明文）：
//   ① tenant / account / provider / domain 四维 scope，一律 server-derived（不接受客户端自报）；
//   ② raw experience **append-only**（store 端口不允许 update / delete）；
//   ③ 每条经验带 ruleVersion / 时间窗口 / sourceCount / confidence / sourceRefs；
//   ④ 明确区分 FACT / AGGREGATE / HEURISTIC；
//   ⑤ 禁止保存 token / secret / password / cookie / raw provider credential / 不必要的 raw provider payload；
//   ⑥ 低样本 → ADVISORY 且 fail-closed；冲突 → **禁止自动学习**；过期 → DOWNWEIGHT / IGNORE；
//   ⑦ v1 只能影响 recommendation / ranking / confidence / planning —— 不得因此获得任何 External Write 权限。

import { digestOf } from '../config-execution-durability/digests';

export const EXPERIENCE_MEMORY_VERSION = 'experience-memory/v1';

/** 经验类别：FACT（可直接核对的事实）/ AGGREGATE（窗口聚合）/ HEURISTIC（可提建议的启发式） */
export const EXPERIENCE_CLASSES = ['FACT', 'AGGREGATE', 'HEURISTIC'] as const;
export type ExperienceClass = (typeof EXPERIENCE_CLASSES)[number];

export const EXPERIENCE_OUTCOMES = ['RECOVERED', 'REJECTED', 'PARTIAL', 'WITHDRAWN', 'PENDING'] as const;
export type ExperienceOutcome = (typeof EXPERIENCE_OUTCOMES)[number];

export const EXPERIENCE_ACTIONS = [
  'SUBMIT_NOW',
  'COLLECT_MORE_EVIDENCE',
  'HUMAN_OR_BROKER_REVIEW',
  'DEFER',
  'NO_ACTION',
] as const;
export type ExperienceAction = (typeof EXPERIENCE_ACTIONS)[number];

export const EXPERIENCE_DOMAINS = ['PLATFORM', 'CARRIER', 'CUSTOMS', 'INDEPENDENT_SITE'] as const;
export type ExperienceDomain = (typeof EXPERIENCE_DOMAINS)[number];

/** v1 允许的影响面（唯一允许的用途） */
export const EXPERIENCE_ALLOWED_USES = ['recommendation', 'ranking', 'confidence', 'planning'] as const;
export type ExperienceAllowedUse = (typeof EXPERIENCE_ALLOWED_USES)[number];

export const EXPERIENCE_DECISION_SUPPORT = [
  'ADVISORY',
  'FAIL_CLOSED',
  'NO_AUTOMATIC_LEARNING',
  'DOWNWEIGHTED',
  'IGNORED',
] as const;
export type ExperienceDecisionSupport = (typeof EXPERIENCE_DECISION_SUPPORT)[number];

export interface ExperienceScope {
  organizationId: string;
  platformAccountId: string | null;
  provider: string;
  domain: ExperienceDomain;
}

/** 单条原始经验（append-only）。所有字段都是 server-derived。 */
export interface ExperienceRecord {
  experienceId: string;
  kind: 'EXPERIENCE_RECORD';
  /** FACT / AGGREGATE / HEURISTIC */
  experienceClass: ExperienceClass;
  scope: ExperienceScope;
  /** 结论维度：用于聚合与检索 */
  dimension: {
    action: ExperienceAction;
    outcome: ExperienceOutcome;
    /** 证据组合（稳定 code，如 POD+INVOICE） */
    evidenceCombination: string[];
    /** 拒绝原因（若有） */
    rejectionReason: string | null;
    /** 金额带（稳定 code，如 USD:0-1000） */
    amountBand: string | null;
    currency: string | null;
    /** 处理周期（天）与成本（USD），无依据时为 null */
    cycleTimeDays: number | null;
    costUsd: number | null;
    recoveredAmountUsd: number | null;
  };
  /** 规则 / 策略版本（经验必须绑定其产生的依据版本） */
  ruleVersion: string;
  /** 观测窗口（闭开区间） */
  window: { from: string; to: string };
  /** 纳入来源条数（aggregate 用；单条 FACT 为 1） */
  sourceCount: number;
  confidenceBp: number;
  sourceRefs: string[];
  /** 是否为服务端派生（客户端自报一律拒绝） */
  readonly serverDerived: true;
  recordedAt: string;
  recordDigest: string;
}

export type ExperienceErrorCode =
  | 'EXPERIENCE_NOT_SERVER_DERIVED'
  | 'EXPERIENCE_FORBIDDEN_CONTENT'
  | 'EXPERIENCE_APPEND_ONLY'
  | 'EXPERIENCE_SCOPE_MISMATCH'
  | 'EXPERIENCE_CANNOT_GRANT_EXTERNAL_WRITE';

export class ExperienceMemoryError extends Error {
  readonly code: ExperienceErrorCode;

  constructor(code: ExperienceErrorCode, message: string) {
    super(message);
    this.name = 'ExperienceMemoryError';
    this.code = code;
  }
}

/**
 * 禁止进入 Experience Memory 的内容（凭据类 / 原始 provider payload 标记）。
 * 先把 `_ . -` 统一成空格再匹配，避免 snake_case（aws_secret_access_key）绕过词边界。
 */
const FORBIDDEN_CONTENT_PATTERNS: readonly RegExp[] = [
  /bearer\s+[A-Za-z0-9._-]{8,}/i,
  /\bapi key\b/i,
  /\bsecret\b/i,
  /\bpassword\b|\bpasswd\b/i,
  /\bcookie\b|\bsession id\b/i,
  /authorization:\s*\S+/i,
  /\bprivate key\b/i,
  /\braw\s*payload\b|\braw\s*provider\s*payload\b|\brawpayload\b|\brawproviderpayload\b/i,
];

export function assertNoForbiddenExperienceContent(text: string): void {
  const normalized = text.replace(/[_\-.]+/g, ' ');
  for (const pattern of FORBIDDEN_CONTENT_PATTERNS) {
    if (pattern.test(normalized) || pattern.test(text)) {
      throw new ExperienceMemoryError(
        'EXPERIENCE_FORBIDDEN_CONTENT',
        'Experience Memory 禁止保存凭据类内容或原始 provider payload。',
      );
    }
  }
}

export interface ExperienceObservationInput {
  /** 必须显式声明来自服务端派生；客户端自报一律拒绝 */
  serverDerived: boolean;
  scope: ExperienceScope;
  ruleVersion: string;
  window: { from: string; to: string };
  action: ExperienceAction;
  outcome: ExperienceOutcome;
  evidenceCombination: readonly string[];
  rejectionReason?: string | null;
  amountBand?: string | null;
  currency?: string | null;
  cycleTimeDays?: number | null;
  costUsd?: number | null;
  recoveredAmountUsd?: number | null;
  confidenceBp?: number;
  sourceRefs?: readonly string[];
  recordedAt: string;
}

/** 从**服务端**观测抽取一条 FACT 级经验（其余字段仅允许稳定 code，不接受自由文本 payload） */
export function extractExperienceRecord(input: ExperienceObservationInput): ExperienceRecord {
  if (input.serverDerived !== true) {
    throw new ExperienceMemoryError(
      'EXPERIENCE_NOT_SERVER_DERIVED',
      'Experience Memory 只接受 server-derived 观测；客户端自报内容一律拒绝。',
    );
  }
  const stableCodes = [
    input.scope.provider,
    input.scope.domain,
    input.ruleVersion,
    input.action,
    input.outcome,
    input.rejectionReason ?? '',
    input.amountBand ?? '',
    input.currency ?? '',
    ...input.evidenceCombination,
    ...(input.sourceRefs ?? []),
  ].join('|');
  assertNoForbiddenExperienceContent(stableCodes);

  const confidenceBp = Math.max(0, Math.min(10_000, Math.round(input.confidenceBp ?? 5_000)));
  const body = {
    version: EXPERIENCE_MEMORY_VERSION,
    experienceClass: 'FACT' as const,
    scope: input.scope,
    dimension: {
      action: input.action,
      outcome: input.outcome,
      evidenceCombination: [...input.evidenceCombination].sort(),
      rejectionReason: input.rejectionReason ?? null,
      amountBand: input.amountBand ?? null,
      currency: input.currency ?? null,
      cycleTimeDays: input.cycleTimeDays ?? null,
      costUsd: input.costUsd ?? null,
      recoveredAmountUsd: input.recoveredAmountUsd ?? null,
    },
    ruleVersion: input.ruleVersion,
    window: input.window,
    sourceCount: 1,
    confidenceBp,
    sourceRefs: [...(input.sourceRefs ?? [])].sort(),
    serverDerived: true as const,
    recordedAt: input.recordedAt,
  };
  const recordDigest = digestOf(body);
  return {
    experienceId: 'exp-' + recordDigest.slice(0, 24),
    kind: 'EXPERIENCE_RECORD',
    ...body,
    recordDigest,
  };
}

/** 计算因子：样本量 / 冲突 / 过期三类安全规则 */
export const EXPERIENCE_LOW_SAMPLE_MIN = 5;
export const EXPERIENCE_DEFAULT_MAX_AGE_DAYS = 180;
export const EXPERIENCE_STALE_DOWNWEIGHT_BP = 5_000;

export interface ExperienceQuery {
  scope: { organizationId: string; platformAccountId?: string | null };
  /** 至少一个过滤维度；未给维度视为「该 scope 全量」 */
  action?: ExperienceAction | null;
  rejectionReason?: string | null;
  evidenceCombination?: readonly string[] | null;
  amountBand?: string | null;
  currency?: string | null;
  provider?: string | null;
  domain?: ExperienceDomain | null;
}

export interface ExperienceAggregate {
  kind: 'EXPERIENCE_AGGREGATE';
  experienceClass: 'AGGREGATE';
  scope: { organizationId: string; platformAccountId: string | null; provider: string | null; domain: ExperienceDomain | null };
  query: ExperienceQuery;
  sourceCount: number;
  successCount: number;
  /** 成功率（basis points）；无样本时为 null（绝不编造） */
  successRateBp: number | null;
  averageCycleTimeDays: number | null;
  averageCostUsd: number | null;
  averageRecoveredAmountUsd: number | null;
  confidenceBp: number;
  window: { from: string; to: string } | null;
  sourceRefs: string[];
  decisionSupport: ExperienceDecisionSupport;
  /** 必须为 true：低样本或冲突时不得自动学习 */
  requiresHumanReview: boolean;
  allowedUses: readonly ExperienceAllowedUse[];
  externalWriteGranted: false;
  reasonCodes: string[];
  computedAt: string;
  aggregateDigest: string;
}

function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000;
}

/**
 * 聚合经验（AGGREGATE 级）并给出**决策支持等级**。
 * 低样本 → ADVISORY + FAIL_CLOSED；冲突 → NO_AUTOMATIC_LEARNING；过期 → DOWNWEIGHTED / IGNORED。
 */
export function aggregateExperience(input: {
  records: readonly ExperienceRecord[];
  query: ExperienceQuery;
  now: Date;
  lowSampleMin?: number;
  maxAgeDays?: number;
}): ExperienceAggregate {
  const lowSampleMin = input.lowSampleMin ?? EXPERIENCE_LOW_SAMPLE_MIN;
  const maxAgeDays = input.maxAgeDays ?? EXPERIENCE_DEFAULT_MAX_AGE_DAYS;
  const query = input.query;
  const reasonCodes: string[] = [];

  const inScope = input.records.filter((record) => {
    if (record.scope.organizationId !== query.scope.organizationId) return false;
    const accountFilter = query.scope.platformAccountId ?? null;
    if (accountFilter !== null && record.scope.platformAccountId !== accountFilter) return false;
    if (query.provider !== undefined && query.provider !== null && record.scope.provider !== query.provider) return false;
    if (query.domain !== undefined && query.domain !== null && record.scope.domain !== query.domain) return false;
    if (query.action !== undefined && query.action !== null && record.dimension.action !== query.action) return false;
    if (
      query.rejectionReason !== undefined &&
      query.rejectionReason !== null &&
      record.dimension.rejectionReason !== query.rejectionReason
    ) {
      return false;
    }
    if (query.currency !== undefined && query.currency !== null && record.dimension.currency !== query.currency) {
      return false;
    }
    if (query.amountBand !== undefined && query.amountBand !== null && record.dimension.amountBand !== query.amountBand) {
      return false;
    }
    if (
      query.evidenceCombination !== undefined &&
      query.evidenceCombination !== null &&
      query.evidenceCombination.length > 0
    ) {
      const wanted = [...query.evidenceCombination].sort().join(',');
      if (record.dimension.evidenceCombination.join(',') !== wanted) return false;
    }
    return true;
  });

  // 过期：窗口结束时间距 now 超过 maxAgeDays
  const stale = inScope.filter((record) => daysBetween(record.window.to, input.now.toISOString()) > maxAgeDays);
  const fresh = inScope.filter((record) => !stale.includes(record));
  if (stale.length > 0) reasonCodes.push('STALE_RECORDS:' + stale.length);

  const usable = fresh;
  const sourceCount = usable.length;
  const successCount = usable.filter((record) => record.dimension.outcome === 'RECOVERED').length;
  const decisive = usable.filter((record) => record.dimension.outcome !== 'PENDING');
  const successRateBp =
    decisive.length === 0 ? null : Math.round((successCount / decisive.length) * 10_000);

  const average = (values: number[]): number | null =>
    values.length === 0 ? null : Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;

  const averageCycleTimeDays = average(
    usable.map((r) => r.dimension.cycleTimeDays).filter((v): v is number => typeof v === 'number'),
  );
  const averageCostUsd = average(
    usable.map((r) => r.dimension.costUsd).filter((v): v is number => typeof v === 'number'),
  );
  const averageRecoveredAmountUsd = average(
    usable.map((r) => r.dimension.recoveredAmountUsd).filter((v): v is number => typeof v === 'number'),
  );

  // 冲突：同一 scope 与维度下同时存在 RECOVERED 与 REJECTED（各 ≥2）→ 禁止自动学习
  const recovered = usable.filter((r) => r.dimension.outcome === 'RECOVERED').length;
  const rejected = usable.filter((r) => r.dimension.outcome === 'REJECTED').length;
  const conflict = recovered >= 2 && rejected >= 2;
  const lowSample = sourceCount < lowSampleMin;

  let decisionSupport: ExperienceDecisionSupport;
  if (sourceCount === 0 && inScope.length > 0) {
    decisionSupport = 'IGNORED';
    reasonCodes.push('ALL_RECORDS_STALE');
  } else if (sourceCount === 0) {
    decisionSupport = 'FAIL_CLOSED';
    reasonCodes.push('NO_EXPERIENCE_DATA');
  } else if (conflict) {
    decisionSupport = 'NO_AUTOMATIC_LEARNING';
    reasonCodes.push('CONFLICTING_OUTCOMES');
  } else if (lowSample) {
    decisionSupport = 'ADVISORY';
    reasonCodes.push('LOW_SAMPLE');
  } else if (usable.length > 0 && stale.length > 0 && usable.length <= stale.length) {
    decisionSupport = 'DOWNWEIGHTED';
    reasonCodes.push('MAJORITY_STALE');
  } else {
    decisionSupport = 'ADVISORY';
    reasonCodes.push('SUFFICIENT_SAMPLE');
  }

  const baseConfidence =
    sourceCount === 0
      ? 0
      : Math.round(usable.reduce((sum, r) => sum + r.confidenceBp, 0) / usable.length);
  const confidenceBp =
    decisionSupport === 'FAIL_CLOSED'
      ? 0
      : decisionSupport === 'NO_AUTOMATIC_LEARNING'
        ? Math.min(baseConfidence, 2_000)
        : decisionSupport === 'ADVISORY' && lowSample
          ? Math.min(baseConfidence, 4_000)
          : decisionSupport === 'DOWNWEIGHTED'
            ? Math.min(baseConfidence, EXPERIENCE_STALE_DOWNWEIGHT_BP)
            : baseConfidence;

  const windowFrom = usable.length === 0 ? null : usable.map((r) => r.window.from).sort()[0];
  const windowTo = usable.length === 0 ? null : usable.map((r) => r.window.to).sort().slice(-1)[0];

  const body = {
    version: EXPERIENCE_MEMORY_VERSION,
    experienceClass: 'AGGREGATE' as const,
    scope: {
      organizationId: query.scope.organizationId,
      platformAccountId: query.scope.platformAccountId ?? null,
      provider: query.provider ?? null,
      domain: query.domain ?? null,
    },
    query,
    sourceCount,
    successCount,
    successRateBp,
    averageCycleTimeDays,
    averageCostUsd,
    averageRecoveredAmountUsd,
    confidenceBp,
    window: windowFrom !== null && windowTo !== null ? { from: windowFrom, to: windowTo } : null,
    sourceRefs: [...new Set(usable.flatMap((r) => r.sourceRefs))].sort(),
    decisionSupport,
    requiresHumanReview: decisionSupport !== 'ADVISORY' || lowSample,
    allowedUses: EXPERIENCE_ALLOWED_USES,
    externalWriteGranted: false as const,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    computedAt: input.now.toISOString(),
  };

  return {
    kind: 'EXPERIENCE_AGGREGATE',
    ...body,
    aggregateDigest: digestOf(body),
  };
}

/** 只读 + append-only 的 Experience Memory 端口（无 update / delete） */
export interface ExperienceMemoryStorePort {
  append(record: ExperienceRecord): Promise<void>;
  list(filter: { organizationId: string; platformAccountId?: string | null }): Promise<readonly ExperienceRecord[]>;
}

export class ExperienceMemoryStoreError extends ExperienceMemoryError {}

/** 内存实现（契约验收用）；语义与未来 DB 实现一致：只追加，绝不修改/删除 */
export function createInMemoryExperienceMemoryStore(
  seed: readonly ExperienceRecord[] = [],
): ExperienceMemoryStorePort & { size(): number } {
  const rows: ExperienceRecord[] = [...seed];
  return {
    async append(record: ExperienceRecord): Promise<void> {
      if (rows.some((row) => row.experienceId === record.experienceId)) {
        throw new ExperienceMemoryStoreError(
          'EXPERIENCE_APPEND_ONLY',
          'Experience Memory 只能追加：同 id 重复写入一律拒绝（幂等由调用方以 digest 去重）。',
        );
      }
      rows.push(record);
    },
    async list(filter): Promise<readonly ExperienceRecord[]> {
      const accountFilter = filter.platformAccountId ?? null;
      return rows.filter(
        (row) =>
          row.scope.organizationId === filter.organizationId &&
          (accountFilter === null || row.scope.platformAccountId === accountFilter),
      );
    },
    size(): number {
      return rows.length;
    },
  };
}

export const EXPERIENCE_MEMORY_BOUNDARY = {
  rawAppendOnly: true,
  serverDerivedOnly: true,
  tenantScoped: true,
  accountScoped: true,
  providerScoped: true,
  domainScoped: true,
  forbiddenContentBlocked: true,
  lowSampleIsAdvisoryOrFailClosed: true,
  conflictForbidsAutomaticLearning: true,
  staleIsDownweightedOrIgnored: true,
  allowedUses: EXPERIENCE_ALLOWED_USES,
  externalWriteGranted: false,
  writesCanonicalTruth: false,
  decidesEligibility: false,
  forbidden: [
    'storing credentials / cookies / raw provider payloads',
    'accepting client-reported experience as truth',
    'mutating or deleting raw experience records',
    'learning automatically from conflicting outcomes',
    'using low-sample experience as a decision',
    'granting any external write capability from experience',
  ],
} as const;

/** 边界断言：任何把 Experience Memory 当成执行/外写权限来源的记录都必须被拒绝 */
export function assertExperienceDoesNotGrantExternalWrite(record: {
  externalWriteGranted?: boolean;
  allowedUses?: readonly string[];
}): void {
  if (record.externalWriteGranted === true) {
    throw new ExperienceMemoryError(
      'EXPERIENCE_CANNOT_GRANT_EXTERNAL_WRITE',
      'Experience Memory 不得授予任何 External Write 权限。',
    );
  }
  for (const use of record.allowedUses ?? []) {
    if (!(EXPERIENCE_ALLOWED_USES as readonly string[]).includes(use)) {
      throw new ExperienceMemoryError(
        'EXPERIENCE_CANNOT_GRANT_EXTERNAL_WRITE',
        'Experience Memory v1 只允许影响 recommendation / ranking / confidence / planning。',
      );
    }
  }
}

/** 跨 tenant 检索一律返回空（fail-closed），供上层断言使用 */
export function assertExperienceScopeMatches(input: {
  recordScopeOrganizationId: string;
  queryOrganizationId: string;
}): void {
  if (input.recordScopeOrganizationId !== input.queryOrganizationId) {
    throw new ExperienceMemoryError(
      'EXPERIENCE_SCOPE_MISMATCH',
      'Experience Memory 严禁跨 tenant 读取。',
    );
  }
}
