/**
 * TRACK C2 第一批（MSG-20261002-65）—— 现有模型可满足的账号/租户边界 **行为测试基线**
 * 依据：MSG-65「若现有 Schema 已经满足，则不要为了 C2 发明新架构，只补行为测试与缺失约束」。
 * 本批**不修改 Schema**；缺口部分（account 维度下推）已作为决策请求单独提交。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import { createPrismaConnectionLifecyclePort } from '../services/acquisition/connection-lifecycle-prisma';
import {
  createConnection,
  rotateCredentialRef,
  transitionConnection,
  type ConnectionLifecycleDeps,
} from '../services/acquisition/connection-lifecycle';
import { runConnectorPull } from '../services/acquisition/api-connector-runtime';
import { projectSubmissionState, projectionInputFromSubmission } from '../services/billing/submission-state-projection';

const prisma = new PrismaClient();
const FAST = { N: 1024, r: 8, p: 1, keyLength: 64 };
const uuid = (): string => randomUUID();

let ORG_A = '';
let ORG_B = '';
let ACCOUNT_A = '';
let ACCOUNT_B = '';

/** 只记录审计载荷的假写入器（便于断言「凭据值不进入审计」） */
function recordingAudit() {
  const records: Array<{ action: string; changes: Record<string, unknown> }> = [];
  return {
    records,
    writer: {
      record: async (input: { action: string; changes?: Record<string, unknown> }) => {
        records.push({ action: input.action, changes: input.changes ?? {} });
      },
    },
  };
}

async function seedOrg(suffix: string) {
  const id = uuid();
  await prisma.organization.create({
    data: { id, name: 'R46 C2 ' + suffix, slug: 'r46-c2-' + suffix + '-' + uuid().slice(0, 8) },
  });
  const user = await prisma.user.create({
    data: {
      email: 'r46-c2-' + suffix + '-' + uuid().slice(0, 8) + '@example.com',
      passwordHash: hashPassword('r46-c2-pass-123', FAST),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: id, userId: user.id, role: 'OWNER', isActive: true } });
  // MSG-20261002-77：连接夹具需要 canonical PlatformAccount（ACTIVE 必须已绑定）。
  const account = await prisma.platformAccount.create({
    data: { organizationId: id, platform: 'OTHER', externalAccountId: 'C2-BASE-' + suffix, displayName: 'c2 base ' + suffix },
    select: { id: true },
  });
  return { organizationId: id, userId: user.id, accountId: account.id };
}

function lifecycleDeps(): { deps: ConnectionLifecycleDeps; audit: ReturnType<typeof recordingAudit> } {
  const audit = recordingAudit();
  return {
    audit,
    deps: { connections: createPrismaConnectionLifecyclePort(prisma), audit: audit.writer as never },
  };
}

beforeAll(async () => {
  const a = await seedOrg('a');
  ORG_A = a.organizationId;
  ACCOUNT_A = a.accountId;
  const b = await seedOrg('b');
  ORG_B = b.organizationId;
  ACCOUNT_B = b.accountId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('TRACK C2 行为基线 —— 租户/账号边界（现有 Schema，无变更）', () => {
  it('同一 externalId 出现在两个 organization → 事实互不冲突（org-scoped identity）', async () => {
    const externalId = 'ORDER-' + uuid().slice(0, 8);
    const { deps } = lifecycleDeps();
    const connA = await createConnection(
      { organizationId: ORG_A, platformAccountId: ACCOUNT_A, domain: 'PLATFORM', channel: 'AMAZON_OTHER', kind: 'FILE_UPLOAD', label: 'Store A' },
      deps,
    );
    const connB = await createConnection(
      { organizationId: ORG_B, platformAccountId: ACCOUNT_B, domain: 'PLATFORM', channel: 'AMAZON_OTHER', kind: 'FILE_UPLOAD', label: 'Store A' },
      deps,
    );

    for (const [org, conn] of [
      [ORG_A, connA.id],
      [ORG_B, connB.id],
    ] as const) {
      await prisma.sourceTransaction.create({
        data: {
          organizationId: org,
          connectionId: conn,
          domain: 'PLATFORM',
          channel: 'AMAZON_OTHER',
          externalId,
          referenceType: 'ORDER',
          amount: '100.0000',
          currency: 'USD',
          dedupeKey: org + '|' + conn + '|ORDER|' + externalId,
          raw: { externalId },
        },
      });
      await prisma.canonicalFact.create({
        data: {
          organizationId: org,
          domain: 'PLATFORM',
          channel: 'AMAZON_OTHER',
          factKey: 'ORDER:' + externalId.toUpperCase(),
          referenceType: 'ORDER',
          externalId,
          amount: '100.0000',
          currency: 'USD',
        },
      });
    }

    const txA = await prisma.sourceTransaction.findMany({ where: { organizationId: ORG_A, externalId } });
    const txB = await prisma.sourceTransaction.findMany({ where: { organizationId: ORG_B, externalId } });
    expect(txA).toHaveLength(1);
    expect(txB).toHaveLength(1);
    expect(txA[0].dedupeKey).not.toBe(txB[0].dedupeKey);

    const factA = await prisma.canonicalFact.findMany({ where: { organizationId: ORG_A, factKey: 'ORDER:' + externalId.toUpperCase() } });
    const factB = await prisma.canonicalFact.findMany({ where: { organizationId: ORG_B, factKey: 'ORDER:' + externalId.toUpperCase() } });
    expect(factA).toHaveLength(1);
    expect(factB).toHaveLength(1);
    expect(factA[0].id).not.toBe(factB[0].id);
  });

  it('连接身份为 (org, channel, label)：同 org 同 channel 重复 label 被拒绝，label 仅是展示名', async () => {
    const { deps } = lifecycleDeps();
    await createConnection(
      { organizationId: ORG_A, platformAccountId: ACCOUNT_A, domain: 'PLATFORM', channel: 'AMAZON_FBA', kind: 'FILE_UPLOAD', label: 'Store X' },
      deps,
    );
    await expect(
      createConnection(
        { organizationId: ORG_A, platformAccountId: ACCOUNT_A, domain: 'PLATFORM', channel: 'AMAZON_FBA', kind: 'FILE_UPLOAD', label: 'Store X' },
        deps,
      ),
    ).rejects.toThrow(/Unique constraint|P2002/);
    // 同 label 在别的 channel 下允许 —— 说明 label 不承担身份语义
    const other = await createConnection(
      { organizationId: ORG_A, platformAccountId: ACCOUNT_A, domain: 'PLATFORM', channel: 'AMAZON_OTHER', kind: 'FILE_UPLOAD', label: 'Store X' },
      deps,
    );
    expect(other.id).toBeTruthy();
  });

  it('REVOKED 连接不得再拉取（revoked account cannot ingest new facts）', async () => {
    const { deps } = lifecycleDeps();
    const created = await createConnection(
      { organizationId: ORG_A, platformAccountId: ACCOUNT_A, domain: 'PLATFORM', channel: 'AMAZON_OTHER', kind: 'API', label: 'API ' + uuid().slice(0, 6), credentialRef: 'CROSSCLAIM_FIXTURE_RO' },
      deps,
    );
    await transitionConnection({ organizationId: ORG_A, connectionId: created.id, to: 'ACTIVE' }, deps);
    await transitionConnection({ organizationId: ORG_A, connectionId: created.id, to: 'REVOKED', reason: 'seller revoked' }, deps);

    await expect(
      runConnectorPull(
        { organizationId: ORG_A, connectionId: created.id } as never,
        { prisma } as never,
      ),
    ).rejects.toMatchObject({ code: 'CONNECTION_STATUS_BLOCKED' });
  });

  it('凭据轮换不重写历史 provenance，且审计载荷不含凭据值', async () => {
    const { deps, audit } = lifecycleDeps();
    const created = await createConnection(
      { organizationId: ORG_A, platformAccountId: ACCOUNT_A, domain: 'PLATFORM', channel: 'AMAZON_OTHER', kind: 'FILE_UPLOAD', label: 'Rotate ' + uuid().slice(0, 6) },
      deps,
    );
    const tx = await prisma.sourceTransaction.create({
      data: {
        organizationId: ORG_A,
        connectionId: created.id,
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        externalId: 'ROT-' + uuid().slice(0, 8),
        referenceType: 'ORDER',
        amount: '10.0000',
        currency: 'USD',
        dedupeKey: uuid(),
        raw: { keep: true },
      },
    });
    const before = await prisma.sourceTransaction.findFirstOrThrow({ where: { id: tx.id } });

    await rotateCredentialRef(
      { organizationId: ORG_A, connectionId: created.id, credentialRef: 'CROSSCLAIM_FIXTURE_RO_V2' },
      deps,
    );

    const after = await prisma.sourceTransaction.findFirstOrThrow({ where: { id: tx.id } });
    expect(after.connectionId).toBe(before.connectionId);
    expect(after.dedupeKey).toBe(before.dedupeKey);
    expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString());
    expect(after.raw).toEqual(before.raw);

    const rotated = audit.records.find((r) => r.action === 'source_connection.credential_rotated');
    expect(rotated).toBeTruthy();
    expect(JSON.stringify(rotated?.changes)).not.toContain('CROSSCLAIM_FIXTURE_RO');
  });
});

describe('TRACK S 行为基线 —— 内部提交状态 vs 平台真实提交状态（投影）', () => {
  it('platformWriteExecuted=false → 不显示为已发送平台；标签显式 NOT SENT TO PLATFORM', () => {
    const p = projectSubmissionState({
      internalApproved: true,
      packageReady: true,
      recordedReadyToSubmit: true,
      platformWriteExecuted: false,
      providerCaseRef: null,
      externalSubmission: 'NEEDS_MANUAL',
    });
    expect(p.A_internalApproved).toBe(true);
    expect(p.B_packageReady).toBe(true);
    expect(p.C_recordedReadyToSubmit).toBe(true);
    expect(p.D_sentToPlatform).toBe(false);
    expect(p.E_providerAcknowledged).toBe(false);
    expect(p.operatorLabel).toContain('NOT SENT TO PLATFORM');
    expect(p.operatorLabel).not.toContain('Sent to Platform ·');
  });

  it('仅当 providerCaseRef 存在时才算平台 ACK；externalSubmission 不得抬升发送状态', () => {
    const ack = projectSubmissionState({
      internalApproved: true,
      packageReady: true,
      recordedReadyToSubmit: true,
      platformWriteExecuted: false,
      providerCaseRef: 'AMZ-CASE-123',
      externalSubmission: 'NEEDS_MANUAL',
    });
    expect(ack.E_providerAcknowledged).toBe(true);
    expect(ack.D_sentToPlatform).toBe(false);
    expect(ack.everSentToPlatform).toBe(false);
  });

  it('现有响应映射：NEEDS_MANUAL + platformWriteExecuted=false → 录制为「准备提交、未发送」', () => {
    const projected = projectSubmissionState(
      projectionInputFromSubmission({ externalSubmission: 'NEEDS_MANUAL', platformWriteExecuted: false }),
    );
    expect(projected.C_recordedReadyToSubmit).toBe(true);
    expect(projected.D_sentToPlatform).toBe(false);
    expect(projected.operatorLabel).toContain('NOT SENT TO PLATFORM');

    const notAttempted = projectSubmissionState(
      projectionInputFromSubmission({ externalSubmission: 'NOT_ATTEMPTED', platformWriteExecuted: false }),
    );
    expect(notAttempted.C_recordedReadyToSubmit).toBe(false);
    expect(notAttempted.D_sentToPlatform).toBe(false);
  });
});
