/**
 * Wave 1 · 外部适配器接口单元测试（Gate 1 · Checkpoint 2 · 第 2 项）
 * ---------------------------------------------------------------
 * 覆盖：规范导入格式（平台字段隔离、金额/日期规范化）、注册表与 Phase 1 写入闸门、
 *       分页与上限、拉取失败的两种处理路径、租户归属与幂等不受平台载荷影响。
 * 数据库级导入仍然由 ingest-db.test.ts / tenant-isolation.test.ts 负责。
 */

import { describe, expect, it } from 'vitest';
import type { Channel, RecoveryDomain } from '@prisma/client';

import {
  AdapterCapabilityError,
  AdapterMappingError,
  AdapterNotFoundError,
  AdapterRateLimitError,
  AdapterRegistryError,
  AdapterResponseError,
  AdapterWriteNotAllowedError,
  CANONICAL_COLUMNS,
  canonicalAmount,
  canonicalDate,
  createAdapterRegistry,
  runAdapterImport,
  submitClaimThroughAdapter,
  toCanonicalRows,
  withSourceEvidence,
  type AdapterCapabilities,
  type AdapterRecord,
  type AdapterPullPage,
  type AdapterPullRequest,
  type AdapterSession,
  type ExternalAdapter,
} from '../services/adapters';
import type { ImportBatchDraft, ImportRepository, TransactionInsert } from '../services/ingest';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const CONN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTEXT = {
  organizationId: ORG,
  domain: 'LOGISTICS' as const,
  channel: 'UPS' as const,
  connectionId: CONN,
};
const CREDENTIALS = { secretRef: 'CROSSCLAIM_TEST_READONLY' };
const SESSION: AdapterSession = { platform: 'fake-logistics', handle: { token: 'in-memory-only' } };

/** 内存端口：与 ingest.test.ts 相同的语义，insertTransactions 模拟唯一键去重 */
function memoryRepo() {
  const batches: Array<{ id: string } & Partial<ImportBatchDraft>> = [];
  const transactions: TransactionInsert[] = [];
  const seen = new Set<string>();
  let seq = 0;

  const repository: ImportRepository = {
    async createBatch(data) {
      seq += 1;
      const id = `batch-${seq}`;
      batches.push({ id, ...data });
      return { id };
    },
    async updateBatch(id, data) {
      const target = batches.find((b) => b.id === id);
      if (target) Object.assign(target, data);
    },
    async insertTransactions(rows) {
      let inserted = 0;
      for (const row of rows) {
        if (seen.has(row.dedupeKey)) continue;
        seen.add(row.dedupeKey);
        transactions.push(row);
        inserted += 1;
      }
      return { inserted };
    },
  };
  return { repository, batches, transactions };
}

interface FakeAdapterOptions {
  platform?: string;
  displayName?: string;
  domains?: readonly RecoveryDomain[];
  channels?: readonly Channel[];
  maxPageSize?: number;
  /** 按调用次序返回分页；返回 AdapterError 表示该次拉取失败 */
  pages?: Array<AdapterPullPage | (() => never)>;
  hasSubmitClaim?: 'none' | 'manual' | 'submitted';
  supportsClaimSubmission?: boolean;
}

interface FakeAdapter extends ExternalAdapter {
  readonly pullRequests: AdapterPullRequest[];
  readonly authCalls: number;
  readonly submitCalls: number;
}

function fakeAdapter(options: FakeAdapterOptions = {}): FakeAdapter {
  const platform = options.platform ?? 'fake-logistics';
  const pages = options.pages ?? [];
  const pullRequests: AdapterPullRequest[] = [];
  let authCalls = 0;
  let submitCalls = 0;

  const capabilities: AdapterCapabilities = {
    platform,
    displayName: options.displayName ?? 'Fake Logistics',
    domains: options.domains ?? ['LOGISTICS'],
    channels: options.channels ?? ['UPS'],
    supportsIncrementalPull: true,
    supportsPagination: true,
    supportsClaimSubmission: false,
    maxPageSize: options.maxPageSize ?? 100,
  };

  const adapter: FakeAdapter = {
    platform,
    pullRequests,
    get authCalls() {
      return authCalls;
    },
    get submitCalls() {
      return submitCalls;
    },
    capabilities() {
      if (options.supportsClaimSubmission) {
        // 故意用非类型化路径模拟「绕过类型锁」的 JS 调用方
        return { ...capabilities, supportsClaimSubmission: true } as unknown as AdapterCapabilities;
      }
      return capabilities;
    },
    async authenticate() {
      authCalls += 1;
      return SESSION;
    },
    async pull(request) {
      pullRequests.push(request);
      const next = pages[pullRequests.length - 1];
      if (next === undefined) return { records: [], nextCursor: null, hasMore: false };
      if (typeof next === 'function') return next();
      return next;
    },
  };

  if (options.hasSubmitClaim && options.hasSubmitClaim !== 'none') {
    adapter.submitClaim = async () => {
      submitCalls += 1;
      if (options.hasSubmitClaim === 'submitted') {
        return { status: 'SUBMITTED', externalRef: 'EXT-1' } as never;
      }
      return { status: 'NEEDS_MANUAL', reason: '该平台只支持文件导出' };
    };
  }

  return adapter;
}

// ============================================================
describe('规范导入格式', () => {
  it('只输出 5 个规范列，平台特有字段留在 source 里', () => {
    const canonical = toCanonicalRows([
      {
        externalId: 12345,
        referenceType: 'INVOICE',
        occurredAt: '2026-09-01',
        amount: '100.50',
        currency: 'usd',
        source: { platformFee: 3.2, shipmentId: 'SHIP-1', fulfillmentCenter: 'ONT8' },
      },
    ]);

    expect(canonical.header).toEqual([...CANONICAL_COLUMNS]);
    expect(canonical.mapping).toEqual({
      externalId: 'externalId',
      referenceType: 'referenceType',
      occurredAt: 'occurredAt',
      amount: 'amount',
      currency: 'currency',
    });
    expect(canonical.rows[0]).toEqual({
      externalId: '12345',
      referenceType: 'INVOICE',
      occurredAt: '2026-09-01',
      amount: '100.50',
      currency: 'USD',
    });
    expect(Object.keys(canonical.rows[0]).sort()).toEqual([...CANONICAL_COLUMNS].sort());
    expect(canonical.sources[0]).toEqual({
      platformFee: 3.2,
      shipmentId: 'SHIP-1',
      fulfillmentCenter: 'ONT8',
    });
  });

  it('金额：十进制字符串原样保留；整数与 ≤4 位小数的 number 接受；浮点污染明确报错', () => {
    expect(canonicalAmount('1,234.56')).toBe('1,234.56');
    expect(canonicalAmount(' 100.5000 ')).toBe('100.5000');
    expect(canonicalAmount(100)).toBe('100');
    expect(canonicalAmount(12.34)).toBe('12.34');
    expect(canonicalAmount(-5)).toBe('-5');
    expect(canonicalAmount(null)).toBe('');
    expect(canonicalAmount(undefined)).toBe('');

    expect(() => canonicalAmount(0.1 + 0.2)).toThrow(AdapterMappingError);
    expect(() => canonicalAmount(12.34567)).toThrow(/十进制字符串/);
    expect(() => canonicalAmount(Number.POSITIVE_INFINITY)).toThrow(/十进制字符串/);
  });

  it('日期：Date → ISO；字符串原样；非法 Date 明确报错', () => {
    expect(canonicalDate(new Date('2026-09-01T10:00:00Z'))).toBe('2026-09-01T10:00:00.000Z');
    expect(canonicalDate('2026/09/01')).toBe('2026/09/01');
    expect(canonicalDate(null)).toBe('');
    expect(() => canonicalDate(new Date('nope'))).toThrow(/Invalid Date/);
  });

  it('缺字段留空字符串，交给导入层做行级校验（不在这里静默吞掉）', () => {
    const canonical = toCanonicalRows([{ externalId: 'A-1' }]);
    expect(canonical.rows[0]).toEqual({
      externalId: 'A-1',
      referenceType: '',
      occurredAt: '',
      amount: '',
      currency: '',
    });
  });

  it('证据投影：保留规范列并挂 _source，未提供载荷时不新增字段', () => {
    const row = { externalId: 'A-1', referenceType: '', occurredAt: '', amount: '10', currency: 'USD' };
    expect(withSourceEvidence(row, { a: 1 })).toEqual({ ...row, _source: { a: 1 } });
    expect(Object.keys(withSourceEvidence(row, undefined))).toEqual(Object.keys(row));
  });
});

// ============================================================
describe('适配器注册表', () => {
  it('注册 / 查询 / 按渠道筛选', () => {
    const ups = fakeAdapter({ platform: 'ups-test' });
    const dhl = fakeAdapter({ platform: 'dhl-test', channels: ['DHL'] });
    const registry = createAdapterRegistry([ups, dhl]);

    expect(registry.list().map((a) => a.platform)).toEqual(['ups-test', 'dhl-test']);
    expect(registry.get('ups-test')).toBe(ups);
    expect(registry.byChannel('UPS').map((a) => a.platform)).toEqual(['ups-test']);
    expect(registry.byChannel('FEDEX')).toEqual([]);
  });

  it('重复注册 / 未注册查询都会明确失败', () => {
    const registry = createAdapterRegistry([fakeAdapter({ platform: 'ups-test' })]);
    expect(() => registry.register(fakeAdapter({ platform: 'ups-test' }))).toThrow(AdapterRegistryError);
    expect(() => registry.get('nope')).toThrow(AdapterNotFoundError);
  });

  it('能力体检：平台标识不一致 / 未声明 domain / maxPageSize 越界都拒绝注册', () => {
    const mismatch = fakeAdapter({ platform: 'ups-test' });
    mismatch.capabilities = () => ({ ...fakeAdapter({ platform: 'other' }).capabilities() });
    expect(() => createAdapterRegistry([mismatch])).toThrow(/标识不一致/);

    expect(() => createAdapterRegistry([fakeAdapter({ domains: [] })])).toThrow(/domain/);
    expect(() => createAdapterRegistry([fakeAdapter({ maxPageSize: 0 })])).toThrow(/maxPageSize/);
    expect(() => createAdapterRegistry([fakeAdapter({ maxPageSize: 100_000 })])).toThrow(/maxPageSize/);
  });

  it('Phase 1 写入闸门：自称具备第三方写能力的适配器一律拒绝注册', () => {
    expect(() => createAdapterRegistry([fakeAdapter({ supportsClaimSubmission: true })])).toThrow(
      AdapterCapabilityError,
    );
  });
});

// ============================================================
describe('适配器 → 导入桥', () => {
  const records = [
    { externalId: 'INV-1', referenceType: 'INVOICE', occurredAt: '2026-09-01', amount: '100.50', currency: 'USD', source: { raw: 1 } },
    { externalId: 'INV-2', referenceType: 'INVOICE', occurredAt: '2026-09-02', amount: '200.00', currency: 'USD', source: { raw: 2 } },
  ] as AdapterRecord[];

  it('正常拉取：规范行进入导入层，批次带来源信息与恒等映射快照', async () => {
    const adapter = fakeAdapter({ pages: [{ records, nextCursor: null, hasMore: false }] });
    const { repository, batches, transactions } = memoryRepo();

    const result = await runAdapterImport({
      adapter,
      credentials: CREDENTIALS,
      context: CONTEXT,
      repository,
    });

    expect(result.platform).toBe('fake-logistics');
    expect(result.pages).toBe(1);
    expect(result.recordsPulled).toBe(2);
    expect(result.nextCursor).toBeNull();
    expect(result.pullError).toBeUndefined();
    expect(result.import.status).toBe('IMPORTED');
    expect(result.import.rowsOk).toBe(2);
    expect(transactions).toHaveLength(2);

    expect(transactions[0].organizationId).toBe(ORG);
    expect(transactions[0].connectionId).toBe(CONN);
    expect(transactions[0].channel).toBe('UPS');
    expect(transactions[0].domain).toBe('LOGISTICS');
    expect(transactions[0].amount).toBe('100.50');
    expect(transactions[0].occurredAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    // 平台原始载荷作为证据挂在 raw 上，规范列仍在
    expect(transactions[0].raw).toMatchObject({
      externalId: 'INV-1',
      amount: '100.50',
      _source: { raw: 1 },
    });

    expect(batches[0].status).toBe('IMPORTED');
    expect(batches[0].columnMapping).toEqual({
      externalId: 'externalId',
      referenceType: 'referenceType',
      occurredAt: 'occurredAt',
      amount: 'amount',
      currency: 'currency',
    });
    expect(batches[0].errorReport).toMatchObject({ source: 'adapter:fake-logistics', duplicates: 0 });
  });

  it('请求里带上租户与渠道，适配器无法自行指定租户', async () => {
    const adapter = fakeAdapter({ pages: [{ records, nextCursor: null, hasMore: false }] });
    const { repository } = memoryRepo();
    await runAdapterImport({ adapter, credentials: CREDENTIALS, context: CONTEXT, repository });

    expect(adapter.pullRequests).toHaveLength(1);
    expect(adapter.pullRequests[0]).toMatchObject({
      organizationId: ORG,
      connectionId: CONN,
      domain: 'LOGISTICS',
      channel: 'UPS',
    });
  });

  it('平台载荷里塞 organizationId 也不会污染租户归属', async () => {
    const rogue: AdapterRecord[] = [
      {
        externalId: 'INV-9',
        amount: '10',
        currency: 'USD',
        source: { organizationId: ORG_B, tenant: 'someone-else' },
      },
    ];
    const adapter = fakeAdapter({ pages: [{ records: rogue, nextCursor: null, hasMore: false }] });
    const { repository, transactions } = memoryRepo();

    await runAdapterImport({ adapter, credentials: CREDENTIALS, context: CONTEXT, repository });

    expect(transactions[0].organizationId).toBe(ORG);
    expect(transactions[0].raw).toMatchObject({ _source: { organizationId: ORG_B } });
  });

  it('重复拉取：同一条记录不会产生第二笔交易，且平台载荷变化不影响幂等', async () => {
    const first = fakeAdapter({ pages: [{ records, nextCursor: null, hasMore: false }] });
    const { repository, transactions } = memoryRepo();
    await runAdapterImport({ adapter: first, credentials: CREDENTIALS, context: CONTEXT, repository });

    const changedPayload: AdapterRecord[] = records.map((r) => ({
      ...r,
      source: { ...(r.source as Record<string, unknown>), extraField: 'new' },
    }));
    const second = fakeAdapter({ pages: [{ records: changedPayload, nextCursor: null, hasMore: false }] });
    const again = await runAdapterImport({
      adapter: second,
      credentials: CREDENTIALS,
      context: CONTEXT,
      repository,
    });

    expect(transactions).toHaveLength(2);
    expect(again.import.duplicates).toBe(2);
    expect(again.import.rowsOk).toBe(0);
  });

  it('同一份平台数据在不同租户下是两笔交易（幂等键含租户）', async () => {
    const { repository, transactions } = memoryRepo();
    await runAdapterImport({
      adapter: fakeAdapter({ pages: [{ records, nextCursor: null, hasMore: false }] }),
      credentials: CREDENTIALS,
      context: CONTEXT,
      repository,
    });
    await runAdapterImport({
      adapter: fakeAdapter({ pages: [{ records, nextCursor: null, hasMore: false }] }),
      credentials: CREDENTIALS,
      context: { ...CONTEXT, organizationId: ORG_B },
      repository,
    });

    expect(transactions).toHaveLength(4);
    expect(transactions.filter((t) => t.organizationId === ORG)).toHaveLength(2);
    expect(transactions.filter((t) => t.organizationId === ORG_B)).toHaveLength(2);
    expect(transactions[0].dedupeKey).not.toBe(transactions[2].dedupeKey);
  });

  it('坏行只影响该行：合法行照常入库，问题进入批次 errorReport', async () => {
    const mixed: AdapterRecord[] = [
      records[0],
      { externalId: 'INV-BAD', amount: 'not-a-number', currency: 'USD' },
    ];
    const adapter = fakeAdapter({ pages: [{ records: mixed, nextCursor: null, hasMore: false }] });
    const { repository, batches, transactions } = memoryRepo();

    const result = await runAdapterImport({ adapter, credentials: CREDENTIALS, context: CONTEXT, repository });

    expect(result.import.status).toBe('PARTIAL');
    expect(result.import.rowsOk).toBe(1);
    expect(result.import.rowsFailed).toBe(1);
    expect(result.import.issues[0]).toMatchObject({ row: 2, field: 'amount', code: 'INVALID_AMOUNT' });
    expect(transactions).toHaveLength(1);
    expect((batches[0].errorReport as { issues: unknown[] }).issues).toHaveLength(1);
  });

  it('分页：按 hasMore / nextCursor 连续拉取，maxPages 到上限时给出续拉游标', async () => {
    const page = (id: string, nextCursor: string | null, hasMore: boolean): AdapterPullPage => ({
      records: [{ externalId: id, amount: '1', currency: 'USD' }],
      nextCursor,
      hasMore,
    });

    const full = fakeAdapter({ pages: [page('A', 'c1', true), page('B', 'c2', true), page('C', null, false)] });
    const { repository, transactions } = memoryRepo();
    const result = await runAdapterImport({ adapter: full, credentials: CREDENTIALS, context: CONTEXT, repository });
    expect(result.pages).toBe(3);
    expect(result.recordsPulled).toBe(3);
    expect(result.nextCursor).toBeNull();
    expect(transactions).toHaveLength(3);

    const limited = fakeAdapter({ pages: [page('A', 'c1', true), page('B', 'c2', true)] });
    const second = memoryRepo();
    const limitedResult = await runAdapterImport({
      adapter: limited,
      credentials: CREDENTIALS,
      context: CONTEXT,
      repository: second.repository,
      maxPages: 1,
    });
    expect(limitedResult.pages).toBe(1);
    expect(limitedResult.nextCursor).toBe('c1');
    expect(second.transactions).toHaveLength(1);
  });

  it('maxRecords 是软上限：整页保留，不截断半页，游标指向未拉完的位置', async () => {
    const twoPerPage = (id: string, nextCursor: string): AdapterPullPage => ({
      records: [
        { externalId: `${id}-1`, amount: '1', currency: 'USD' },
        { externalId: `${id}-2`, amount: '1', currency: 'USD' },
      ],
      nextCursor,
      hasMore: true,
    });
    const adapter = fakeAdapter({ pages: [twoPerPage('A', 'c1'), twoPerPage('B', 'c2')] });
    const { repository, transactions } = memoryRepo();

    const result = await runAdapterImport({
      adapter,
      credentials: CREDENTIALS,
      context: CONTEXT,
      repository,
      maxRecords: 3,
    });

    expect(result.pages).toBe(2);
    expect(result.recordsPulled).toBe(4);
    expect(result.nextCursor).toBe('c2');
    expect(transactions).toHaveLength(4);
  });

  it('hasMore=true 但没有 nextCursor → 协议错误，且不写任何批次', async () => {
    const adapter = fakeAdapter({ pages: [{ records: [], nextCursor: null, hasMore: true }] });
    const { repository, batches } = memoryRepo();

    await expect(
      runAdapterImport({ adapter, credentials: CREDENTIALS, context: CONTEXT, repository }),
    ).rejects.toBeInstanceOf(AdapterResponseError);
    expect(batches).toHaveLength(0);
  });

  it('第一条都没拉到就失败 → 直接把错误抛给调用方，不留空批次', async () => {
    const adapter = fakeAdapter({
      pages: [
        () => {
          throw new AdapterRateLimitError('被限流', 1_500);
        },
      ],
    });
    const { repository, batches } = memoryRepo();

    await expect(
      runAdapterImport({ adapter, credentials: CREDENTIALS, context: CONTEXT, repository }),
    ).rejects.toBeInstanceOf(AdapterRateLimitError);
    expect(batches).toHaveLength(0);
  });

  it('拉到一半失败：已拉到的记录照常导入，并在结果与批次里留明确失败信息', async () => {
    const adapter = fakeAdapter({
      pages: [
        { records: [records[0]], nextCursor: 'c1', hasMore: true },
        () => {
          throw new AdapterRateLimitError('被限流', 2_000);
        },
      ],
    });
    const { repository, batches, transactions } = memoryRepo();

    const result = await runAdapterImport({ adapter, credentials: CREDENTIALS, context: CONTEXT, repository });

    expect(result.pages).toBe(1);
    expect(result.recordsPulled).toBe(1);
    expect(result.nextCursor).toBeNull();
    expect(result.pullError).toEqual({ code: 'RATE_LIMITED', message: '被限流', retryAfterMs: 2_000 });
    expect(result.import.status).toBe('IMPORTED');
    expect(transactions).toHaveLength(1);
    expect(batches[0].errorReport).toMatchObject({ pullError: { code: 'RATE_LIMITED' } });
  });

  it('适配器不支持该 domain / channel 时拒绝运行', async () => {
    const adapter = fakeAdapter({ channels: ['DHL'] });
    const { repository, transactions } = memoryRepo();

    await expect(
      runAdapterImport({ adapter, credentials: CREDENTIALS, context: CONTEXT, repository }),
    ).rejects.toBeInstanceOf(AdapterCapabilityError);
    expect(transactions).toHaveLength(0);
  });
});

// ============================================================
describe('提交闸门（Phase 1 只读）', () => {
  it('未实现 API 提交 → NEEDS_MANUAL', async () => {
    const adapter = fakeAdapter({ hasSubmitClaim: 'none' });
    const result = await submitClaimThroughAdapter(
      adapter,
      { organizationId: ORG, claimId: 'claim-1', payload: { amount: '10' } },
      SESSION,
    );
    expect(result.status).toBe('NEEDS_MANUAL');
  });

  it('适配器返回 NEEDS_MANUAL → 原样透传', async () => {
    const adapter = fakeAdapter({ hasSubmitClaim: 'manual' });
    const result = await submitClaimThroughAdapter(
      adapter,
      { organizationId: ORG, claimId: 'claim-1', payload: {} },
      SESSION,
    );
    expect(result).toMatchObject({ status: 'NEEDS_MANUAL', reason: '该平台只支持文件导出' });
  });

  it('适配器声称已真实提交 → 一律拒绝（第三方写入需先回架构方审计）', async () => {
    const adapter = fakeAdapter({ hasSubmitClaim: 'submitted' });
    await expect(
      submitClaimThroughAdapter(adapter, { organizationId: ORG, claimId: 'claim-1', payload: {} }, SESSION),
    ).rejects.toBeInstanceOf(AdapterWriteNotAllowedError);
    expect(adapter.submitCalls).toBe(1);
  });
});
