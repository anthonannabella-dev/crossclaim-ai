/**
 * C-0013-B — 连接器抽象层（单元）：只读契约、NormalizerOutput 边界、cursor、quarantine。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURSOR_VERSION, FileCursorStore } from '../services/connectors/cursor-store';
import { FixtureFetcher } from '../services/connectors/fixture-fetcher';
import {
  JsonlQuarantineSink,
  QUARANTINE_ALLOWED_KEYS,
  assertQuarantineEntry,
  inputFingerprintOf,
} from '../services/connectors/quarantine';
import {
  ConnectorContractError,
  QUARANTINE_REASON_CODES,
  assertReadonlyConnector,
  type ConnectorDescriptor,
  type NormalizerOutput,
} from '../services/connectors/types';
import { sourceFingerprintV1 } from '../services/claim/source-fingerprint';

const descriptor: ConnectorDescriptor = {
  connectorId: 'amazon-inventory-v1',
  platformType: 'AMAZON',
  authKind: 'API_KEY',
  readonlyScopes: ['inventory:read'],
  resources: ['inventory-ledger'],
  rateLimitPerMinute: 60,
};

describe('C-0013-B — 只读与身份契约（MSG-138 REVISE-5）', () => {
  it('必须有不可变 connectorId 与非空只读 scope', () => {
    expect(() => assertReadonlyConnector(descriptor)).not.toThrow();
    expect(() => assertReadonlyConnector({ ...descriptor, connectorId: '' })).toThrow(ConnectorContractError);
    expect(() => assertReadonlyConnector({ ...descriptor, readonlyScopes: [] })).toThrow(ConnectorContractError);
    expect(() => assertReadonlyConnector({ ...descriptor, resources: [] })).toThrow(ConnectorContractError);
  });

  it('NormalizerOutput 只含事实字段，不含 recoverable / 规则字段（REVISE-4）', () => {
    const output: NormalizerOutput = {
      platformType: 'AMAZON',
      claimType: 'FBA_LOSS',
      occurredAt: new Date('2026-09-10T00:00:00Z'),
      amountExpected: '100.0000',
      amountActual: '95.0000',
      currency: 'USD',
      responsibleParty: 'PLATFORM_WAREHOUSE',
      normalizedRef: 'adj-1',
      normalizerVersion: 'test-normalizer-v1',
      sourceFingerprintCandidate: 'x'.repeat(64),
    };
    expect(Object.keys(output).sort()).toEqual(
      [
        'amountActual',
        'amountExpected',
        'claimType',
        'currency',
        'normalizedRef',
        'normalizerVersion',
        'occurredAt',
        'platformType',
        'responsibleParty',
        'sourceFingerprintCandidate',
      ].sort(),
    );
    for (const forbidden of ['recoverableAmount', 'ruleVersionId', 'decision']) {
      expect(Object.keys(output)).not.toContain(forbidden);
    }
  });
});

describe('C-0013-B — cursor（MSG-138 REVISE-1）', () => {
  it('载荷含 connectionRef/resource/cursorVersion，可按资源隔离读取', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-cursor-'));
    const store = new FileCursorStore(dir);
    const key = { connectionRef: 'conn-1', resource: 'inventory-ledger' };
    expect(await store.read(key)).toBeNull();

    const record = await store.write(key, '42', () => new Date('2026-09-28T18:00:00Z'));
    expect(record).toMatchObject({
      cursor: '42',
      connectionRef: 'conn-1',
      resource: 'inventory-ledger',
      cursorVersion: CURSOR_VERSION,
    });
    expect(await store.read(key)).toBe('42');

    // 另一个 resource 互不影响
    expect(await store.read({ ...key, resource: 'adjustments' })).toBeNull();

    // 文件被改写成别的 resource → 必须拒绝（防跨资源误读）
    const file = path.join(dir, 'conn-1__inventory-ledger.json');
    const tampered = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    tampered.resource = 'adjustments';
    writeFileSync(file, JSON.stringify(tampered), 'utf8');
    await expect(store.read(key)).rejects.toThrow(ConnectorContractError);
  });
});

describe('C-0013-B — quarantine（MSG-138 REVISE-3）', () => {
  it('原因码白名单里没有业务判断词', () => {
    expect([...QUARANTINE_REASON_CODES]).toEqual([
      'MISSING_FIELD',
      'INVALID_TYPE',
      'AMOUNT_FORMAT',
      'IDENTITY_UNAVAILABLE',
      'UNKNOWN_SHAPE',
    ]);
    for (const forbidden of ['AMOUNT_TOO_SMALL', 'NOT_RECOVERABLE', 'LOW_VALUE']) {
      expect(QUARANTINE_REASON_CODES as readonly string[]).not.toContain(forbidden);
    }
  });

  it('字段白名单之外的键一律拒绝（尤其 payload / token）', () => {
    const entry = {
      connectorId: 'amazon-inventory-v1',
      platformType: 'AMAZON',
      normalizerVersion: 'test-normalizer-v1',
      reasonCode: 'MISSING_FIELD' as const,
      inputFingerprint: inputFingerprintOf('amazon-inventory-v1', 'row-1'),
      occurredAt: '2026-09-28T18:00:00.000Z',
    };
    expect(() => assertQuarantineEntry(entry)).not.toThrow();
    expect(Object.keys(entry).sort()).toEqual([...QUARANTINE_ALLOWED_KEYS].sort());
    expect(() => assertQuarantineEntry({ ...entry, rawPayload: { a: 1 } } as never)).toThrow();
    expect(() => assertQuarantineEntry({ ...entry, accessToken: 'x' } as never)).toThrow();
    expect(() =>
      assertQuarantineEntry({ ...entry, reasonCode: 'NOT_RECOVERABLE' as never }),
    ).toThrow();
  });

  it('JSONL sink 每行一条，字段与白名单一致', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-quarantine-'));
    const sink = new JsonlQuarantineSink(dir, 'run-1');
    await sink.write({
      connectorId: 'amazon-inventory-v1',
      platformType: 'AMAZON',
      normalizerVersion: 'test-normalizer-v1',
      reasonCode: 'MISSING_FIELD',
      inputFingerprint: inputFingerprintOf('amazon-inventory-v1', 'row-1'),
      occurredAt: '2026-09-28T18:00:00.000Z',
    });
    const lines = readFileSync(path.join(dir, 'run-1.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(Object.keys(JSON.parse(lines[0])).sort()).toEqual([...QUARANTINE_ALLOWED_KEYS].sort());
  });
});

describe('C-0013-B — FixtureFetcher（测试替身，不得演变成生产连接器）', () => {
  it('按 limit 分页，游标指到下一页，末尾返回 nextCursor=null', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-fixture-'));
    const file = path.join(dir, 'records.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ resourceRef: 'r1', payload: { adjustmentId: 'a1' } }),
        JSON.stringify({ resourceRef: 'r2', payload: { adjustmentId: 'a2' } }),
        JSON.stringify({ resourceRef: 'r3', payload: { adjustmentId: 'a3' } }),
      ].join('\n'),
      'utf8',
    );
    const fetcher = new FixtureFetcher(file, () => new Date('2026-09-28T18:00:00Z'));
    const first = await fetcher.pull({ resource: 'inventory-ledger', cursor: null, limit: 2 });
    expect(first.records.map((r) => r.resourceRef)).toEqual(['r1', 'r2']);
    expect(first.nextCursor).toBe('2');

    const second = await fetcher.pull({ resource: 'inventory-ledger', cursor: first.nextCursor, limit: 2 });
    expect(second.records.map((r) => r.resourceRef)).toEqual(['r3']);
    expect(second.nextCursor).toBeNull();

    await expect(
      fetcher.pull({ resource: 'inventory-ledger', cursor: '999', limit: 2 }),
    ).rejects.toThrow();
  });

  it('指纹候选由 C-0013-A 计算（Normalizer 只声明）', () => {
    const result = sourceFingerprintV1({
      platformType: 'AMAZON',
      claimType: 'FBA_LOSS',
      occurredAt: new Date('2026-09-10T00:00:00Z'),
      normalizedRef: 'adj-1',
      currency: 'USD',
    });
    expect(result.fingerprint).toHaveLength(64);
    expect(result.version).toBe('v1');
  });
});
