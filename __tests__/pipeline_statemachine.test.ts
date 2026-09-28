// 流水线状态机集成测试:覆盖闭环里的状态流转与守卫
//   导出报文(checked→declared)/海关接受/退单/放行/结关/复核驳回
// 用 mock prisma + mock 动态导入的 declarationService,无需真实数据库即可运行。

jest.mock('../src/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../src/config/database', () => {
  const prisma = {
    batchGroup: {
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
    },
    document: { findMany: jest.fn(async () => []) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  return { __esModule: true, default: prisma, prisma };
});

// 动态导入的报关单服务全部 mock 成可观测的空实现
jest.mock('../src/services/declarationService', () => ({
  __esModule: true,
  submitDeclaration: jest.fn(async () => ({})),
  completeDeclaration: jest.fn(async () => ({})),
  rejectDeclaration: jest.fn(async () => ({})),
}));

import prisma from '../src/config/database';
import {
  markExported,
  markCustomsAccepted,
  markCustomsRejected,
  markReleased,
  markCompleted,
  rejectReview,
} from '../src/services/groupPipelineService';
import * as declSvc from '../src/services/declarationService';

const db = prisma as any;
const flush = () => new Promise((r) => setImmediate(r));

function group(over: any) {
  return { id: 'g', tenantId: 't', billOfLading: 'BL1', status: 'checked', declarationId: 'd1', errorMsg: null, ...over };
}
// 取本组最后一次状态 update
function lastUpdate(id: string) {
  const calls = db.batchGroup.update.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a?.where?.id === id);
  return calls[calls.length - 1];
}

beforeEach(() => jest.clearAllMocks());

describe('导出报文 markExported', () => {
  test('checked → declared,记录报文名+申报时间,并标记报关单已提交', async () => {
    db.batchGroup.findUnique.mockResolvedValueOnce(group({ status: 'checked' }));
    await markExported('g', 'declaration_BL1.xml');
    await flush();
    const u = lastUpdate('g');
    expect(u.data.status).toBe('declared');
    expect(u.data.xmlPath).toBe('declaration_BL1.xml');
    expect(u.data.declaredAt).toBeInstanceOf(Date);
    expect(declSvc.submitDeclaration).toHaveBeenCalledWith('t', 'd1');
  });

  test('幂等:非 checked 状态(已 declared)重复导出不改状态', async () => {
    db.batchGroup.findUnique.mockResolvedValueOnce(group({ status: 'declared' }));
    await markExported('g');
    expect(db.batchGroup.update).not.toHaveBeenCalled();
    expect(declSvc.submitDeclaration).not.toHaveBeenCalled();
  });
});

describe('海关回执 markCustomsAccepted', () => {
  test('declared → customs_review', async () => {
    db.batchGroup.findUnique.mockResolvedValueOnce(group({ status: 'declared' }));
    await markCustomsAccepted('g');
    expect(lastUpdate('g').data.status).toBe('customs_review');
  });

  test('错误状态(pending)抛错', async () => {
    db.batchGroup.findUnique.mockResolvedValueOnce(group({ status: 'pending' }));
    await expect(markCustomsAccepted('g')).rejects.toThrow('不可标记海关接受');
  });
});

describe('海关退单 markCustomsRejected', () => {
  test('置 rejected,errorMsg 含退单代码,并回写报关单退单', async () => {
    db.batchGroup.findUnique.mockResolvedValueOnce(group({ status: 'customs_review' }));
    await markCustomsRejected('g', 'GF001', '价格异常');
    await flush();
    const u = lastUpdate('g');
    expect(u.data.status).toBe('rejected');
    expect(u.data.errorMsg).toContain('GF001');
    expect(declSvc.rejectDeclaration).toHaveBeenCalledWith('t', 'd1', 'GF001', '价格异常');
  });
});

describe('放行 markReleased', () => {
  test('customs_review → released,并完成报关单', async () => {
    db.batchGroup.findUnique.mockResolvedValueOnce(group({ status: 'customs_review' }));
    await markReleased('g');
    await flush();
    expect(lastUpdate('g').data.status).toBe('released');
    expect(declSvc.completeDeclaration).toHaveBeenCalledWith('t', 'd1');
  });

  test('错误状态(pending)抛错', async () => {
    db.batchGroup.findUnique.mockResolvedValueOnce(group({ status: 'pending' }));
    await expect(markReleased('g')).rejects.toThrow('不可放行');
  });
});

describe('结关 markCompleted', () => {
  test('released → completed,记录归档时间并触发自动归档(写审计日志)', async () => {
    // 第一次 findUnique 给 markCompleted;第二次给 archiveGroup
    db.batchGroup.findUnique
      .mockResolvedValueOnce(group({ status: 'released' }))
      .mockResolvedValueOnce(group({ status: 'completed' }));
    await markCompleted('g');
    await flush();
    const u = lastUpdate('g');
    expect(u.data.status).toBe('completed');
    expect(u.data.archivedAt).toBeInstanceOf(Date);
    expect(db.auditLog.create).toHaveBeenCalled(); // 归档留痕
  });

  test('错误状态(declared)抛错', async () => {
    db.batchGroup.findUnique.mockResolvedValueOnce(group({ status: 'declared' }));
    await expect(markCompleted('g')).rejects.toThrow('不可结关');
  });
});

describe('复核驳回 rejectReview', () => {
  test('pending_review → auto_filling 并带驳回原因', async () => {
    db.batchGroup.findUnique
      .mockResolvedValueOnce(group({ status: 'pending_review' })) // rejectReview 自身
      .mockResolvedValue(null); // 重新填制的 nextTick 早退
    await rejectReview('g', '商品描述不全');
    const u = lastUpdate('g');
    expect(u.data.status).toBe('auto_filling');
    expect(u.data.errorMsg).toContain('商品描述不全');
    await flush();
  });

  test('错误状态(checked)抛错', async () => {
    db.batchGroup.findUnique.mockResolvedValueOnce(group({ status: 'checked' }));
    await expect(rejectReview('g', 'x')).rejects.toThrow('不可驳回');
  });
});
