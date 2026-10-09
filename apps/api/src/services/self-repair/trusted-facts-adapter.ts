/**
 * PHASE 3-A — U1：只读权威可信事实适配器（READ-ONLY）
 * ---------------------------------------------------------------
 * 授权依据（历史）：MSG-20261009-14 `PHASE3_A_MINIMAL_SCOPE_AUTHORIZED = YES`，授权单元 = `U1_READ_ONLY_SUBSET`。
 * 修订依据：MSG-20261009-15 → **CHANGE 17–20**（设计文档 §17）；
 *           MSG-20261009-16 → **CHANGE 24–25**（U1 FINAL-R3，设计文档 §18）。
 *
 * **只读边界（硬约束）**
 *   - 只执行 SELECT：读取 Organization 身份 + 该组织**全部** StandingAuthorization 行；
 *   - **不写**任何业务数据（不建任务 / 不建候选 / 不领取租约 / 不调用 ONE SI Runtime / 不做外部调用）；
 *   - 全部读取在**只读事务**内执行（`SET TRANSACTION READ ONLY`）：若事务内出现任何写入，
 *     数据库会直接报错 —— 这证明「无写」，而不是「没有调用写方法」；
 *   - 不新增 Scheduler / Controller / Runtime；不改 Prisma schema / migration。
 *
 * **信任边界与来源约束**
 *   - `organizationId` 来自服务端会话 / 授权上下文，不是请求载荷字段；
 *   - `caller` / `operationRecheck` / **`resourceScope`** 由可信执行上下文注入（**不得**来自请求 / 客户端 / 模型）；
 *   - 调用方白名单：`SERVER_REQUEST_GATE` / `RUNTIME_MEMBER`，其余一律 `CALLER_NOT_TRUSTED`；
 *   - **CHANGE 24**：每个 `actionType` 的**必需范围维度由服务端动作策略决定**（不由调用者决定）；
 *     必需维度缺失 / 空串 / 来源不可信 ⇒ fail-closed；只有策略判定为可选的维度才允许缺省；
 *   - 任一事实无法由可信来源确定 ⇒ fail-closed（ok:false + 稳定原因码），**不猜测、不降级**。
 *
 * 产出：`TriageTrustedFacts`（直接喂给 `triageFaultIncident`）+ `provenance`（来源、主体、版本、范围策略、读取范围、读取时间）。
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import type { TriageTrustedFacts } from './fault-triage';

/** CHANGE 19：可信调用方白名单（由服务端装配注入；不得来自请求 / 客户端 / 模型）。 */
export const TRUSTED_FACTS_CALLERS = ['SERVER_REQUEST_GATE', 'RUNTIME_MEMBER'] as const;
export type TrustedFactsCaller = (typeof TRUSTED_FACTS_CALLERS)[number];

/** CHANGE 17：资源范围维度全集。 */
export const TRUSTED_FACTS_SCOPE_DIMENSIONS = ['provider', 'platformAccountId', 'domain', 'jurisdiction'] as const;
export type TrustedFactsScopeDimension = (typeof TRUSTED_FACTS_SCOPE_DIMENSIONS)[number];

/**
 * CHANGE 24：**服务端动作策略** —— 每个 `actionType` 的必需 / 可选范围维度。
 * 关键点：必需维度由**服务端策略**决定；调用者既不能决定必需维度，也不能通过省略维度放大授权匹配面。
 * 未登记的动作类型 ⇒ `SCOPE_POLICY_NOT_DEFINED`（fail-closed，不猜测）。
 */
export const TRUSTED_FACTS_ACTION_SCOPE_POLICY: Readonly<
  Record<string, { required: readonly TrustedFactsScopeDimension[]; optional: readonly TrustedFactsScopeDimension[] }>
> = {
  'recovery.read': { required: ['platformAccountId', 'provider'], optional: ['domain', 'jurisdiction'] },
  'internal.repair.propose': { required: ['platformAccountId', 'provider'], optional: ['domain', 'jurisdiction'] },
};

/** CHANGE 20：只读事务语句（唯一允许的原生 SQL；仅此一条，且为只读约束）。 */
export const READ_ONLY_TRANSACTION_SQL = 'SET TRANSACTION READ ONLY';

/** 金额形态：非负十进制，小数位 ≤ 4（禁科学计数法 / 负号 / 空串）。 */
const DECIMAL_4DP = /^\d+(\.\d{1,4})?$/;

/**
 * CHANGE 17：授权行**只读投影**（含 ID 与资源范围维度，用于唯一性判定与 provenance 追溯）。
 */
export interface StandingAuthorizationRecord {
  authorizationId: string;
  authorizationVersion: number;
  revocationState: string;
  effectiveAt: Date;
  expiresAt: Date;
  allowedActionTypes: readonly string[];
  monetaryLimitUsd: string;
  currency: string;
  provider: string;
  platformAccountId: string;
  domain: string;
  jurisdiction: string;
  scopeDigest: string;
}

/** CHANGE 24：资源范围（**可信来源**：由服务端执行上下文注入；未提供的可选维度不构成约束）。 */
export interface TrustedFactsResourceScope {
  provider?: string;
  platformAccountId?: string;
  domain?: string;
  jurisdiction?: string;
}

/**
 * 只读读取端口（实现必须只做 SELECT）。
 * `withReadOnlyTransaction` 必须让 `findOrganization` / `listStandingAuthorizations` 在**同一只读事务**内执行；
 * 回调接收该事务句柄，便于**独立证据**在**同一事务**内验证写入被数据库拒绝（CHANGE 25）。
 */
export interface TrustedFactsReadPort {
  /** 组织是否存在于持久化数据关系（读取 identityVersion）。 */
  findOrganization(input: {
    organizationId: string;
  }): Promise<{ id: string; identityVersion: string | null } | null>;
  /**
   * CHANGE 17：返回该组织**全部** StandingAuthorization 行（**不预过滤**）。
   * 唯一性判定、资源范围匹配与原因细分全部由适配器完成（避免「只取最高版本掩盖多授权冲突」）。
   */
  listStandingAuthorizations(input: {
    organizationId: string;
  }): Promise<readonly StandingAuthorizationRecord[]>;
  /** CHANGE 20：把全部读取包在只读事务内。已在只读事务内时可复用（不得重复开启）。 */
  withReadOnlyTransaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

/** 可信执行上下文（由服务端装配注入；**不是**请求 / 客户端 / 模型输入）。 */
export interface TrustedExecutionContext {
  /** 本次调用的主体标识（如运行时成员 ref）。 */
  subjectRef: string;
  /** CHANGE 19：调用方边界（运行时校验；白名单外 ⇒ CALLER_NOT_TRUSTED）。 */
  caller: string;
  /** 对「只读 / 幂等未生效 / 未确认」的再次确认结果。 */
  operationRecheck: 'CONFIRMED_READ_ONLY' | 'CONFIRMED_IDEMPOTENT_NOT_APPLIED' | 'NOT_CONFIRMED';
  /** CHANGE 24：**可信资源范围**（服务端解析注入；策略要求的维度必须齐备）。 */
  resourceScope?: TrustedFactsResourceScope;
}

export interface TrustedFactsProvenance {
  organizationIdResolved: {
    source: 'TRUSTED_PERSISTED_IDENTITY';
    resolvedFrom: 'Organization';
    subjectRef: string;
    identityVersion: string | null;
    resolvedAt: string;
  };
  authorizationActive: {
    source: 'SERVER_AUTHORIZATION_STATE';
    resolvedFrom: 'StandingAuthorization';
    /** CHANGE 17：唯一命中授权行的 ID（可追溯到具体行，而不仅是版本号）。 */
    authorizationId: string;
    authorizationVersion: number;
    scopeDigest: string;
    currency: string;
    resolvedAt: string;
  } | null;
  callerBoundary: {
    source: 'TRUSTED_EXECUTION_CONTEXT';
    caller: string;
    trusted: true;
    resolvedAt: string;
  };
  /** CHANGE 24：本次采用的服务端范围策略与已提供的可信范围维度。 */
  scopePolicy: {
    source: 'SERVER_ACTION_POLICY';
    actionType: string;
    required: readonly TrustedFactsScopeDimension[];
    optional: readonly TrustedFactsScopeDimension[];
    providedDimensions: readonly TrustedFactsScopeDimension[];
    resolvedAt: string;
  };
  operationRecheck: {
    source: 'TRUSTED_EXECUTION_CONTEXT';
    subjectRef: string;
    recheck: TrustedExecutionContext['operationRecheck'];
    resolvedAt: string;
  };
  /** CHANGE 20：本次解析覆盖的读取（全部位于只读事务内）。 */
  readScope: {
    source: 'READ_ONLY_TRANSACTION';
    statement: string;
    coveredReads: readonly string[];
    resolvedAt: string;
  };
  /** 事实版本：由身份版本 + 授权版本组成（用于 CHANGE 19 的版本失效判定）。 */
  factVersion: string;
}

export type TrustedFactsFailureReason =
  | 'TENANT_CONTEXT_REQUIRED'
  | 'CALLER_NOT_TRUSTED'
  | 'ORGANIZATION_NOT_FOUND'
  | 'AUTHORIZATION_NOT_FOUND'
  | 'AUTHORIZATION_REVOKED'
  | 'AUTHORIZATION_NOT_EFFECTIVE'
  | 'AUTHORIZATION_AMBIGUOUS'
  | 'ACTION_TYPE_NOT_ALLOWED'
  | 'SCOPE_POLICY_NOT_DEFINED'
  | 'REQUIRED_SCOPE_MISSING'
  | 'MONETARY_INPUT_INVALID'
  | 'MONETARY_LIMIT_EXCEEDED'
  | 'STALE_FACT_VERSION'
  | 'OPERATION_RECHECK_NOT_CONFIRMED';

export type TrustedFactsResolution =
  | { ok: true; facts: TriageTrustedFacts; provenance: TrustedFactsProvenance }
  | { ok: false; reason: TrustedFactsFailureReason; provenance: TrustedFactsProvenance | null };

export interface TrustedFactsAdapter {
  resolve(input: {
    /** 由服务端**会话 / 授权上下文**提供（不是候选载荷字段）。 */
    organizationId: string;
    /** 待判定的动作类型（用于授权范围校验与 CHANGE 24 范围策略查找）。 */
    actionType: string;
    /** CHANGE 18：**显式**声明是否涉及金额动作（缺失 / 非布尔 ⇒ fail-closed）。 */
    monetaryAction: boolean;
    /** 金额动作时必填：USD 十进制字符串（≤4 位小数，非负）。 */
    amountUsd?: string;
    /** 金额动作时必填：币种（当前仅接受 USD）。 */
    currency?: string;
    /** CHANGE 19：调用方期望的事实版本；不一致 ⇒ STALE_FACT_VERSION。 */
    expectedFactVersion?: string;
  }): Promise<TrustedFactsResolution>;
}

const fail = (
  reason: TrustedFactsFailureReason,
  provenance: TrustedFactsProvenance | null = null,
): TrustedFactsResolution => ({ ok: false, reason, provenance });

const trimOrEmpty = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * 十进制比较（纯字符串 / 整数位长度 + 字典序，避免浮点误差）。
 * 返回 null 表示**至少一侧形态不合法**（⇒ 调用方按 fail-closed 处理）。
 */
function compareDecimal(left: string, right: string): number | null {
  const parse = (value: string): { whole: string; fraction: string } | null => {
    const normalized = value.trim();
    if (!DECIMAL_4DP.test(normalized)) return null;
    const [wholeRaw, fractionRaw = ''] = normalized.split('.');
    const whole = wholeRaw.replace(/^0+(?=\d)/, '');
    return { whole, fraction: fractionRaw.padEnd(4, '0').slice(0, 4) };
  };
  const a = parse(left);
  const b = parse(right);
  if (a === null || b === null) return null;
  if (a.whole.length !== b.whole.length) return a.whole.length > b.whole.length ? 1 : -1;
  if (a.whole !== b.whole) return a.whole > b.whole ? 1 : -1;
  if (a.fraction !== b.fraction) return a.fraction > b.fraction ? 1 : -1;
  return 0;
}

/** 金额是否**超过**授权上限；任一侧不可解析 ⇒ 视为超限（fail-closed）。 */
export function exceedsMonetaryLimit(amountUsd: string, limitUsd: string): boolean {
  const compared = compareDecimal(amountUsd, limitUsd);
  if (compared === null) return true;
  return compared > 0;
}

type MonetaryInput =
  | { ok: true; amountUsd: string | null; currency: string | null }
  | { ok: false };

/** CHANGE 18：金额 / 币种的**显式**规则（缺失、形态不合法、币种非 USD 一律 MONETARY_INPUT_INVALID）。 */
function parseMonetaryInput(request: {
  monetaryAction?: unknown;
  amountUsd?: unknown;
  currency?: unknown;
}): MonetaryInput {
  if (typeof request.monetaryAction !== 'boolean') return { ok: false };
  const hasAmount = request.amountUsd !== undefined && request.amountUsd !== null;
  const hasCurrency = request.currency !== undefined && request.currency !== null;

  if (request.monetaryAction === false) {
    // 非金额动作**不得**携带金额 / 币种
    if (hasAmount || hasCurrency) return { ok: false };
    return { ok: true, amountUsd: null, currency: null };
  }

  if (!hasAmount || !hasCurrency) return { ok: false };
  const amountUsd = trimOrEmpty(request.amountUsd);
  if (!DECIMAL_4DP.test(amountUsd)) return { ok: false };
  if (trimOrEmpty(request.currency).toUpperCase() !== 'USD') return { ok: false };
  return { ok: true, amountUsd, currency: 'USD' };
}

/**
 * CHANGE 24：校验策略要求的**必需范围维度**是否齐备（缺失 / 空串 / 非法类型 ⇒ fail-closed）。
 * 注意：范围值来自**可信执行上下文**，而不是请求；调用者无法通过省略维度放大匹配面。
 */
export function missingRequiredScopeDimensions(
  policy: { required: readonly TrustedFactsScopeDimension[] },
  scope: TrustedFactsResourceScope | undefined,
): readonly TrustedFactsScopeDimension[] {
  return policy.required.filter((dimension) => {
    const value = scope === undefined ? undefined : scope[dimension];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/** CHANGE 17：资源范围匹配（未提供的维度不构成约束；提供了但为空串 = 不匹配）。 */
function scopeMatches(record: StandingAuthorizationRecord, scope: TrustedFactsResourceScope | undefined): boolean {
  if (scope === undefined) return true;
  const dimensions: readonly (readonly [unknown, string])[] = [
    [scope.provider, record.provider],
    [scope.platformAccountId, record.platformAccountId],
    [scope.domain, record.domain],
    [scope.jurisdiction, record.jurisdiction],
  ];
  for (const [requested, actual] of dimensions) {
    if (requested === undefined) continue;
    const normalized = trimOrEmpty(requested);
    if (normalized === '') return false;
    if (normalized.toUpperCase() !== trimOrEmpty(actual).toUpperCase()) return false;
  }
  return true;
}

/**
 * CHANGE 17：授权选择（**唯一性**优先，任何歧义 fail-closed）。
 *   0 条 → 按原因细分；**≥2 条有效记录 → AUTHORIZATION_AMBIGUOUS**。
 */
function selectAuthorization(
  rows: readonly StandingAuthorizationRecord[],
  actionType: string,
  scope: TrustedFactsResourceScope | undefined,
  at: Date,
): { ok: true; record: StandingAuthorizationRecord } | { ok: false; reason: TrustedFactsFailureReason } {
  if (rows.length === 0) return { ok: false, reason: 'AUTHORIZATION_NOT_FOUND' };

  const withAction = rows.filter((row) => row.allowedActionTypes.includes(actionType));
  if (withAction.length === 0) return { ok: false, reason: 'ACTION_TYPE_NOT_ALLOWED' };

  const inScope = withAction.filter((row) => scopeMatches(row, scope));
  // 范围不匹配 ⇒ 视为「该范围下无适用授权」（不猜测、不降级到其他范围）
  if (inScope.length === 0) return { ok: false, reason: 'AUTHORIZATION_NOT_FOUND' };

  const effective = inScope.filter(
    (row) =>
      row.revocationState === 'ACTIVE' &&
      row.effectiveAt.getTime() <= at.getTime() &&
      row.expiresAt.getTime() > at.getTime(),
  );
  if (effective.length === 0) {
    if (inScope.some((row) => row.revocationState !== 'ACTIVE')) {
      return { ok: false, reason: 'AUTHORIZATION_REVOKED' };
    }
    return { ok: false, reason: 'AUTHORIZATION_NOT_EFFECTIVE' };
  }
  if (effective.length > 1) return { ok: false, reason: 'AUTHORIZATION_AMBIGUOUS' };
  return { ok: true, record: effective[0]! };
}

/**
 * 构造只读权威可信事实适配器。
 * 注意：本适配器**不接受**任何候选载荷 / 模型输出 / 外部输入 —— 调用参数不参与事实判定。
 */
export function createTrustedFactsAdapter(input: {
  readPort: TrustedFactsReadPort;
  executionContext: TrustedExecutionContext;
  now?: () => Date;
}): TrustedFactsAdapter {
  const now = (): Date => (input.now ?? (() => new Date()))();

  return {
    async resolve(request): Promise<TrustedFactsResolution> {
      const at = now();
      const organizationId = trimOrEmpty(request.organizationId);
      const subjectRef = trimOrEmpty(input.executionContext.subjectRef);
      const caller = trimOrEmpty(input.executionContext.caller);

      // ① 租户上下文与执行上下文必须齐备（fail-closed）
      if (organizationId === '' || subjectRef === '') return fail('TENANT_CONTEXT_REQUIRED');

      // ② CHANGE 19：调用方白名单（服务端注入的 caller；白名单外不得继续）
      if (!(TRUSTED_FACTS_CALLERS as readonly string[]).includes(caller)) return fail('CALLER_NOT_TRUSTED');

      if (input.executionContext.operationRecheck === 'NOT_CONFIRMED') {
        return fail('OPERATION_RECHECK_NOT_CONFIRMED');
      }

      // ③ CHANGE 24：服务端动作策略决定必需范围维度；必需维度必须由可信上下文提供
      const policy = TRUSTED_FACTS_ACTION_SCOPE_POLICY[trimOrEmpty(request.actionType)];
      if (policy === undefined) return fail('SCOPE_POLICY_NOT_DEFINED');
      const trustedScope = input.executionContext.resourceScope;
      if (missingRequiredScopeDimensions(policy, trustedScope).length > 0) return fail('REQUIRED_SCOPE_MISSING');

      // ④ CHANGE 18：金额 / 币种显式规则（先做形态校验，再进只读事务）
      const monetary = parseMonetaryInput(request);
      if (!monetary.ok) return fail('MONETARY_INPUT_INVALID');

      // ⑤ CHANGE 20：全部读取置于**只读事务**内
      return input.readPort.withReadOnlyTransaction(async (): Promise<TrustedFactsResolution> => {
        const organization = await input.readPort.findOrganization({ organizationId });
        if (organization === null) return fail('ORGANIZATION_NOT_FOUND');

        const rows = await input.readPort.listStandingAuthorizations({ organizationId });
        const selection = selectAuthorization(rows, request.actionType, trustedScope, at);
        if (!selection.ok) return fail(selection.reason);
        const authorization = selection.record;

        // CHANGE 18：金额动作时，授权行币种须为 USD，且金额不得超过授权上限
        if (monetary.amountUsd !== null) {
          if (trimOrEmpty(authorization.currency).toUpperCase() !== 'USD') return fail('MONETARY_INPUT_INVALID');
          if (exceedsMonetaryLimit(monetary.amountUsd, authorization.monetaryLimitUsd)) {
            return fail('MONETARY_LIMIT_EXCEEDED');
          }
        }

        const factVersion = `org:${organization.identityVersion ?? 'NA'}|auth:${authorization.authorizationVersion}`;

        // CHANGE 19：调用方声明的事实版本必须与本次读取一致，否则视为陈旧事实
        if (request.expectedFactVersion !== undefined) {
          if (trimOrEmpty(request.expectedFactVersion) !== factVersion) return fail('STALE_FACT_VERSION');
        }

        const providedDimensions = TRUSTED_FACTS_SCOPE_DIMENSIONS.filter((dimension) => {
          const value = trustedScope === undefined ? undefined : trustedScope[dimension];
          return typeof value === 'string' && value.trim() !== '';
        });

        const provenance: TrustedFactsProvenance = {
          organizationIdResolved: {
            source: 'TRUSTED_PERSISTED_IDENTITY',
            resolvedFrom: 'Organization',
            subjectRef,
            identityVersion: organization.identityVersion,
            resolvedAt: at.toISOString(),
          },
          authorizationActive: {
            source: 'SERVER_AUTHORIZATION_STATE',
            resolvedFrom: 'StandingAuthorization',
            authorizationId: authorization.authorizationId,
            authorizationVersion: authorization.authorizationVersion,
            scopeDigest: authorization.scopeDigest,
            currency: authorization.currency,
            resolvedAt: at.toISOString(),
          },
          callerBoundary: {
            source: 'TRUSTED_EXECUTION_CONTEXT',
            caller,
            trusted: true,
            resolvedAt: at.toISOString(),
          },
          scopePolicy: {
            source: 'SERVER_ACTION_POLICY',
            actionType: trimOrEmpty(request.actionType),
            required: policy.required,
            optional: policy.optional,
            providedDimensions,
            resolvedAt: at.toISOString(),
          },
          operationRecheck: {
            source: 'TRUSTED_EXECUTION_CONTEXT',
            subjectRef,
            recheck: input.executionContext.operationRecheck,
            resolvedAt: at.toISOString(),
          },
          readScope: {
            source: 'READ_ONLY_TRANSACTION',
            statement: READ_ONLY_TRANSACTION_SQL,
            coveredReads: ['Organization.findUnique', 'StandingAuthorization.findMany'],
            resolvedAt: at.toISOString(),
          },
          factVersion,
        };

        const facts: TriageTrustedFacts = {
          organizationIdResolved: true,
          authorizationActive: true,
          operationRecheck: input.executionContext.operationRecheck,
        };
        return { ok: true, facts, provenance };
      });
    },
  };
}

/**
 * CHANGE 20 / 25：在**只读事务**内执行回调（`SET TRANSACTION READ ONLY` 是事务内第一条语句）。
 * 事务内任何写入（INSERT / UPDATE / DELETE / DDL）都会被 PostgreSQL 直接拒绝 —— 这是可执行的只读证据。
 */
export async function runInReadOnlyTransaction<T>(
  prisma: PrismaClient,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(READ_ONLY_TRANSACTION_SQL);
    return run(tx);
  });
}

/**
 * 只读端口实现（Prisma）：**只使用 SELECT**（findUnique / findMany），不调用任何写方法。
 * `identityVersion` 取 `updatedAt` 的 ISO 串作为身份修订信号（**仅为行修订信号**，
 * 不等价于完整单调版本；完整版本单调性属于 U2 及之后的授权范围）。
 */
export function createPrismaTrustedFactsReadPort(input: { prisma: PrismaClient }): TrustedFactsReadPort {
  let activeTransaction: Prisma.TransactionClient | null = null;
  const db = (): Prisma.TransactionClient => activeTransaction ?? (input.prisma as unknown as Prisma.TransactionClient);

  return {
    async findOrganization({ organizationId }) {
      const row = await db().organization.findUnique({
        where: { id: organizationId },
        select: { id: true, updatedAt: true },
      });
      if (row === null) return null;
      return { id: row.id, identityVersion: row.updatedAt.toISOString() };
    },
    async listStandingAuthorizations({ organizationId }) {
      const rows = await db().standingAuthorization.findMany({
        where: { organizationId },
        orderBy: { authorizationVersion: 'desc' },
        select: {
          id: true,
          authorizationVersion: true,
          revocationState: true,
          effectiveAt: true,
          expiresAt: true,
          allowedActionTypes: true,
          monetaryLimitUsd: true,
          currency: true,
          provider: true,
          platformAccountId: true,
          domain: true,
          jurisdiction: true,
          scopeDigest: true,
        },
      });
      return rows.map((row) => ({
        authorizationId: row.id,
        authorizationVersion: row.authorizationVersion,
        revocationState: row.revocationState,
        effectiveAt: row.effectiveAt,
        expiresAt: row.expiresAt,
        // `allowedActionTypes` 在 schema 中是 Json：只接受字符串数组（形态异常 ⇒ 空集 ⇒ 命中 fail-closed）
        allowedActionTypes: Array.isArray(row.allowedActionTypes)
          ? row.allowedActionTypes.filter((value): value is string => typeof value === 'string')
          : [],
        monetaryLimitUsd: String(row.monetaryLimitUsd),
        currency: row.currency,
        provider: row.provider,
        platformAccountId: row.platformAccountId,
        domain: row.domain,
        jurisdiction: row.jurisdiction,
        scopeDigest: row.scopeDigest,
      }));
    },
    async withReadOnlyTransaction(run) {
      // 已在只读事务内 ⇒ 复用（不得嵌套开启第二个事务）
      if (activeTransaction !== null) return run(activeTransaction);
      return runInReadOnlyTransaction(input.prisma, async (tx) => {
        activeTransaction = tx;
        try {
          // 回调收到的是**同一个**只读事务句柄（CHANGE 25：公共入口证据可在该事务内验证写入被拒）
          return await run(tx);
        } finally {
          activeTransaction = null;
        }
      });
    },
  };
}

/** U1 边界声明（源码级断言用；与运行时行为对应）。 */
export const TRUSTED_FACTS_ADAPTER_BOUNDARY = {
  readOnly: true,
  performsWrites: false,
  createsTasks: false,
  createsCandidates: false,
  acquiresLeases: false,
  invokesRuntime: false,
  performsExternalWrites: false,
  acceptsRequestOrModelInput: false,
  requiresServerTenantContext: true,
  requiresTrustedExecutionContext: true,
  failClosedOnUnresolvedFacts: true,
  runtimeSourceIsolationImplemented: false,
  /** CHANGE 17–20 */
  requiresCallerAllowlist: true,
  requiresExplicitMonetaryAction: true,
  failsClosedOnAuthorizationConflict: true,
  supportsExpectedFactVersion: true,
  allReadsInsideReadOnlyTransaction: true,
  /** CHANGE 24 */
  requiresServerScopePolicy: true,
  requiresTrustedResourceScope: true,
  scopeValuesFromTrustedContextOnly: true,
} as const;
