// ============================================================
// 报关流水线持久化任务队列 (BullMQ) — 可选增强层
// ------------------------------------------------------------
// 启用: 环境变量 PIPELINE_QUEUE_ENABLED=true (需 Redis 可用)。
// 未启用: groupPipelineService 自动回落到 process.nextTick(现有行为, 向后兼容)。
//
// 启用后, 三个异步步骤(OCR / AI校验 / 自动填制)进入持久化队列:
//   - 进程重启/崩溃不丢任务(Redis 持久化)
//   - 失败自动重试(指数退避)
//   - 重试耗尽进"死信": 把分组置 error 转人工, 失败任务保留供排查
//
// recoverStuckGroups 仍作为兜底安全网保留(覆盖入队前就丢失、或队列未启用的场景)。
// ============================================================
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import prisma from '../../config/database';
import type { PipelineStep } from '../groupPipelineService';

export const QUEUE_NAME = 'customs-pipeline';
const MAX_ATTEMPTS = 3;

/** 队列是否启用(显式 opt-in, 默认关闭以保证向后兼容) */
export function isQueueEnabled(): boolean {
  return process.env.PIPELINE_QUEUE_ENABLED === 'true';
}

// BullMQ 需要独立的 ioredis 连接: maxRetriesPerRequest 必须为 null
// (它自管重试且依赖阻塞命令), 与 config/redis.ts 的缓存连接配置不同, 故单建一条。
let connection: IORedis | null = null;
function getConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(env().REDIS_URL, { maxRetriesPerRequest: null });
    connection.on('error', (err) => logger.error('[PipelineQueue] Redis 连接错误: %s', err.message));
  }
  return connection;
}

let queue: Queue | null = null;
function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: getConnection() as unknown as ConnectionOptions,
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 200 }, // 保留最近200条成功记录便于观测
        removeOnFail: false,              // 失败任务保留(死信), 供排查
      },
    });
  }
  return queue;
}

/**
 * 入队一个流水线步骤任务。
 * jobId = `${step}:${groupId}` 作幂等键: 同一分组同一步骤不会重复堆积。
 */
export async function enqueuePipelineJob(step: PipelineStep, groupId: string): Promise<void> {
  await getQueue().add(step, { step, groupId }, { jobId: `${step}:${groupId}` });
  logger.info('[PipelineQueue] 入队 step=%s group=%s', step, groupId);
}

let worker: Worker | null = null;
/** 启动 worker(在服务进程启动时调用; 未启用队列则空操作) */
export function startPipelineWorker(): void {
  if (!isQueueEnabled()) {
    logger.info('[PipelineQueue] 未启用(PIPELINE_QUEUE_ENABLED != true), 流水线走 process.nextTick');
    return;
  }
  if (worker) return;

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { step, groupId } = job.data as { step: PipelineStep; groupId: string };
      // 动态导入打破与 groupPipelineService 的循环依赖
      const { dispatchPipelineStep } = await import('../groupPipelineService');
      await dispatchPipelineStep(step, groupId);
    },
    {
      connection: getConnection() as unknown as ConnectionOptions,
      concurrency: Number(process.env.PIPELINE_QUEUE_CONCURRENCY || 3),
    },
  );

  worker.on('failed', async (job, err) => {
    const data = job?.data as { step: PipelineStep; groupId: string } | undefined;
    const attempts = job?.attemptsMade ?? 0;
    logger.error('[PipelineQueue] 任务失败 step=%s group=%s 第%d/%d次: %s',
      data?.step, data?.groupId, attempts, MAX_ATTEMPTS, err.message);
    // 重试耗尽 → 死信处理: 分组置 error 转人工
    if (data && attempts >= MAX_ATTEMPTS) {
      await prisma.batchGroup.update({
        where: { id: data.groupId },
        data: { status: 'error', errorMsg: `流水线步骤[${data.step}]重试${MAX_ATTEMPTS}次仍失败: ${err.message}` },
      }).catch(() => {});
    }
  });

  worker.on('error', (err) => logger.error('[PipelineQueue] worker 错误: %s', err.message));
  logger.info('[PipelineQueue] worker 已启动, concurrency=%s',
    process.env.PIPELINE_QUEUE_CONCURRENCY || 3);
}

/** 优雅关闭(可在进程退出钩子调用) */
export async function shutdownPipelineQueue(): Promise<void> {
  await worker?.close().catch(() => {});
  await queue?.close().catch(() => {});
  await connection?.quit().catch(() => {});
  worker = null; queue = null; connection = null;
}
