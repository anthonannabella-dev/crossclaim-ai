// P2-3（MSG-20260929-72）— Secret Rotation 审计脱敏 + 清单/流程冻结 + 覆盖关闭声明

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SECRET_INVENTORY,
  SECRET_ROTATION_ACTION,
  SECRET_ROTATION_ALLOWED_FIELDS,
  SECRET_ROTATION_FLOW,
  SECRET_ROTATION_ROLLBACK,
  SecretRotationAuditError,
  buildSecretRotationEvent,
  recordSecretRotation,
} from '../services/operations/secret-rotation-audit';

const base = {
  secretName: 'STORAGE_URL_SECRET',
  actorUserId: 'user-owner',
  timestamp: '2026-09-29T18:00:00.000Z',
  result: 'SUCCESS',
  changeRequestId: 'CR-2026-001',
} as const;

describe('P2-3 Secret Rotation — 清单与流程（架构方冻结）', () => {
  it('01 清单只含名称与元数据，且覆盖冻结范围', () => {
    const names = SECRET_INVENTORY.map((entry) => entry.name);
    for (const required of [
      'DATABASE_URL',
      'SESSION_SECRET',
      'AUDIT_IP_SALT',
      'STORAGE_URL_SECRET',
      'STRIPE_WEBHOOK_SECRET',
      'SOURCE_CONNECTION_CREDENTIAL_REF',
      'OAUTH_CLIENT_CREDENTIAL_REF',
    ]) {
      expect(names).toContain(required);
    }
    // 清单不得包含任何取值样式的内容
    const text = JSON.stringify(SECRET_INVENTORY);
    expect(text).not.toMatch(/postgresql:\/\//);
    expect(text).not.toMatch(/=[A-Za-z0-9]{16,}/);
    const allowedEntryKeys = ['impact', 'name', 'overlapWindowMinutes', 'rotationClass', 'hostApprovalRequired'];
    for (const entry of SECRET_INVENTORY) {
      expect(entry.hostApprovalRequired).toBe(true); // 全部必须宿主执行
      for (const key of Object.keys(entry)) {
        expect(allowedEntryKeys, key).toContain(key);
      }
    }
  });

  it('02 流程与回滚顺序冻结', () => {
    expect([...SECRET_ROTATION_FLOW]).toEqual([
      'prepare',
      'generate',
      'overlap-window',
      'switch',
      'verify',
      'revoke-old',
      'audit',
    ]);
    expect([...SECRET_ROTATION_ROLLBACK]).toEqual([
      'detect-invalid-new-secret',
      'restore-old-secret',
      'verify',
      'audit-failure',
    ]);
  });
});

describe('P2-3 Secret Rotation — 审计脱敏（只记名称，不记取值）', () => {
  it('03 合法字段 → 事件只含五个允许字段', () => {
    const event = buildSecretRotationEvent({ ...base });
    expect(Object.keys(event).sort()).toEqual([...SECRET_ROTATION_ALLOWED_FIELDS].sort());
    expect(event.secretName).toBe('STORAGE_URL_SECRET');
    expect(event.result).toBe('SUCCESS');
  });

  it('04 任何"取值类"字段一律拒绝，且错误消息不含取值', () => {
    const attempts: Array<Record<string, unknown>> = [
      { ...base, secretValue: 'super-secret-value' },
      { ...base, oldSecret: 'old-secret' },
      { ...base, newSecret: 'new-secret' },
      { ...base, valueHash: 'abc123' },
      { ...base, prefix: 'abcd' },
      { ...base, suffix: 'wxyz' },
      { ...base, secretLength: 32 },
      { ...base, secretMaterial: 'raw' },
    ];
    for (const input of attempts) {
      let error: unknown;
      try {
        buildSecretRotationEvent(input);
      } catch (caught) {
        error = caught;
      }
      expect(error, JSON.stringify(Object.keys(input))).toBeInstanceOf(SecretRotationAuditError);
      const message = (error as Error).message;
      for (const leaked of ['super-secret-value', 'old-secret', 'new-secret', 'abc123', 'abcd', 'wxyz']) {
        expect(message, leaked).not.toContain(leaked);
      }
    }
  });

  it('05 未知字段被拒绝（白名单封闭）', () => {
    expect(() => buildSecretRotationEvent({ ...base, extra: 'x' })).toThrowError(SecretRotationAuditError);
  });

  it('06 必填字段缺失/非法 → 拒绝', () => {
    const { secretName, ...withoutName } = base;
    void secretName;
    expect(() => buildSecretRotationEvent(withoutName)).toThrowError(/secretName/);
    expect(() => buildSecretRotationEvent({ ...base, result: 'DONE' })).toThrowError(/result/);
    expect(() => buildSecretRotationEvent({ ...base, changeRequestId: '' })).toThrowError(/changeRequestId/);
  });

  it('07 recordSecretRotation：日志字段与事件字段一致，且不含取值；平台级不写 AuditLog', async () => {
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
    let auditWrites = 0;
    const event = await recordSecretRotation(
      {
        log: (name, fields) => logged.push({ event: name, fields }),
        auditLogWriter: async () => {
          auditWrites += 1;
        },
      },
      { ...base, result: 'ROLLED_BACK' },
    );
    expect(event.result).toBe('ROLLED_BACK');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.event).toBe(SECRET_ROTATION_ACTION);
    expect(Object.keys(logged[0]?.fields ?? {}).sort()).toEqual([
      'actorUserId',
      'changeRequestId',
      'result',
      'secretName',
      'timestamp',
    ]);
    expect(auditWrites).toBe(0); // 未提供 organizationId → 只有安全日志
  });

  it('08 recordSecretRotation：租户作用域（提供 organizationId）才写 AuditLog', async () => {
    const writes: Array<{ event: unknown; organizationId: string }> = [];
    await recordSecretRotation(
      {
        organizationId: 'cf000000-0000-4000-8000-0000000000f9',
        auditLogWriter: async (auditEvent, organizationId) => {
          writes.push({ event: auditEvent, organizationId });
        },
      },
      { ...base, secretName: 'SOURCE_CONNECTION_CREDENTIAL_REF', result: 'FAILED' },
    );
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes[0])).not.toMatch(/postgresql:\/\/|secret-value|oldsecret/);
  });
});

describe('P2-3 Secret Rotation — 计划工具（只读，拒绝执行）', () => {
  const toolPath = path.join(__dirname, '..', '..', '..', '..', 'tools', 'secrets', 'secret-rotation-plan.mjs');

  it('09 计划工具存在，且明确拒绝执行真实轮换 / 打印计划', () => {
    const source = readFileSync(toolPath, 'utf8');
    expect(source).toContain('HOST APPROVAL REQUIRED');
    expect(source).toContain('--execute');
    expect(source).toMatch(/refuse|拒绝/);
    // 工具不得读取任何 secret 取值（不得访问 process.env）
    expect(source).not.toContain('process.env[');
    expect(source).not.toMatch(/process\.env\.[A-Za-z_]+/);
  });
});
