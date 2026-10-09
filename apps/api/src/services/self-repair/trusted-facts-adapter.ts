/**
 * PHASE 3-A · U1（只读）—— 权威可信事实读取适配器
 * ---------------------------------------------------------------
 * 授权依据：MSG-20261009-14（`PHASE3_A_MINIMAL_SCOPE_AUTHORIZED = YES`，授权单元 = `U1_READ_ONLY_SUBSET`）。
 *
 * **只读边界（硬约束）**：
 *   · 只执行 **SELECT** 类读取（Organization 存在性 + StandingAuthorization 当前状态）；
 *   · **不写**任何业务表、不创建候选/任务、不获取租约、不调用运行时、不产生外部副作用；
 *   · 不新增 Scheduler / Controller / Runtime；不改既有队列语义；不改 Prisma schema / migration。
 *
 * **不可伪造的输入契约**：
 *   · `organizationId` 必须来自**服务端会话/授权上下文**（本适配器**不接受**候选载荷参数，
 *     因此候选载荷 / 请求体 / 模型输出在类型层面就无法被当作可信身份传入）；
 *   · `executionContext` 必须由**可信执行上下文**注入（运行时成员），不接受请求或模型输入；
 *   · 任一项无法由可信来源确认 ⇒ fail-closed（返回 ok:false + 稳定原因码），**不猜、不降级**。
 *
 * 输出：`TriageTrustedFacts`（可直接喂给既有 `triageFaultIncident`）+ `provenance`（来源、主体、版本、读取时间）。
 */

import type { PrismaClient } from '@prisma/client';

import type {
  TriageTrustedFacts,
} from './fault-triage';

/** 只读读取端口（实现必须只有这两个读方法；不允许出现写方法）。 */
export interface TrustedFactsReadPort {
  /** 可信持久化身份关系：组织是否存在（含可选 identityVersion）。 */
  findOrganization(input: {
    organizationId: string;
  }): Promise<{ id: string; identityVersion: string | null } | null>;
  /** 服务端当前授权状态（唯一权威来源）。 */
  findStandingAuthorization(input: {
    organizationId: string;
    at: Date;
    actionType: string;
  }): Promise<{
    authorizationVersion: number;
    revocationState: string;
    effectiveAt: Date;
    expiresAt: Date;
    allowedActionTypes: readonly string[];
    monetaryLimitUsd: string;
    scopeDigest: string;
  } | null>;
}

/** 可信执行上下文（由运行时注入；**不得**来自请求 / 客户端 / 模型输出）。 */
export interface TrustedExecutionContext {
  /** 受信任的主体标识（例如运行时成员 ref）。 */
  subjectRef: string;
  /** 对「只读 / 幂等未生效 / 未确认」的再次确认结果。 */
  operationRecheck: 'CONFIRMED_READ_ONLY' | 'CONFIRMED_IDEMPOTENT_NOT_APPLIED' | 'NOT_CONFIRMED';
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
    authorizationVersion: number;
    scopeDigest: string;
    resolvedAt: string;
  } | null;
  operationRecheck: {
    source: 'TRUSTED_EXECUTION_CONTEXT';
    subjectRef: string;
    recheck: TrustedExecutionContext['operationRecheck'];
    resolvedAt: string;
  };
  /** 事实版本（用于快照作废判定；由授权版本 + 身份版本组成）。 */
  factVersion: string;
}

export type TrustedFactsFailureReason =
  | 'TENANT_CONTEXT_REQUIRED'
  | 'ORGANIZATION_NOT_FOUND'
  | 'AUTHORIZATION_NOT_FOUND'
  | 'AUTHORIZATION_REVOKED'
  | 'AUTHORIZATION_NOT_EFFECTIVE'
  | 'ACTION_TYPE_NOT_ALLOWED'
  | 'MONETARY_LIMIT_EXCEEDED'
  | 'OPERATION_RECHECK_NOT_CONFIRMED';

export type TrustedFactsResolution =
  | { ok: true; facts: TriageTrustedFacts; provenance: TrustedFactsProvenance }
  | { ok: false; reason: TrustedFactsFailureReason; provenance: TrustedFactsProvenance | null };

export interface TrustedFactsAdapter {
  resolve(input: {
    /** 必须由**服务端**提供（会话 / 授权上下文），不是候选载荷字段。 */
    organizationId: string;
    /** 待判定的动作类型（用于授权范围校验）。 */
    actionType: string;
    /** 可选：请求金额（USD 十进制字符串），用于限额校验。 */
    amountUsd?: string;
  }): Promise<TrustedFactsResolution>;
}

const fail = (
  reason: TrustedFactsFailureReason,
  provenance: TrustedFactsProvenance | null = null,
): TrustedFactsResolution => ({ ok: false, reason, provenance });

/** 十进制比较（字符串 → 分为单位比较，避免浮点误差）。 */
function exceedsLimit(amountUsd: string, limitUsd: string): boolean {
  const toMinor = (value: string): number => {
    const normalized = value.trim();
    if (!/^\d+(\.\d{1,4})?$/.test(normalized)) return Number.NaN;
    const [whole, fraction = ''] = normalized.split('.');
    return Number(whole) * 10_000 + Number(fraction.padEnd(4, '0').slice(0, 4));
  };
  const amount = toMinor(amountUsd);
  const limit = toMinor(limitUsd);
  if (Number.isNaN(amount) || Number.isNaN(limit)) return true; // 无法比较 ⇒ 视为超限（fail-closed）
  return amount > limit;
}

/**
 * 创建只读可信事实适配器。
 * 注意：本函数**不接受**任何候选载荷 / 请求 / 模型参数 —— 类型层面即阻断「把外部输入当可信身份」。
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
      const organizationId = typeof request.organizationId === 'string' ? request.organizationId.trim() : '';
      const subjectRef = input.executionContext.subjectRef.trim();

      // ① 服务端可信租户上下文 + 可信执行上下文必须齐备（fail-closed）
      if (organizationId === '' || subjectRef === '') return fail('TENANT_CONTEXT_REQUIRED');
      if (input.executionContext.operationRecheck === 'NOT_CONFIRMED') {
        return fail('OPERATION_RECHECK_NOT_CONFIRMED');
      }

      // ② 可信持久化身份关系：组织必须真实存在
      const organization = await input.readPort.findOrganization({ organizationId });
      if (organization === null) return fail('ORGANIZATION_NOT_FOUND');

      // ③ 服务端当前授权状态
      const authorization = await input.readPort.findStandingAuthorization({
        organizationId,
        at,
        actionType: request.actionType,
      });
      if (authorization === null) return fail('AUTHORIZATION_NOT_FOUND');
      if (authorization.revocationState !== 'ACTIVE') return fail('AUTHORIZATION_REVOKED');
      if (authorization.effectiveAt.getTime() > at.getTime() || authorization.expiresAt.getTime() <= at.getTime()) {
        return fail('AUTHORIZATION_NOT_EFFECTIVE');
      }
      if (!authorization.allowedActionTypes.includes(request.actionType)) {
        return fail('ACTION_TYPE_NOT_ALLOWED');
      }
      if (request.amountUsd !== undefined && exceedsLimit(request.amountUsd, authorization.monetaryLimitUsd)) {
        return fail('MONETARY_LIMIT_EXCEEDED');
      }

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
          authorizationVersion: authorization.authorizationVersion,
          scopeDigest: authorization.scopeDigest,
          resolvedAt: at.toISOString(),
        },
        operationRecheck: {
          source: 'TRUSTED_EXECUTION_CONTEXT',
          subjectRef,
          recheck: input.executionContext.operationRecheck,
          resolvedAt: at.toISOString(),
        },
        factVersion: `org:${organization.identityVersion ?? 'NA'}|auth:${authorization.authorizationVersion}`,
      };

      const facts: TriageTrustedFacts = {
        organizationIdResolved: true,
        authorizationActive: true,
        operationRecheck: input.executionContext.operationRecheck,
      };
      return { ok: true, facts, provenance };
    },
  };
}

/**
 * 只读端口实现（Prisma）：**只使用 findUnique / findFirst（SELECT）**，不含任何写操作。
 * `identityVersion` 目前取 `updatedAt` 的 ISO 串作为权威身份版本（不新增列、不改 schema）。
 */
export function createPrismaTrustedFactsReadPort(input: { prisma: PrismaClient }): TrustedFactsReadPort {
  return {
    async findOrganization({ organizationId }) {
      const row = await input.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { id: true, updatedAt: true },
      });
      if (row === null) return null;
      return { id: row.id, identityVersion: row.updatedAt.toISOString() };
    },
    async findStandingAuthorization({ organizationId }) {
      const row = await input.prisma.standingAuthorization.findFirst({
        where: { organizationId },
        orderBy: { authorizationVersion: 'desc' },
        select: {
          authorizationVersion: true,
          revocationState: true,
          effectiveAt: true,
          expiresAt: true,
          allowedActionTypes: true,
          monetaryLimitUsd: true,
          scopeDigest: true,
        },
      });
      if (row === null) return null;
      // `allowedActionTypes` 在 schema 中是 Json；这里只接受字符串数组（其余形态一律视为空集合 ⇒ 后续 fail-closed）
      const allowedActionTypes = Array.isArray(row.allowedActionTypes)
        ? row.allowedActionTypes.filter((value): value is string => typeof value === 'string')
        : [];
      return {
        authorizationVersion: row.authorizationVersion,
        revocationState: row.revocationState,
        effectiveAt: row.effectiveAt,
        expiresAt: row.expiresAt,
        allowedActionTypes,
        monetaryLimitUsd: String(row.monetaryLimitUsd),
        scopeDigest: row.scopeDigest,
      };
    },
  };
}

/** U1 边界声明（供审计与源码级断言）。 */
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
} as const;
