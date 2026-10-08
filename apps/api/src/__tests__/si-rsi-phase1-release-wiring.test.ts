/**
 * PHASE 1 / C7 —— 发布配置与 CI 核验（静态契约，确定性）
 * ---------------------------------------------------------------
 * 对应 `MSG-20261008-16` CHANGE 7：
 *   · API 与 RSI 必须连接**同一个** durable 任务源；
 *   · 生产路径不得回退到容易丢任务的 JSON 文件队列；
 *   · 启动入口的接线方式可被复现验证（不依赖手工记忆）。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoFile = (relative: string): string => readFileSync(path.join('..', '..', relative), 'utf8');
const repoHas = (relative: string): boolean => existsSync(path.join('..', '..', relative));

const SERVER = repoFile('apps/api/src/server.ts');
const RSI_RUN = repoFile('apps/api/src/runtime/rsi-run.ts');
const BOOTSTRAP = repoFile('apps/api/src/runtime/rsi-run-bootstrap.ts');
const DURABLE_SOURCE = repoFile('apps/api/src/runtime/rsi-durable-task-source.ts');
const PRISMA_PORT = repoFile('apps/api/src/services/agent-goal/prisma-task-queue-port.ts');
const MANIFEST = JSON.parse(repoFile('deploy/release-manifest.json')) as {
  gates: { requiredTestFiles: string[]; requireGitHeadEqualsReleaseCommit: boolean; requireCleanWorktree: boolean };
};
const API_UNIT = repoFile('deploy/systemd/crossclaim-api.service');

const PHASE1_SUITES = [
  'src/__tests__/si-rsi-p0-repro.test.ts',
  'src/__tests__/si-rsi-phase1-durable-queue.test.ts',
  'src/__tests__/si-rsi-phase1-finalization.test.ts',
  'src/__tests__/si-rsi-phase1-retry-lifecycle.test.ts',
  'src/__tests__/si-rsi-phase1-authorization.test.ts',
  'src/__tests__/si-rsi-phase1-fault-matrix.test.ts',
];

describe('PHASE 1 / C7 · 同一 durable 数据源', () => {
  it('01 API 默认使用 Prisma durable 队列端口（JSON 仅为显式 legacy 回退）', () => {
    expect(SERVER).toContain("from './services/agent-goal/prisma-task-queue-port'");
    expect(SERVER).toContain('hasDatabaseUrl');
    expect(SERVER).toContain('createPrismaTaskQueuePort({ prisma })');
    // JSON 端口仍可显式选择，但必须出现在 DATABASE_URL 缺失的分支里
    const jsonAt = SERVER.indexOf('createJsonTaskQueuePort({ tasksPath');
    const prismaAt = SERVER.indexOf('createPrismaTaskQueuePort({ prisma })');
    expect(jsonAt).toBeGreaterThan(prismaAt);
  });

  it('02 RSI 启动入口从同一 Prisma 客户端取得 durable 任务源并接入既有 tick', () => {
    expect(RSI_RUN).toContain('taskSource: openedReconcile.taskSource');
    expect(RSI_RUN).toContain('source.reclaimExpired(5)'); // C2 接管先于 claim
    expect(RSI_RUN).toContain('await source.claim(5)');
    expect(RSI_RUN).toContain('controller.adoptTasks(claimed)');
  });

  it('03 启动装配：reconcile store 与任务源共用同一个 PrismaClient', () => {
    expect(BOOTSTRAP).toContain('createAutonomyTaskSource({ prisma, ownerRef })');
    expect(BOOTSTRAP).toContain('createPrismaRsiReconcileStore(prisma)');
    const clientCreations = BOOTSTRAP.split('new PrismaClient()').length - 1;
    expect(clientCreations).toBe(1); // 只能创建一次客户端 ⇒ 同一数据源
  });

  it('04 命名空间一致：端口与任务源使用同一 incident kind 与任务前缀', () => {
    expect(PRISMA_PORT).toContain("CUSTOMER_GOAL_QUEUE_INCIDENT_KIND = 'CUSTOMER_GOAL_QUEUE'");
    expect(DURABLE_SOURCE).toContain("CUSTOMER_GOAL_QUEUE_INCIDENT_KIND = 'CUSTOMER_GOAL_QUEUE'");
    expect(DURABLE_SOURCE).toContain("RECOVERY_QUEUE_TASK_PREFIX = 'task:recovery:'");
  });

  it('05 生产 unit 不依赖 RSI_TASKS_PATH（不靠 JSON artifact 承载客户任务）', () => {
    expect(API_UNIT).not.toContain('RSI_TASKS_PATH');
  });
});

describe('PHASE 1 / C7 · CI / 发布门禁覆盖', () => {
  it('06 发布门禁包含全部 PHASE 1 套件且仍要求 SHA 锁定 + 工作树 clean', () => {
    for (const suite of PHASE1_SUITES) {
      expect(MANIFEST.gates.requiredTestFiles, suite).toContain(suite);
      expect(repoHas(path.join('apps', 'api', suite)), suite).toBe(true);
    }
    expect(MANIFEST.gates.requireGitHeadEqualsReleaseCommit).toBe(true);
    expect(MANIFEST.gates.requireCleanWorktree).toBe(true);
  });

  it('07 门禁脚本会真实执行必需测试（不是只列清单）', () => {
    const verifier = repoFile('deploy/verify-release.mjs');
    expect(verifier).toContain('requiredTestFiles');
    expect(verifier).toContain('gate.tests.pass');
    expect(verifier).toContain('vitest.mjs');
  });
});
