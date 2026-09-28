// 流水线卡死恢复 recoverStuckGroups 的行为测试
// 用功能性 prisma mock,无需真实数据库/Prisma 引擎即可运行。
// 覆盖:回退到正确检查点、ai_checking 先清残留校验、重试上限转 error、
//       pre_checking 不自动重试、查询条件(状态集 + 超时)正确、
//       正常退单消息不被误判为 recover 标记。

jest.mock('../src/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../src/config/database', () => {
  const prisma = {
    batchGroup: {
      findMany: jest.fn(async () => []),
      // 重新触发(triggerGroupOCR/AI/startAutoFill)在 nextTick 里会 findUnique;
      // 返回 null 让它们早退,避免噪声,聚焦恢复本身的行为。
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
    },
    groupValidation: { deleteMany: jest.fn(async () => ({})) },
    document: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  return { __esModule: true, default: prisma, prisma };
});

import prisma from '../src/config/database';
import { recoverStuckGroups } from '../src/services/groupPipelineService';

const db = prisma as any;

// 刷新 nextTick/microtask,确保重新触发函数的异步 update 都已落地
const flush = () => new Promise((r) => setImmediate(r));

// 取出"恢复本身"写的那次 update(以 [recover:N] 或转人工消息为标志,
// 排除重新触发函数自身写的状态 update)
function recoverUpdateFor(id: string) {
  return db.batchGroup.update.mock.calls
    .map((c: any[]) => c[0])
    .find(
      (a: any) =>
        a?.where?.id === id &&
        typeof a?.data?.errorMsg === 'string' &&
        (a.data.errorMsg.includes('[recover:') || a.data.errorMsg.includes('转人工')),
    );
}

function makeGroup(over: any) {
  return { id: 'g', tenantId: 't', billOfLading: 'BL1', status: 'pending', errorMsg: null, ...over };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.batchGroup.findUnique.mockResolvedValue(null);
});

describe('recoverStuckGroups 卡死恢复', () => {
  test('查询条件:仅扫描中间态且超过超时阈值', async () => {
    db.batchGroup.findMany.mockResolvedValueOnce([]);
    await recoverStuckGroups(15);
    const where = db.batchGroup.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(
      expect.arrayContaining(['ocr_running', 'ai_checking', 'auto_filling', 'pre_checking']),
    );
    expect(where.updatedAt.lt).toBeInstanceOf(Date);
  });

  test('ocr_running → 回退 pending 并打首次恢复标记', async () => {
    db.batchGroup.findMany.mockResolvedValueOnce([makeGroup({ id: 'g1', status: 'ocr_running' })]);
    const n = await recoverStuckGroups();
    await flush();
    const upd = recoverUpdateFor('g1');
    expect(upd.data.status).toBe('pending');
    expect(upd.data.errorMsg).toContain('[recover:1]');
    expect(n).toBe(1);
  });

  test('ai_checking → 先清残留 running 校验,再回退 ocr_done', async () => {
    db.batchGroup.findMany.mockResolvedValueOnce([makeGroup({ id: 'g2', status: 'ai_checking' })]);
    await recoverStuckGroups();
    await flush();
    expect(db.groupValidation.deleteMany).toHaveBeenCalledWith({
      where: { groupId: 'g2', status: 'running' },
    });
    const upd = recoverUpdateFor('g2');
    expect(upd.data.status).toBe('ocr_done');
    expect(upd.data.errorMsg).toContain('[recover:1]');
  });

  test('auto_filling → 回退 ai_done', async () => {
    db.batchGroup.findMany.mockResolvedValueOnce([makeGroup({ id: 'g3', status: 'auto_filling' })]);
    await recoverStuckGroups();
    await flush();
    expect(recoverUpdateFor('g3').data.status).toBe('ai_done');
  });

  test('pre_checking → 回退 pending_review 且不清校验', async () => {
    db.batchGroup.findMany.mockResolvedValueOnce([makeGroup({ id: 'g4', status: 'pre_checking' })]);
    await recoverStuckGroups();
    await flush();
    expect(recoverUpdateFor('g4').data.status).toBe('pending_review');
    expect(db.groupValidation.deleteMany).not.toHaveBeenCalled();
  });

  test('累计第2次:标记递增为 [recover:2]', async () => {
    db.batchGroup.findMany.mockResolvedValueOnce([
      makeGroup({ id: 'g5', status: 'ocr_running', errorMsg: '[recover:1] ...' }),
    ]);
    await recoverStuckGroups();
    await flush();
    expect(recoverUpdateFor('g5').data.errorMsg).toContain('[recover:2]');
  });

  test('达到上限(已 recover:3)→ 转 error,不再回退/触发', async () => {
    db.batchGroup.findMany.mockResolvedValueOnce([
      makeGroup({ id: 'g6', status: 'ai_checking', errorMsg: '[recover:3] ...' }),
    ]);
    const n = await recoverStuckGroups();
    await flush();
    const upd = recoverUpdateFor('g6');
    expect(upd.data.status).toBe('error');
    expect(upd.data.errorMsg).toContain('转人工');
    expect(upd.data.errorMsg).not.toContain('[recover:4]');
    // 已放弃的分组不应再清校验
    expect(db.groupValidation.deleteMany).not.toHaveBeenCalled();
    expect(n).toBe(0); // 转 error 不计入"成功恢复"
  });

  test('正常海关退单消息不被误判为 recover 标记(计数从0起)', async () => {
    db.batchGroup.findMany.mockResolvedValueOnce([
      makeGroup({ id: 'g7', status: 'ocr_running', errorMsg: '海关退单 [GF001]: 价格异常' }),
    ]);
    await recoverStuckGroups();
    await flush();
    expect(recoverUpdateFor('g7').data.errorMsg).toContain('[recover:1]');
  });

  test('无卡死分组时返回 0,不写库', async () => {
    db.batchGroup.findMany.mockResolvedValueOnce([]);
    const n = await recoverStuckGroups();
    expect(n).toBe(0);
    expect(db.batchGroup.update).not.toHaveBeenCalled();
  });
});
