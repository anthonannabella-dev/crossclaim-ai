// AGENT EXPERIENCE LAYER / P0 — Standing Authorization 耐久承载（最小增量）
// ---------------------------------------------------------------------------
// 背景：SA-1 / SA-3 / SA-3b 已交付授权核心 + 判定 + 真实调用点接线，但**授权记录本身没有持久化承载**：
//   调用方只能注入 `loadAuthorization(query)` 端口，因此「客户一次授权 → 后台持续运行」在进程重启后
//   无法续用，也无法做到审计级「授权变更历史 / 撤销留痕」。
//
// 本模块按 `docs/releases/STANDING-AUTHORIZATION-PERSISTENCE-DELTA-REQUEST.md` 的最小 Delta 落库：
//   1 表（StandingAuthorization）· 追加式版本 · 撤销留痕 · tenant/account scoped ·
//   scope 字段写后不可改（迁移里的触发器兜底）· 复用既有 `StandingAuthorizationRecord` 语义。
//
// 硬边界（与 SA-1 一致，不因持久化而放宽）：
//   ① 只由 server-side 流程写入；客户端自报 scope 一律拒绝（`createStandingAuthorization` 强制 serverDerived）；
//   ② 不建第二套 approval / authorization / guard；最终执行权仍归既有 Action Guard；
//   ③ 已撤销 / 已过期 / 版本过期 / 范围不符 → 由既有判定 fail-closed（本模块只如实加载，不做放行决定）；
//   ④ 不给任何调用方授予 External Write 能力。

import { Prisma, type PrismaClient } from '@prisma/client';

import {
  createStandingAuthorization,
  type StandingAuthorizationRecord,
  type StandingAuthorizationState,
} from './standing-authorization';
import type { StandingAuthorizationResolverDeps } from './standing-authorization-resolver';

export const STANDING_AUTHORIZATION_STORE_VERSION = 'standing-authorization-store/v1';

export const STANDING_AUTHORIZATION_STATES: readonly StandingAuthorizationState[] = [
  'ACTIVE',
  'REVOKED',
  'SUSPENDED',
];

/** 创建授权的输入（与 `createStandingAuthorization` 完全同构，避免复制第二套字段定义） */
export type StandingAuthorizationDraft = Parameters<typeof createStandingAuthorization>[0];

export type StandingAuthorizationStoreErrorCode =
  | 'STANDING_AUTH_STORE_VERSION_CONFLICT'
  | 'STANDING_AUTH_STORE_NOT_FOUND'
  | 'STANDING_AUTH_STORE_INVALID_ROW';

export class StandingAuthorizationStoreError extends Error {
  readonly code: StandingAuthorizationStoreErrorCode;

  constructor(code: StandingAuthorizationStoreErrorCode, message: string) {
    super(message);
    this.name = 'StandingAuthorizationStoreError';
    this.code = code;
  }
}

/**
 * 数据库行形状（结构化，兼容 Prisma 生成的 Decimal / JsonValue 类型）。
 * `monetaryLimitUsd` 在 Prisma 里是 Decimal，在授权记录里是 number —— 由本模块统一换算。
 */
export interface StandingAuthorizationRow {
  id: string;
  organizationId: string;
  platformAccountId: string;
  provider: string;
  allowedActionTypes: unknown;
  monetaryLimitUsd: unknown;
  currency: string;
  domain: string;
  jurisdiction: string;
  effectiveAt: Date;
  expiresAt: Date;
  authorizationVersion: number;
  termsPolicyVersion: string;
  consentEvidenceRef: string;
  revocationState: string;
  revokedAt: Date | null;
  revokedBy: string | null;
  revocationReason: string | null;
  scopeDigest: string;
  createdAt: Date;
}

function parseAllowedActionTypes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  }
  throw new StandingAuthorizationStoreError(
    'STANDING_AUTH_STORE_INVALID_ROW',
    'allowedActionTypes 必须是字符串数组（授权落库数据损坏）。',
  );
}

/** 数据库行 → 既有授权记录（不改写 scope；scope digest 由既有判定在读取时复核） */
export function standingAuthorizationRowToRecord(row: StandingAuthorizationRow): StandingAuthorizationRecord {
  if (!(STANDING_AUTHORIZATION_STATES as readonly string[]).includes(row.revocationState)) {
    throw new StandingAuthorizationStoreError(
      'STANDING_AUTH_STORE_INVALID_ROW',
      'revocationState 非法：' + row.revocationState,
    );
  }
  const monetaryLimitUsd = Number(row.monetaryLimitUsd);
  if (!Number.isFinite(monetaryLimitUsd)) {
    throw new StandingAuthorizationStoreError(
      'STANDING_AUTH_STORE_INVALID_ROW',
      'monetaryLimitUsd 非法（无法换算为数值）。',
    );
  }
  return {
    kind: 'STANDING_AUTHORIZATION',
    authorizationId: row.id,
    organizationId: row.organizationId,
    platformAccountId: row.platformAccountId,
    provider: row.provider,
    allowedActionTypes: parseAllowedActionTypes(row.allowedActionTypes),
    monetaryLimitUsd,
    currency: row.currency,
    domain: row.domain,
    jurisdiction: row.jurisdiction,
    effectiveAt: row.effectiveAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    authorizationVersion: row.authorizationVersion,
    termsPolicyVersion: row.termsPolicyVersion,
    consentEvidenceRef: row.consentEvidenceRef,
    revocation: {
      state: row.revocationState as StandingAuthorizationState,
      revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
      revokedBy: row.revokedBy,
      reason: row.revocationReason,
    },
    scopeDigest: row.scopeDigest,
    serverDerived: true,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRowData(record: StandingAuthorizationRecord): Prisma.StandingAuthorizationUncheckedCreateInput {
  return {
    id: record.authorizationId,
    organizationId: record.organizationId,
    platformAccountId: record.platformAccountId,
    provider: record.provider,
    allowedActionTypes: [...record.allowedActionTypes],
    monetaryLimitUsd: new Prisma.Decimal(record.monetaryLimitUsd),
    currency: record.currency,
    domain: record.domain,
    jurisdiction: record.jurisdiction,
    effectiveAt: new Date(record.effectiveAt),
    expiresAt: new Date(record.expiresAt),
    authorizationVersion: record.authorizationVersion,
    termsPolicyVersion: record.termsPolicyVersion,
    consentEvidenceRef: record.consentEvidenceRef,
    revocationState: record.revocation.state,
    revokedAt: record.revocation.revokedAt === null ? null : new Date(record.revocation.revokedAt),
    revokedBy: record.revocation.revokedBy,
    revocationReason: record.revocation.reason,
    scopeDigest: record.scopeDigest,
    createdAt: new Date(record.createdAt),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export interface PersistStandingAuthorizationResult {
  kind: 'APPENDED' | 'REUSED';
  authorizationId: string;
  authorizationVersion: number;
  scopeDigest: string;
}

/**
 * 追加式落库（server-derived）。
 * 同 (organizationId, platformAccountId, provider, authorizationVersion) 幂等：
 *   - 已存在且 scopeDigest 相同 → REUSED（并发/重放不产生第二行）；
 *   - 已存在但 scopeDigest 不同 → 抛 VERSION_CONFLICT（禁止静默改写既有版本）。
 */
export async function persistStandingAuthorization(
  prisma: PrismaClient,
  draft: StandingAuthorizationDraft,
): Promise<PersistStandingAuthorizationResult> {
  const record = createStandingAuthorization(draft);
  const where = {
    organizationId: record.organizationId,
    platformAccountId: record.platformAccountId,
    provider: record.provider,
    authorizationVersion: record.authorizationVersion,
  };
  const existing = await prisma.standingAuthorization.findFirst({
    where,
    select: { id: true, scopeDigest: true },
  });
  if (existing) {
    if (existing.scopeDigest !== record.scopeDigest) {
      throw new StandingAuthorizationStoreError(
        'STANDING_AUTH_STORE_VERSION_CONFLICT',
        '同一 authorizationVersion 的 scopeDigest 不一致：禁止静默改写授权范围，请追加新版本。',
      );
    }
    return {
      kind: 'REUSED',
      authorizationId: existing.id,
      authorizationVersion: record.authorizationVersion,
      scopeDigest: record.scopeDigest,
    };
  }
  try {
    const created = await prisma.standingAuthorization.create({
      data: toRowData(record),
      select: { id: true, scopeDigest: true },
    });
    return {
      kind: 'APPENDED',
      authorizationId: created.id,
      authorizationVersion: record.authorizationVersion,
      scopeDigest: created.scopeDigest,
    };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await prisma.standingAuthorization.findFirst({
      where,
      select: { id: true, scopeDigest: true },
    });
    if (raced && raced.scopeDigest === record.scopeDigest) {
      return {
        kind: 'REUSED',
        authorizationId: raced.id,
        authorizationVersion: record.authorizationVersion,
        scopeDigest: raced.scopeDigest,
      };
    }
    throw new StandingAuthorizationStoreError(
      'STANDING_AUTH_STORE_VERSION_CONFLICT',
      '同一 authorizationVersion 的 scopeDigest 不一致：禁止静默改写授权范围，请追加新版本。',
    );
  }
}

export interface StandingAuthorizationLookup {
  organizationId: string;
  platformAccountId: string;
  provider: string;
}

/**
 * 读取该 scope 下的**最新版本**授权（含已撤销 / 已过期行 —— 由既有判定 fail-closed，
 * 这样「撤销后旧版本不得继续生效」不会退化成 `null` → 人工审批）。
 * 跨租户查询恒返回 `null`（tenant scoped）。
 */
export async function loadStandingAuthorization(
  prisma: PrismaClient,
  lookup: StandingAuthorizationLookup,
): Promise<StandingAuthorizationRecord | null> {
  const row = await prisma.standingAuthorization.findFirst({
    where: {
      organizationId: lookup.organizationId,
      platformAccountId: lookup.platformAccountId,
      provider: lookup.provider,
    },
    orderBy: { authorizationVersion: 'desc' },
  });
  return row === null ? null : standingAuthorizationRowToRecord(row);
}

/** 按 id 读取（仍强制 tenant scope，跨租户返回 `null`） */
export async function loadStandingAuthorizationById(
  prisma: PrismaClient,
  input: { organizationId: string; authorizationId: string },
): Promise<StandingAuthorizationRecord | null> {
  const row = await prisma.standingAuthorization.findFirst({
    where: { organizationId: input.organizationId, id: input.authorizationId },
  });
  return row === null ? null : standingAuthorizationRowToRecord(row);
}

/** 列出某租户（可选某账户）的全部授权版本（授权管理 UI / 审计用；只读） */
export async function listStandingAuthorizations(
  prisma: PrismaClient,
  input: { organizationId: string; platformAccountId?: string | null },
): Promise<StandingAuthorizationRecord[]> {
  const rows = await prisma.standingAuthorization.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.platformAccountId === undefined || input.platformAccountId === null
        ? {}
        : { platformAccountId: input.platformAccountId }),
    },
    orderBy: [{ provider: 'asc' }, { authorizationVersion: 'desc' }],
  });
  return rows.map((row) => standingAuthorizationRowToRecord(row));
}

export interface RevokeStandingAuthorizationResult {
  /** 本次实际撤销的版本数 */
  revoked: number;
  /** 此前已处于非 ACTIVE 的版本数（幂等重放） */
  alreadyInactive: number;
}

/**
 * 撤销某 scope 的**全部版本**（客户「撤销授权」＝该授权整体失效）。
 * 只写 revocation 四列（scope 列被触发器禁止改写）；重复撤销幂等。
 */
export async function revokeStandingAuthorizationScope(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    platformAccountId: string;
    provider: string;
    revokedBy: string;
    reason: string;
    at: Date;
  },
): Promise<RevokeStandingAuthorizationResult> {
  if (input.revokedBy.trim().length === 0 || input.reason.trim().length === 0) {
    throw new StandingAuthorizationStoreError(
      'STANDING_AUTH_STORE_NOT_FOUND',
      '撤销必须留痕：revokedBy 与 reason 均不得为空。',
    );
  }
  const scope = {
    organizationId: input.organizationId,
    platformAccountId: input.platformAccountId,
    provider: input.provider,
  };
  const rows = await prisma.standingAuthorization.findMany({
    where: scope,
    select: { id: true, revocationState: true },
  });
  if (rows.length === 0) {
    throw new StandingAuthorizationStoreError(
      'STANDING_AUTH_STORE_NOT_FOUND',
      '该 scope 下不存在授权记录。',
    );
  }
  const alreadyInactive = rows.filter((row) => row.revocationState !== 'ACTIVE').length;
  if (alreadyInactive === rows.length) {
    return { revoked: 0, alreadyInactive };
  }
  const result = await prisma.standingAuthorization.updateMany({
    where: { ...scope, revocationState: 'ACTIVE' },
    data: {
      revocationState: 'REVOKED',
      revokedAt: input.at,
      revokedBy: input.revokedBy,
      revocationReason: input.reason,
    },
  });
  return { revoked: result.count, alreadyInactive };
}

/**
 * 接入既有 `StandingAuthorizationResolverDeps.loadAuthorization` —— 调用点（hitl-submission /
 * action-pack-runtime 等）只需注入本 deps 即可让 SA-3b 的判定在进程重启后仍然可用。
 */
export function createPrismaStandingAuthorizationResolverDeps(
  prisma: PrismaClient,
): StandingAuthorizationResolverDeps {
  return {
    loadAuthorization: (query) => loadStandingAuthorization(prisma, query),
  };
}

export const STANDING_AUTHORIZATION_STORE_BOUNDARY = {
  version: STANDING_AUTHORIZATION_STORE_VERSION,
  durable: true,
  appendOnlyVersions: true,
  revocationIsTraced: true,
  scopeIsImmutable: true,
  tenantScoped: true,
  accountScoped: true,
  serverDerivedOnly: true,
  grantsExternalWrite: false,
  createsSecondApprovalSystem: false,
  createsSecondGuard: false,
  decisionStillOwnedByActionGuard: true,
  forbidden: [
    'silently rewriting the scope of an existing authorizationVersion',
    'accepting a client-supplied authorization scope',
    'deleting revoked authorization history',
    'treating a persisted authorization as external-write permission',
  ],
} as const;
