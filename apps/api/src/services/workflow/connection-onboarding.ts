/**
 * TRACK B BATCH 3 —— Connection Onboarding / Explicit Rebind.
 * ---------------------------------------------------------------
 * 授权：MSG-20261002-77（BATCH 2 = PASS/CLOSED；BATCH 3 = AUTHORIZED）。
 *
 * 冻结不变量：
 *   B3-1  新建 account-scoped SourceConnection 必须显式 bind existing PlatformAccount
 *         或 server-verified create + bind；禁止创建 ACTIVE + platformAccountId = NULL。
 *   B3-2  legacy unbound（platformAccountId = NULL）= READ-ONLY FROZEN；
 *         只能通过显式 rebind（same tenant + 明确 target + 已认证 actor + 授权 + audit）转正，
 *         且 rebind 只改变未来 connection 行为，不修改任何历史事实。
 *   B3-3  PlatformAccount identity 只来自可信平台数据：
 *         organizationId + platform + externalAccountId + identityVersion；
 *         displayName 只是展示名，绝不是 canonical identity；禁止 label/channel 推断。
 *   B3-4  connection 状态语义（复用现有 SourceConnectionStatus，不引入新状态字段）：
 *         BOUND_ACTIVE   = platformAccountId != NULL 且 status = ACTIVE → 允许 ingest / sync；
 *         BOUND_INACTIVE = platformAccountId != NULL 且 status != ACTIVE → 已绑定但未启用；
 *         UNBOUND        = platformAccountId = NULL → 只读冻结，不得产生新的 account-scoped facts。
 *   B3-5  audit：source_connection.bound_to_platform_account 记录绑定事实；
 *         create-and-bind 额外记录 platform_account.created；永不写入 secret / credential body。
 *   B3-6  ACCOUNT_BINDING_IMMUTABLE 保持（DB trigger 已禁止已绑定值再改）；
 *         legacy rebind 是唯一受控例外：NULL → concrete account，一次性。
 *
 * 边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF ·
 *       external payment write = OFF · R13 HOLD · TRANSPORT = false · 无生产凭据。
 */

import {
  Channel,
  Platform,
  Prisma,
  RecoveryDomain,
  SourceConnectionKind,
  type PrismaClient,
} from '@prisma/client';

import { initialStatusFor } from '../acquisition';
import { prepareAuditInsert } from '../audit';
import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';
import {
  assertCredentialRef,
  assertEnum,
  assertLabel,
  assertPlatform,
} from './connection-management';

/** 与 account-lineage/policy.ts 同名的 stable code（语义一致：无法唯一确定 canonical PlatformAccount）。 */
export const PLATFORM_ACCOUNT_REQUIRED = 'PLATFORM_ACCOUNT_REQUIRED';

/** 已绑定连接不得再改绑（DB trigger cc_account_binding_immutable__SourceConnection 的 service 侧镜像）。 */
export const ACCOUNT_BINDING_IMMUTABLE = 'ACCOUNT_BINDING_IMMUTABLE';

const CHANNELS = Object.values(Channel) as readonly string[];
const DOMAINS = Object.values(RecoveryDomain) as readonly string[];
const PLATFORMS = Object.values(Platform) as readonly string[];

/** 与既有 managed connection 创建路径保持同一可创建范围。 */
export const ONBOARDING_CREATABLE_KINDS: readonly string[] = ['FILE_UPLOAD', 'API'];

const EXTERNAL_ACCOUNT_ID_MAX = 190;
const IDENTITY_VERSION_MAX = 32;
const DISPLAY_NAME_MAX = 190;

export interface ConnectionOnboardingActor {
  organizationId: string;
  actorUserId: string;
  role: string;
}

export interface ConnectionOnboardingDeps {
  registeredPlatforms?: readonly string[];
  now?: () => Date;
}

/**
 * B3-1 / B3-3：创建连接时如何取得 canonical PlatformAccount。
 * 两种模式都必须由服务端验证；调用方**不能**直接提交一个未经校验的 account 作为事实来源。
 */
export type ConnectionAccountBinding =
  | { mode: 'BIND_EXISTING'; platformAccountId: string }
  | {
      mode: 'CREATE_AND_BIND';
      platform: Platform;
      externalAccountId: string;
      identityVersion?: string;
      displayName: string;
      marketplace?: string | null;
      region?: string | null;
    };

export type ConnectionAccountState = 'BOUND_ACTIVE' | 'BOUND_INACTIVE' | 'UNBOUND';

/**
 * B3-4：连接的 account 状态语义（复用现有 status，不引入新字段）。
 * UNBOUND 只应当是 legacy 行 —— 新连接一律经 onboarding 绑定后才存在。
 */
export function connectionAccountState(row: {
  status: string;
  platformAccountId: string | null;
}): ConnectionAccountState {
  if (row.platformAccountId === null) return 'UNBOUND';
  return row.status === 'ACTIVE' ? 'BOUND_ACTIVE' : 'BOUND_INACTIVE';
}

/**
 * B3-4 gate：只有 BOUND_ACTIVE 连接可以运行 ingest / sync 等会生成 account-scoped facts 的动作。
 * 未绑定（无论 status）一律 fail-closed；已绑定但未 ACTIVE 的连接同样不得产出新事实。
 */
export function assertConnectionUsableForActiveFacts(row: {
  status: string;
  platformAccountId: string | null;
}): string {
  if (row.platformAccountId === null) {
    throw new WorkflowError(
      PLATFORM_ACCOUNT_REQUIRED,
      'PLATFORM_ACCOUNT_REQUIRED: 连接未绑定 PlatformAccount（legacy unbound = READ-ONLY FROZEN），不得执行 ingest / sync',
    );
  }
  if (row.status !== 'ACTIVE') {
    throw new WorkflowError(
      'CONNECTION_NOT_ACTIVE',
      'CONNECTION_NOT_ACTIVE: 连接尚未处于 ACTIVE（绑定未启用或已暂停），不得执行 ingest / sync',
    );
  }
  return row.platformAccountId;
}

function assertAccountBinding(binding: unknown): ConnectionAccountBinding {
  if (!binding || typeof binding !== 'object') {
    throw new WorkflowError(
      PLATFORM_ACCOUNT_REQUIRED,
      'PLATFORM_ACCOUNT_REQUIRED: 新建 account-scoped 连接必须显式绑定或创建 PlatformAccount（禁止 ACTIVE + platformAccountId=NULL）',
    );
  }
  const candidate = binding as Record<string, unknown>;
  if (candidate.mode === 'BIND_EXISTING') {
    const platformAccountId =
      typeof candidate.platformAccountId === 'string' ? candidate.platformAccountId.trim() : '';
    if (!platformAccountId) {
      throw new WorkflowError(PLATFORM_ACCOUNT_REQUIRED, 'PLATFORM_ACCOUNT_REQUIRED: BIND_EXISTING 必须提供 platformAccountId');
    }
    return { mode: 'BIND_EXISTING', platformAccountId };
  }
  if (candidate.mode === 'CREATE_AND_BIND') {
    const platform = assertEnum<Platform>(candidate.platform, PLATFORMS, 'account.platform');
    const externalAccountId =
      typeof candidate.externalAccountId === 'string' ? candidate.externalAccountId.trim() : '';
    if (!externalAccountId || externalAccountId.length > EXTERNAL_ACCOUNT_ID_MAX) {
      throw new WorkflowError(
        'INVALID_INPUT',
        'account.externalAccountId 必须为 1..' + EXTERNAL_ACCOUNT_ID_MAX + ' 个字符',
      );
    }
    const displayName =
      typeof candidate.displayName === 'string' ? candidate.displayName.trim() : '';
    if (!displayName || displayName.length > DISPLAY_NAME_MAX) {
      throw new WorkflowError(
        'INVALID_INPUT',
        'account.displayName 必须为 1..' + DISPLAY_NAME_MAX + ' 个字符',
      );
    }
    const identityVersion =
      typeof candidate.identityVersion === 'string' && candidate.identityVersion.trim() !== ''
        ? candidate.identityVersion.trim()
        : 'v1';
    if (identityVersion.length > IDENTITY_VERSION_MAX) {
      throw new WorkflowError('INVALID_INPUT', 'account.identityVersion 过长');
    }
    return {
      mode: 'CREATE_AND_BIND',
      platform,
      externalAccountId,
      identityVersion,
      displayName,
      marketplace: typeof candidate.marketplace === 'string' ? candidate.marketplace : null,
      region: typeof candidate.region === 'string' ? candidate.region : null,
    };
  }
  throw new WorkflowError(
    PLATFORM_ACCOUNT_REQUIRED,
    'PLATFORM_ACCOUNT_REQUIRED: account 绑定模式必须是 BIND_EXISTING 或 CREATE_AND_BIND',
  );
}

type Tx = Prisma.TransactionClient;

interface AuditEntry {
  organizationId: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  changes: Record<string, unknown>;
  at: Date;
}

async function writeUserAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  const row = prepareAuditInsert(
    {
      organizationId: entry.organizationId,
      actorType: 'USER',
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      changes: entry.changes,
    },
    { maxStringLength: 512 },
  );
  await tx.auditLog.create({
    data: {
      organizationId: row.organizationId,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      actorRef: row.actorRef,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: entry.at,
    },
  });
}

/**
 * B3-1 / B3-3：解析（或创建）canonical PlatformAccount。
 * - BIND_EXISTING：必须存在于同一租户，否则 fail-closed（跨租户由 DB trigger 再次兜底）。
 * - CREATE_AND_BIND：identity = organizationId + platform + externalAccountId + identityVersion；
 *   完全相同 identity 已存在时复用既有行（exact match、same tenant、exactly one），不制造重复账户；
 *   displayName 只作展示名，不参与 identity。
 */
async function resolveOrCreatePlatformAccount(
  tx: Tx,
  input: { organizationId: string; binding: ConnectionAccountBinding },
): Promise<{ platformAccountId: string; created: boolean; externalAccountId: string | null }> {
  if (input.binding.mode === 'BIND_EXISTING') {
    const account = await tx.platformAccount.findFirst({
      where: { id: input.binding.platformAccountId, organizationId: input.organizationId },
      select: { id: true, externalAccountId: true },
    });
    if (!account) {
      throw new WorkflowError(
        PLATFORM_ACCOUNT_REQUIRED,
        'PLATFORM_ACCOUNT_REQUIRED: PlatformAccount 不存在或不属于该租户（禁止跨租户绑定，禁止猜测式归属）',
      );
    }
    return { platformAccountId: account.id, created: false, externalAccountId: account.externalAccountId };
  }
  const existing = await tx.platformAccount.findFirst({
    where: {
      organizationId: input.organizationId,
      platform: input.binding.platform,
      externalAccountId: input.binding.externalAccountId,
      identityVersion: input.binding.identityVersion,
    },
    select: { id: true, externalAccountId: true },
  });
  if (existing) {
    return { platformAccountId: existing.id, created: false, externalAccountId: existing.externalAccountId };
  }
  const created = await tx.platformAccount.create({
    data: {
      organizationId: input.organizationId,
      platform: input.binding.platform,
      externalAccountId: input.binding.externalAccountId,
      identityVersion: input.binding.identityVersion,
      displayName: input.binding.displayName,
      marketplace: input.binding.marketplace ?? null,
      region: input.binding.region ?? null,
    },
    select: { id: true, externalAccountId: true },
  });
  return { platformAccountId: created.id, created: true, externalAccountId: created.externalAccountId };
}

export interface OnboardConnectionInput extends ConnectionOnboardingActor {
  label: unknown;
  kind: unknown;
  domain: unknown;
  channel: unknown;
  platform?: unknown;
  credentialRef?: unknown;
  account: unknown;
}

export interface OnboardConnectionResult {
  id: string;
  status: string;
  platformAccountId: string;
  platformAccountCreated: boolean;
}

/**
 * B3-1 / B3-3 / B3-4 / B3-5：唯一允许创建 account-scoped 连接的正规入口。
 * 不提供「先建 ACTIVE、后补 account」的路径 —— 未绑定连接只能以 legacy 数据存在并保持只读冻结。
 */
export async function createAccountScopedConnection(
  prisma: PrismaClient,
  input: OnboardConnectionInput,
  deps: ConnectionOnboardingDeps = {},
): Promise<OnboardConnectionResult> {
  assertPermission(input.role, 'manageConnections');

  const label = assertLabel(input.label);
  const kind = assertEnum<SourceConnectionKind>(input.kind, ONBOARDING_CREATABLE_KINDS, 'kind');
  const domain = assertEnum<RecoveryDomain>(input.domain, DOMAINS, 'domain');
  const channel = assertEnum<Channel>(input.channel, CHANNELS, 'channel');
  const credentialRef = assertCredentialRef(input.credentialRef);
  const platform = assertPlatform({
    kind,
    platform: input.platform,
    registeredPlatforms: deps.registeredPlatforms ?? [],
  });
  if (kind === 'API' && credentialRef === null) {
    throw new WorkflowError('INVALID_INPUT', 'API 连接必须提供 credentialRef（引用名，不是密钥）');
  }
  const binding = assertAccountBinding(input.account);
  const status = initialStatusFor(kind);
  const at = (deps.now ?? (() => new Date()))();

  return prisma.$transaction(async (tx) => {
    const existing = await tx.sourceConnection.findFirst({
      where: { organizationId: input.organizationId, channel, label },
      select: { id: true },
    });
    if (existing) {
      throw new WorkflowError('DUPLICATE_CONNECTION', '同一渠道下已存在同名连接：' + label);
    }

    const bound = await resolveOrCreatePlatformAccount(tx, {
      organizationId: input.organizationId,
      binding,
    });

    const created = await tx.sourceConnection.create({
      data: {
        organizationId: input.organizationId,
        domain,
        channel,
        kind,
        label,
        credentialRef,
        status,
        platformAccountId: bound.platformAccountId,
        ...(platform ? { config: { platform } } : {}),
      },
      select: { id: true },
    });

    await writeUserAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'source_connection.created',
      entityType: 'SourceConnection',
      entityId: created.id,
      changes: {
        kind,
        label,
        domain,
        channel,
        status,
        platform,
        platformAccountId: bound.platformAccountId,
        bindingMode: binding.mode,
        hasCredentialRef: credentialRef !== null,
      },
      at,
    });

    await writeUserAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'source_connection.bound_to_platform_account',
      entityType: 'SourceConnection',
      entityId: created.id,
      changes: {
        organizationId: input.organizationId,
        connectionId: created.id,
        platformAccountId: bound.platformAccountId,
        actorUserId: input.actorUserId,
        actorType: 'USER',
        previousBinding: null,
        newBinding: bound.platformAccountId,
        reason: binding.mode,
        bindingSource:
          binding.mode === 'BIND_EXISTING' ? 'ONBOARDING_BIND_EXISTING' : 'ONBOARDING_CREATE_AND_BIND',
        externalAccountId: bound.externalAccountId,
        historicalFactsTouched: false,
        at: at.toISOString(),
      },
      at,
    });

    if (bound.created && binding.mode === 'CREATE_AND_BIND') {
      await writeUserAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: 'platform_account.created',
        entityType: 'PlatformAccount',
        entityId: bound.platformAccountId,
        changes: {
          platform: binding.platform,
          externalAccountId: binding.externalAccountId,
          identityVersion: binding.identityVersion,
          marketplace: binding.marketplace ?? null,
          region: binding.region ?? null,
          actorUserId: input.actorUserId,
          at: at.toISOString(),
        },
        at,
      });
    }

    return {
      id: created.id,
      status,
      platformAccountId: bound.platformAccountId,
      platformAccountCreated: bound.created,
    };
  });
}

export interface RebindLegacyConnectionInput extends ConnectionOnboardingActor {
  connectionId: string;
  targetPlatformAccountId: unknown;
  reason?: unknown;
}

export interface RebindLegacyConnectionResult {
  id: string;
  platformAccountId: string;
}

/**
 * B3-2 / B3-5 / B3-6：legacy unbound 连接的显式一次性追认。
 * 只允许 NULL → concrete account，并且只影响未来行为：
 *   · 不修改任何历史 SourceTransaction.accountId；
 *   · 不修改任何历史 CanonicalFact / RecoveryOpportunity / ClaimItem accountId；
 *   · 不做任何历史 backfill / 追溯归属。
 * 已绑定的连接再次 rebind（含 A → B）一律 ACCOUNT_BINDING_IMMUTABLE。
 */
export async function rebindLegacyConnection(
  prisma: PrismaClient,
  input: RebindLegacyConnectionInput,
  deps: ConnectionOnboardingDeps = {},
): Promise<RebindLegacyConnectionResult> {
  assertPermission(input.role, 'manageConnections');
  const target =
    typeof input.targetPlatformAccountId === 'string' ? input.targetPlatformAccountId.trim() : '';
  if (!target) {
    throw new WorkflowError(PLATFORM_ACCOUNT_REQUIRED, 'PLATFORM_ACCOUNT_REQUIRED: rebind 必须显式指定 target PlatformAccount');
  }
  const reason =
    typeof input.reason === 'string' && input.reason.trim() !== ''
      ? input.reason.trim().slice(0, 200)
      : null;
  const at = (deps.now ?? (() => new Date()))();

  return prisma.$transaction(async (tx) => {
    const connection = await tx.sourceConnection.findFirst({
      where: { id: input.connectionId, organizationId: input.organizationId },
      select: { id: true, status: true, platformAccountId: true },
    });
    if (!connection) {
      throw new WorkflowError('NOT_FOUND', '连接 ' + input.connectionId + ' 不存在或不属于该租户');
    }
    if (connection.platformAccountId !== null) {
      throw new WorkflowError(
        ACCOUNT_BINDING_IMMUTABLE,
        'ACCOUNT_BINDING_IMMUTABLE: 连接已绑定 PlatformAccount；绑定不可变（只允许一次 legacy NULL → account 追认，不允许 A → B）',
      );
    }

    const account = await tx.platformAccount.findFirst({
      where: { id: target, organizationId: input.organizationId },
      select: { id: true, externalAccountId: true },
    });
    if (!account) {
      throw new WorkflowError(
        PLATFORM_ACCOUNT_REQUIRED,
        'PLATFORM_ACCOUNT_REQUIRED: PlatformAccount 不存在或不属于该租户（禁止跨租户追认）',
      );
    }

    // CAS：只从「仍然是 NULL」这一事实追认，避免并发 rebind 互相覆盖。
    const updated = await tx.sourceConnection.updateMany({
      where: {
        id: connection.id,
        organizationId: input.organizationId,
        platformAccountId: null,
      },
      data: { platformAccountId: account.id },
    });
    if (updated.count !== 1) {
      throw new WorkflowError(
        ACCOUNT_BINDING_IMMUTABLE,
        'ACCOUNT_BINDING_IMMUTABLE: 连接绑定已被其他操作改变，请刷新后重试',
      );
    }

    await writeUserAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'source_connection.bound_to_platform_account',
      entityType: 'SourceConnection',
      entityId: connection.id,
      changes: {
        organizationId: input.organizationId,
        connectionId: connection.id,
        platformAccountId: account.id,
        actorUserId: input.actorUserId,
        actorType: 'USER',
        previousBinding: null,
        newBinding: account.id,
        externalAccountId: account.externalAccountId,
        reason: reason ?? 'LEGACY_REBIND',
        bindingSource: 'LEGACY_EXPLICIT_REBIND',
        historicalFactsTouched: false,
        at: at.toISOString(),
      },
      at,
    });

    return { id: connection.id, platformAccountId: account.id };
  });
}
