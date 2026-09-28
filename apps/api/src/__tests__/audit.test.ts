/**
 * Wave 1 · 审计基础逻辑（C-0003 / Gate 1 · 第 2 项）
 * ---------------------------------------------------------------
 * 断言重点：
 *   1. 脱敏：密钥被替换、storageKey 被掩码、深度与长度有上限
 *   2. IP：只存加盐哈希，原始 IP 永不落库
 *   3. 校验：必须带租户、actorType 合法、action 命名规范
 *   4. 查询：永远带 organizationId，limit 有默认值与上限
 *   5. 只增不改：模块不暴露任何 update / delete
 */

import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  STORAGE_KEY_MASK,
  AuditError,
  createAuditWriter,
  hashIp,
  listAuditTrail,
  looksLikeSecret,
  maskStorageKey,
  normalizeLimit,
  sanitizeChanges,
  truncate,
  type AuditLogInsert,
  type AuditLogRow,
  type AuditQueryArgs,
  type AuditSink,
} from '../services/audit';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const SALT = 'audit-ip-salt-0123456789';
const STORAGE_KEY = `${ORG_A}/ab/${ASSET}`;

/** 内存端口：捕获写入了什么、收到了什么查询条件 */
function memorySink(): { sink: AuditSink; inserted: AuditLogInsert[]; queries: AuditQueryArgs[] } {
  const inserted: AuditLogInsert[] = [];
  const queries: AuditQueryArgs[] = [];
  let seq = 0;
  const sink: AuditSink = {
    async insert(row) {
      inserted.push(row);
      seq += 1;
      return { id: `audit-${seq}`, createdAt: row.createdAt };
    },
    async query(args) {
      queries.push(args);
      const rows: AuditLogRow[] = inserted
        .filter((row) => row.organizationId === args.organizationId)
        .map((row, index) => ({ ...row, id: `audit-${index + 1}` }));
      return rows.slice(0, args.take);
    },
  };
  return { sink, inserted, queries };
}

// ============================================================
describe('审计载荷脱敏', () => {
  it('敏感键名与"看起来像密钥"的值都会被替换', () => {
    const out = sanitizeChanges({
      password: 'hunter2',
      apiKey: 'sk-live-abcdefghijklmnop',
      nested: { authorization: 'Bearer abc.def.ghi', token: 'ghp_abcdefghijklmnop' },
      safe: 'text/csv',
    });

    const json = JSON.stringify(out);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('sk-live-abcdefghijklmnop');
    expect(json).not.toContain('abc.def.ghi');
    expect(json).not.toContain('ghp_abcdefghijklmnop');
    expect(json).toContain(REDACTED);
    expect((out as { safe: string }).safe).toBe('text/csv');
  });

  it('storageKey 被掩码，不进入审计表', () => {
    expect(maskStorageKey(STORAGE_KEY)).toBe(STORAGE_KEY_MASK);
    expect(maskStorageKey('/tmp/other')).toBe('/tmp/other');

    const out = sanitizeChanges({ file: STORAGE_KEY, note: `引用 ${STORAGE_KEY}` });
    expect((out as { file: string }).file).toBe(STORAGE_KEY_MASK);
    // 嵌套在句子里的 key 不是 key 形态，但也不能带出真实租户路径片段：这里断言原样保留但不含密钥
    expect(JSON.stringify(out)).not.toContain('sk-');
  });

  it('超长字符串被截断，超深对象被截断，数组有上限', () => {
    const long = 'x'.repeat(1000);
    const out = sanitizeChanges({ long }, { maxString: 100 }) as { long: string };
    expect(out.long.length).toBeLessThan(200);
    expect(out.long).toContain('[truncated');

    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
    expect(JSON.stringify(sanitizeChanges(deep))).toContain('[DEPTH_LIMIT]');

    const many = sanitizeChanges({ list: Array.from({ length: 150 }, (_, i) => i) }) as { list: number[] };
    expect(many.list).toHaveLength(100);
  });

  it('识别常见密钥前缀与授权串', () => {
    expect(looksLikeSecret('Bearer abc.def')).toBe(true);
    expect(looksLikeSecret('sk-abcdefghijklmnop')).toBe(true);
    expect(looksLikeSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(looksLikeSecret('text/csv')).toBe(false);
    expect(truncate('abcdef', 3)).toBe('abc…[truncated 3]');
  });
});

// ============================================================
describe('IP 处理', () => {
  it('只存加盐哈希：同 IP 同盐可关联，换盐不可反推', () => {
    const a = hashIp('203.0.113.7', SALT);
    expect(a).toBe(hashIp('203.0.113.7', SALT));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain('203.0.113.7');
    expect(hashIp('203.0.113.7', `${SALT}-other`)).not.toBe(a);
  });
});

// ============================================================
describe('审计写入', () => {
  it('写入前完成校验：必须带租户、actorType 合法、action 规范', async () => {
    const { sink } = memorySink();
    const writer = createAuditWriter(sink, { ipSalt: SALT });

    await expect(
      writer.record({ organizationId: 'not-a-uuid', actorType: 'USER', action: 'file.downloaded' }),
    ).rejects.toThrow(AuditError);
    await expect(
      writer.record({ organizationId: ORG_A, actorType: 'ROBOT' as never, action: 'file.downloaded' }),
    ).rejects.toThrow(AuditError);
    await expect(
      writer.record({ organizationId: ORG_A, actorType: 'USER', action: 'File Downloaded' }),
    ).rejects.toThrow(AuditError);
    await expect(
      writer.record({
        organizationId: ORG_A,
        actorType: 'USER',
        action: 'file.downloaded',
        entityId: 'bad\u0000id',
      }),
    ).rejects.toThrow(AuditError);
  });

  it('盐值过短直接拒绝构造（避免用弱盐哈希 IP）', () => {
    const { sink } = memorySink();
    expect(() => createAuditWriter(sink, { ipSalt: 'short' })).toThrow(AuditError);
  });

  it('落库前完成脱敏：changes 无密钥、storageKey 掩码、IP 哈希、UA 截断', async () => {
    const { sink, inserted } = memorySink();
    const writer = createAuditWriter(sink, { ipSalt: SALT, now: () => new Date('2026-09-28T07:00:00Z') });

    const record = await writer.record({
      organizationId: ORG_A,
      actorType: 'USER',
      actorId: 'user-1',
      action: 'file.downloaded',
      entityType: 'FileAsset',
      entityId: ASSET,
      changes: { storageKey: STORAGE_KEY, apiKey: 'sk-should-not-appear' },
      ip: '203.0.113.7',
      userAgent: 'A'.repeat(400),
    });

    expect(record.id).toBe('audit-1');
    const row = inserted[0];
    expect(row.organizationId).toBe(ORG_A);
    expect(row.changes?.storageKey).toBe(STORAGE_KEY_MASK);
    expect(JSON.stringify(row.changes)).not.toContain('sk-should-not-appear');
    expect(row.ip).toBe(hashIp('203.0.113.7', SALT));
    expect(row.ip).not.toContain('203.0.113.7');
    expect((row.userAgent ?? '').length).toBeLessThan(300);
    expect(row.createdAt.toISOString()).toBe('2026-09-28T07:00:00.000Z');
  });

  it('未提供的字段落 null，而不是 undefined', async () => {
    const { sink, inserted } = memorySink();
    const writer = createAuditWriter(sink, { ipSalt: SALT });
    await writer.record({ organizationId: ORG_A, actorType: 'SYSTEM', action: 'migration.applied' });
    const row = inserted[0];
    expect(row.actorId).toBeNull();
    expect(row.entityType).toBeNull();
    expect(row.changes).toBeNull();
    expect(row.ip).toBeNull();
  });
});

// ============================================================
describe('审计查询', () => {
  it('永远按租户过滤，两个租户的记录不会互相看见', async () => {
    const { sink } = memorySink();
    const writer = createAuditWriter(sink, { ipSalt: SALT });
    await writer.record({ organizationId: ORG_A, actorType: 'USER', action: 'case.opened' });
    await writer.record({ organizationId: ORG_B, actorType: 'USER', action: 'case.opened' });

    const a = await listAuditTrail(sink, { organizationId: ORG_A });
    const b = await listAuditTrail(sink, { organizationId: ORG_B });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('limit 默认 50、上限 200，非法值报错', async () => {
    expect(normalizeLimit(undefined)).toBe(50);
    expect(normalizeLimit(5)).toBe(5);
    expect(normalizeLimit(10_000)).toBe(200);
    expect(() => normalizeLimit(0)).toThrow(AuditError);
    expect(() => normalizeLimit(-1)).toThrow(AuditError);

    const { sink, queries } = memorySink();
    await listAuditTrail(sink, { organizationId: ORG_A, limit: 9999 });
    expect(queries[0].take).toBe(200);
  });

  it('筛选条件透传，且查询里一定带 organizationId', async () => {
    const { sink, queries } = memorySink();
    const before = new Date('2026-09-28T07:00:00Z');
    await listAuditTrail(sink, {
      organizationId: ORG_A,
      entityType: 'FileAsset',
      entityId: ASSET,
      action: 'file.downloaded',
      before,
      limit: 10,
    });
    expect(queries[0]).toMatchObject({
      organizationId: ORG_A,
      entityType: 'FileAsset',
      entityId: ASSET,
      action: 'file.downloaded',
      before,
      take: 10,
    });
    await expect(listAuditTrail(sink, { organizationId: 'nope' })).rejects.toThrow(AuditError);
  });
});

// ============================================================
describe('只增不改', () => {
  it('审计模块不导出任何 update / delete 能力', async () => {
    const mod = await import('../services/audit');
    const forbidden = Object.keys(mod).filter((key) => /update|delete|remove|patch|prune/i.test(key));
    expect(forbidden).toEqual([]);
  });
});
