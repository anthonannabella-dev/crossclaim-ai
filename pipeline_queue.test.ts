// 队列调度契约测试(可沙箱运行的部分):
//   - isQueueEnabled 由 PIPELINE_QUEUE_ENABLED 开关控制
//   - dispatchPipelineStep 正确分发已知步骤(prisma 早退, 不抛错), 未知步骤抛错
// 注: 队列入队/worker 实际运行依赖 Redis, 不在此用例覆盖(需集成环境)。

jest.mock('../src/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../src/config/database', () => {
  const prisma = {
    batchGroup: { findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) },
    document: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
    groupValidation: { create: jest.fn(async () => ({})), deleteMany: jest.fn(async () => ({})) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  return { __esModule: true, default: prisma, prisma };
});

import { dispatchPipelineStep } from '../src/services/groupPipelineService';
import { isQueueEnabled } from '../src/services/queue/pipelineQueue';

describe('队列开关 isQueueEnabled', () => {
  const orig = process.env.PIPELINE_QUEUE_ENABLED;
  afterEach(() => { process.env.PIPELINE_QUEUE_ENABLED = orig; });

  test('默认/未设置 → 关闭(回落 nextTick)', () => {
    delete process.env.PIPELINE_QUEUE_ENABLED;
    expect(isQueueEnabled()).toBe(false);
  });
  test('PIPELINE_QUEUE_ENABLED=true → 启用', () => {
    process.env.PIPELINE_QUEUE_ENABLED = 'true';
    expect(isQueueEnabled()).toBe(true);
  });
  test('其它值 → 关闭', () => {
    process.env.PIPELINE_QUEUE_ENABLED = '1';
    expect(isQueueEnabled()).toBe(false);
  });
});

describe('dispatchPipelineStep 步骤分发', () => {
  test.each(['ocr', 'ai', 'autofill'] as const)('已知步骤 %s 不抛错(分组不存在则早退)', async (step) => {
    await expect(dispatchPipelineStep(step, 'g-x')).resolves.toBeUndefined();
  });
  test('未知步骤抛错', async () => {
    // @ts-expect-error 故意传非法步骤
    await expect(dispatchPipelineStep('bogus', 'g-x')).rejects.toThrow('未知流水线步骤');
  });
});
