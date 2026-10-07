// AGENT EXPERIENCE LAYER / P9 —— OAuth 授权会话 + 连接同步检查点（真实 PostgreSQL）
// ---------------------------------------------------------------------------
// 覆盖：durable 会话（重启后仍可完成回调）· 原始 state 不落库 · 一次性 / 重放保护 ·
// 过期 fail-closed · callback 成功后绑定连接与 credentialRef 并保留 resumeGoalId ·
// 状态迁移 fail-closed · 连接检查点（成功推进 / 失败退避 / 连续失败转 NEEDS_REAUTH）·
// 跨租户隔离与数据库兜底。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CONNECTION_SYNC_RETRY_POLICY,
  computeSyncRetryState,
  listConnectionSyncStates,
  loadConnectionSyncState,
  recordConnectionSyncFailure,
  recordConnectionSyncSuccess,
} from '../services/connect/prisma-connection-sync-state';
import {
  OAuthSessionStoreError,
  createPrismaOAuthStateStore,
  failOAuthAuthorizationSession,
  initiateOAuthAuthorizationSession,
  loadOAuthAuthorizationSession,
  succeedOAuthAuthorizationSession,
} from '../services/connect/prisma-oauth-session-store';
import { resolveProviderContract } from '../services/connect/provider-integration-contract';
import { persistAgentGoal } from '../services/agent-goal';

const prisma = new PrismaClient();
const NOW = new Date('2026-10-07T06:00:00.000Z');
const ORG = 'ad111111-0000-4000-8000-00000000000a';
const ORG_B = 'ad111111-0000-4000-8000-00000000000b';
const USER = 'ad111111-0000-4000-8000-0000000000f1';

const CONTRACT = resolveProviderContract('AMAZON');
const CALLBACK = CONTRACT?.callbackPath ?? '/connect/callback';

async function truncate(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "ConnectionSyncState", "OAuthAuthorizationSession", "AgentGoalRun", "AgentGoal" RESTART IDENTITY CASCADE',
  );
}

async function seedOrganization(organizationId: string, name: string): Promise<void> {
  await prisma.organization.deleteMany({ where: { OR: [{ slug: name }, { id: organizationId }] } });
  await prisma.organization.create({ data: { id: organizationId, name, slug: name } });
}

async function seedConnection(organizationId: string, label: string): Promise<string> {
  await prisma.sourceConnection.deleteMany({ where: { organizationId, label } });
  // ACTIVE 连接必须绑定 PlatformAccount（既有数据库不变量）
  const account = await prisma.platformAccount.create({
    data: { organizationId, platform: 'AMAZON', externalAccountId: 'ext-' + label, displayName: label },
    select: { id: true },
  });
  const created = await prisma.sourceConnection.create({
    data: {
      organizationId,
      domain: 'PLATFORM',
      channel: 'AMAZON_FBA',
      kind: 'API',
      status: 'ACTIVE',
      label,
      platformAccountId: account.id,
    },
    select: { id: true },
  });
  return created.id;
}

beforeAll(async () => {
  await truncate();
  await seedOrganization(ORG, 'p9-org-a');
  await seedOrganization(ORG_B, 'p9-org-b');
});

beforeEach(async () => {
  await truncate();
});

afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

describe('P9 · OAuthAuthorizationSession（durable / 一次性 / 恢复原目标）', () => {
  it('PG-P9-1 发起会话：只落 state 摘要（不落原始 state），保留 resumeGoalId，一次性消费', async () => {
    // AEL-FINAL2 / C2：resumeGoalId 必须是同租户既有 AgentGoal（durable lineage，不是自由字符串）
    const resumeGoalId = (
      await persistAgentGoal(prisma, {
        organizationId: ORG,
        createdBy: USER,
        rawUserIntent: 'recover my Amazon reimbursements',
        normalizedGoal: { goalType: 'DISCOVER_AND_RECOVER', domains: ['PLATFORM'] },
        now: NOW,
      })
    ).goalId;
    const issued = await initiateOAuthAuthorizationSession(
      prisma,
      {
        organizationId: ORG,
        userId: USER,
        provider: 'AMAZON',
        callbackPath: CALLBACK,
        redirectTarget: '/connections',
        resumeGoalId: resumeGoalId,
        now: NOW,
      },
      { randomBytes: () => Buffer.alloc(32, 7) },
    );
    expect(issued.productionAuthorizationEnabled).toBe(false);
    expect(issued.bindExecuted).toBe(false);
    expect(issued.resumeGoalId).toBe(resumeGoalId);

    const rows = await prisma.oAuthAuthorizationSession.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].stateDigest).toHaveLength(64);
    expect(rows[0].stateDigest).not.toBe(issued.state);
    expect(JSON.stringify(rows[0])).not.toContain(issued.state);
    expect(rows[0].resumeGoalId).toBe(resumeGoalId);
    expect(rows[0].status).toBe('PENDING');

    const store = createPrismaOAuthStateStore(prisma, { now: () => NOW });
    const first = await store.take(issued.state);
    expect(first?.provider).toBe('AMAZON');
    const replay = await store.take(issued.state);
    expect(replay).toBeNull(); // 一次性：重放恒失败
    const unknown = await store.take('not-a-real-state');
    expect(unknown).toBeNull();
  });

  it('PG-P9-2 durable：新连接（进程重启等价）仍可完成消费；过期会话 fail-closed', async () => {
    const issued = await initiateOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      userId: USER,
      provider: 'AMAZON',
      callbackPath: CALLBACK,
      redirectTarget: '/connections',
      now: NOW,
    });

    const restarted = new PrismaClient();
    try {
      const store = createPrismaOAuthStateStore(restarted, { now: () => new Date(NOW.getTime() + 1000) });
      expect((await store.take(issued.state))?.provider).toBe('AMAZON');
    } finally {
      await restarted.$disconnect();
    }

    const expired = await initiateOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      userId: USER,
      provider: 'AMAZON',
      callbackPath: CALLBACK,
      redirectTarget: '/connections',
      ttlSeconds: 60,
      now: NOW,
    });
    const storeLater = createPrismaOAuthStateStore(prisma, { now: () => new Date(NOW.getTime() + 120_000) });
    expect(await storeLater.take(expired.state)).toBeNull();
  });

  it('PG-P9-3 callback 成功：绑定连接与 credentialRef，保留 resumeGoalId；失败不得转成功', async () => {
    // AEL-FINAL2 / C2：resumeGoalId 必须是同租户既有 AgentGoal（durable lineage，不是自由字符串）
    const resumeGoalId = (
      await persistAgentGoal(prisma, {
        organizationId: ORG,
        createdBy: USER,
        rawUserIntent: 'recover my Amazon reimbursements',
        normalizedGoal: { goalType: 'DISCOVER_AND_RECOVER', domains: ['PLATFORM'] },
        now: NOW,
      })
    ).goalId;
    const issued = await initiateOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      userId: USER,
      provider: 'AMAZON',
      callbackPath: CALLBACK,
      redirectTarget: '/connections',
      resumeGoalId: resumeGoalId,
      now: NOW,
    });
    const connectionId = await seedConnection(ORG, 'p9-conn-a');

    // AEL-FINAL2 / C2：成功必须先经一次性消费（PENDING → CONSUMED）
    const takeStore = createPrismaOAuthStateStore(prisma, { now: () => NOW });
    expect((await takeStore.take(issued.state))?.provider).toBe('AMAZON');

    const succeeded = await succeedOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      sessionId: issued.sessionId,
      connectionId,
      credentialRef: 'cred-ref-p9',
      now: NOW,
    });
    expect(succeeded.status).toBe('SUCCEEDED');
    expect(succeeded.connectionId).toBe(connectionId);
    expect(succeeded.credentialRef).toBe('cred-ref-p9');
    expect(succeeded.resumeGoalId).toBe(resumeGoalId);

    // 幂等：重复成功调用保持 SUCCEEDED
    const again = await succeedOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      sessionId: issued.sessionId,
      connectionId,
      credentialRef: 'cred-ref-p9',
      now: NOW,
    });
    expect(again.status).toBe('SUCCEEDED');

    const other = await initiateOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      userId: USER,
      provider: 'AMAZON',
      callbackPath: CALLBACK,
      redirectTarget: '/connections',
      now: NOW,
    });
    await failOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      sessionId: other.sessionId,
      reason: 'identity not verified',
      now: NOW,
    });
    await expect(
      succeedOAuthAuthorizationSession(prisma, {
        organizationId: ORG,
        sessionId: other.sessionId,
        connectionId,
        credentialRef: 'cred-ref-p9',
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(OAuthSessionStoreError);
  });

  it('PG-P9-4 跨租户：读取恒 null；成功 / 失败操作恒 NOT_FOUND', async () => {
    const issued = await initiateOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      userId: USER,
      provider: 'AMAZON',
      callbackPath: CALLBACK,
      redirectTarget: '/connections',
      now: NOW,
    });
    expect(await loadOAuthAuthorizationSession(prisma, { organizationId: ORG_B, sessionId: issued.sessionId })).toBeNull();
    await expect(
      succeedOAuthAuthorizationSession(prisma, {
        organizationId: ORG_B,
        sessionId: issued.sessionId,
        connectionId: 'x',
        credentialRef: 'y',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_SESSION_NOT_FOUND' });

    // state 摘要唯一 → 重复插入被数据库拒绝（重放保护兜底）
    const row = await prisma.oAuthAuthorizationSession.findFirst({ where: { organizationId: ORG } });
    await expect(
      prisma.oAuthAuthorizationSession.create({
        data: {
          organizationId: ORG,
          userId: USER,
          provider: 'AMAZON',
          callbackPath: CALLBACK,
          stateDigest: row!.stateDigest,
          redirectTarget: '/connections',
          status: 'PENDING',
          initiatedAt: NOW,
          expiresAt: new Date(NOW.getTime() + 600_000),
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    ).rejects.toThrow(/OAuthAuthorizationSession_org_state_key|Unique constraint/i);
  });
});

describe('P9 · ConnectionSyncState（检查点投影，不是第二事实源）', () => {
  it('PG-P9-5 成功推进检查点并清零失败；失败按纯函数退避；连续失败转 NEEDS_REAUTH', async () => {
    const connectionId = await seedConnection(ORG, 'p9-conn-sync');

    const ok = await recordConnectionSyncSuccess(prisma, {
      organizationId: ORG,
      connectionId,
      cursor: 'cursor-1',
      now: NOW,
    });
    expect(ok.cursor).toBe('cursor-1');
    expect(ok.retryState).toBe('IDLE');
    expect(ok.consecutiveFailures).toBe(0);

    const first = await recordConnectionSyncFailure(prisma, {
      organizationId: ORG,
      connectionId,
      error: 'upstream 503',
      now: NOW,
    });
    expect(first.consecutiveFailures).toBe(1);
    expect(first.retryState).toBe('BACKOFF');
    expect(first.nextRetryAt).not.toBeNull();
    // 检查点不被失败覆盖
    expect(first.cursor).toBe('cursor-1');

    let last = first;
    for (let i = 2; i <= CONNECTION_SYNC_RETRY_POLICY.needsReauthAfterFailures; i += 1) {
      last = await recordConnectionSyncFailure(prisma, {
        organizationId: ORG,
        connectionId,
        error: 'upstream 503',
        now: NOW,
      });
    }
    expect(last.consecutiveFailures).toBe(CONNECTION_SYNC_RETRY_POLICY.needsReauthAfterFailures);
    expect(last.retryState).toBe('NEEDS_REAUTH');
    expect(last.nextRetryAt).toBeNull();

    const reauth = await recordConnectionSyncFailure(prisma, {
      organizationId: ORG,
      connectionId,
      error: 'provider suspended',
      needsReauth: true,
      now: NOW,
    });
    expect(reauth.retryState).toBe('NEEDS_REAUTH');

    // 纯函数策略：0 次失败 = IDLE；否则指数退避且有上限
    expect(computeSyncRetryState({ consecutiveFailures: 0, now: NOW })).toEqual({ retryState: 'IDLE', nextRetryAt: null });
    const backoff = computeSyncRetryState({ consecutiveFailures: 3, now: NOW });
    expect(backoff.retryState).toBe('BACKOFF');
    expect(backoff.nextRetryAt!.getTime() - NOW.getTime()).toBe(
      CONNECTION_SYNC_RETRY_POLICY.baseDelayMs * 4,
    );
  });

  it('PG-P9-6 跨租户隔离 + 数据库兜底（连接不属于该租户 → 拒绝；读取恒空）', async () => {
    const connectionId = await seedConnection(ORG, 'p9-conn-iso');
    await recordConnectionSyncSuccess(prisma, { organizationId: ORG, connectionId, cursor: 'c', now: NOW });

    expect(await loadConnectionSyncState(prisma, { organizationId: ORG_B, connectionId })).toBeNull();
    expect(await listConnectionSyncStates(prisma, { organizationId: ORG_B })).toEqual([]);
    expect((await listConnectionSyncStates(prisma, { organizationId: ORG })).length).toBe(1);

    // 跨租户引用既有连接 → 租户触发器拒绝
    await expect(
      recordConnectionSyncSuccess(prisma, { organizationId: ORG_B, connectionId, cursor: 'x', now: NOW }),
    ).rejects.toThrow(/cross-tenant reference blocked|check_violation/i);
  });
});

describe('AEL FINAL2 / C2 · durable OAuth transition CAS', () => {
  it('PG-P9-7 PENDING 不得直接转 SUCCEEDED（必须先经一次性消费）', async () => {
    const issued = await initiateOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      userId: USER,
      provider: 'AMAZON',
      callbackPath: CALLBACK,
      redirectTarget: '/connections',
      now: NOW,
    });
    const connectionId = await seedConnection(ORG, 'p9-conn-cas1');
    await expect(
      succeedOAuthAuthorizationSession(prisma, {
        organizationId: ORG,
        sessionId: issued.sessionId,
        connectionId,
        credentialRef: 'cred-cas1',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_SESSION_INVALID_TRANSITION' });

    const after = await loadOAuthAuthorizationSession(prisma, { organizationId: ORG, sessionId: issued.sessionId });
    expect(after?.status).toBe('PENDING');
    expect(after?.connectionId).toBeNull();
  });

  it('PG-P9-8 SUCCEEDED 绑定冲突：同一连接但不同 credentialRef → BINDING_CONFLICT，终态不可改写', async () => {
    const issued = await initiateOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      userId: USER,
      provider: 'AMAZON',
      callbackPath: CALLBACK,
      redirectTarget: '/connections',
      now: NOW,
    });
    const connectionId = await seedConnection(ORG, 'p9-conn-cas2');
    const store = createPrismaOAuthStateStore(prisma, { now: () => NOW });
    await store.take(issued.state);
    const first = await succeedOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      sessionId: issued.sessionId,
      connectionId,
      credentialRef: 'cred-cas2-a',
      now: NOW,
    });
    expect(first.status).toBe('SUCCEEDED');

    // 相同 binding → 幂等
    const replay = await succeedOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      sessionId: issued.sessionId,
      connectionId,
      credentialRef: 'cred-cas2-a',
      now: NOW,
    });
    expect(replay.status).toBe('SUCCEEDED');

    // 不同 binding → 冲突
    await expect(
      succeedOAuthAuthorizationSession(prisma, {
        organizationId: ORG,
        sessionId: issued.sessionId,
        connectionId,
        credentialRef: 'cred-cas2-b',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_SESSION_BINDING_CONFLICT' });
    const stored = await loadOAuthAuthorizationSession(prisma, { organizationId: ORG, sessionId: issued.sessionId });
    expect(stored?.credentialRef).toBe('cred-cas2-a');
  });

  it('PG-P9-9 connectionId 必须属于同租户（跨租户连接 → CONNECTION_NOT_FOUND）', async () => {
    const issued = await initiateOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      userId: USER,
      provider: 'AMAZON',
      callbackPath: CALLBACK,
      redirectTarget: '/connections',
      now: NOW,
    });
    const foreignConnection = await seedConnection(ORG_B, 'p9-conn-cas3');
    const store = createPrismaOAuthStateStore(prisma, { now: () => NOW });
    await store.take(issued.state);
    await expect(
      succeedOAuthAuthorizationSession(prisma, {
        organizationId: ORG,
        sessionId: issued.sessionId,
        connectionId: foreignConnection,
        credentialRef: 'cred-cas3',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_SESSION_CONNECTION_NOT_FOUND' });
  });

  it('PG-P9-10 resumeGoalId 必须是同租户既有 AgentGoal（否则 GOAL_NOT_FOUND）', async () => {
    const foreignGoal = await persistAgentGoal(prisma, {
      organizationId: ORG_B,
      createdBy: USER,
      rawUserIntent: 'check recoverable money',
      normalizedGoal: { goalType: 'DISCOVER_AND_RECOVER', domains: ['PLATFORM'] },
      now: NOW,
    });
    await expect(
      initiateOAuthAuthorizationSession(prisma, {
        organizationId: ORG,
        userId: USER,
        provider: 'AMAZON',
        callbackPath: CALLBACK,
        redirectTarget: '/connections',
        resumeGoalId: foreignGoal.goalId,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_SESSION_GOAL_NOT_FOUND' });

    const ownGoal = await persistAgentGoal(prisma, {
      organizationId: ORG,
      createdBy: USER,
      rawUserIntent: 'check recoverable money',
      normalizedGoal: { goalType: 'DISCOVER_AND_RECOVER', domains: ['PLATFORM'] },
      now: NOW,
    });
    const issued = await initiateOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      userId: USER,
      provider: 'AMAZON',
      callbackPath: CALLBACK,
      redirectTarget: '/connections',
      resumeGoalId: ownGoal.goalId,
      now: NOW,
    });
    expect(issued.resumeGoalId).toBe(ownGoal.goalId);
  });

  it('PG-P9-11 数据库级状态机守卫：PENDING → SUCCEEDED 被触发器拒绝；终态绑定不可改写', async () => {
    const issued = await initiateOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      userId: USER,
      provider: 'AMAZON',
      callbackPath: CALLBACK,
      redirectTarget: '/connections',
      now: NOW,
    });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "OAuthAuthorizationSession" SET "status" = 'SUCCEEDED', "consumedAt" = now() WHERE "id" = '${issued.sessionId}'`,
      ),
    ).rejects.toThrow(/OAUTH_SESSION_INVALID_TRANSITION/);

    const connectionId = await seedConnection(ORG, 'p9-conn-cas4');
    const store = createPrismaOAuthStateStore(prisma, { now: () => NOW });
    await store.take(issued.state);
    await succeedOAuthAuthorizationSession(prisma, {
      organizationId: ORG,
      sessionId: issued.sessionId,
      connectionId,
      credentialRef: 'cred-cas4',
      now: NOW,
    });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "OAuthAuthorizationSession" SET "credentialRef" = 'rewritten' WHERE "id" = '${issued.sessionId}'`,
      ),
    ).rejects.toThrow(/OAUTH_SESSION_BINDING_IMMUTABLE/);
  });
});
