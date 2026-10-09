/**
 * INTERNAL CODE REPAIR V1 / PHASE 2 FINAL-R2 / CHANGE 3 —— 可信事实来源契约验收
 * ---------------------------------------------------------------
 * 审计要求（MSG-20261009-09）：
 *   · `organizationIdResolved` 必须由**可信持久化身份关系**解析；
 *   · `authorizationActive` 必须由**服务端当前授权状态**得出；
 *   · `operationRecheck` 必须来自**可信执行上下文**，而非调用方自报；
 *   · `resolveTrustedFacts` 实现**不得**把请求参数 / 客户端字段 / 模型输出直接映射为可信事实；
 *   · 任何未来的适配器都需要证明上述数据来源；
 *   · 当前分流结果只是**快照**，未来运行时不得无条件信任。
 *
 * 本套件把契约变成**可执行断言**（声明违规 ⇒ 接线期抛错），并做源码级边界检查。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_TRUSTED_FACT_SOURCES,
  TRIAGE_TRUSTED_FACT_CONTRACT,
  TRUSTED_FACT_SOURCE_REQUIREMENTS,
  TrustedFactSourceContractError,
  assertTrustedFactSources,
  defineTrustedFactsResolver,
  type TrustedFactSourceDeclaration,
} from '../services/self-repair/fault-triage';
import { FAULT_TRIAGE_SWEEP_BOUNDARY } from '../services/self-repair/fault-triage-sweep';

const VALID_SOURCES: TrustedFactSourceDeclaration = {
  organizationIdResolved: 'TRUSTED_PERSISTED_IDENTITY',
  authorizationActive: 'SERVER_AUTHORIZATION_STATE',
  operationRecheck: 'TRUSTED_EXECUTION_CONTEXT',
};

describe('PHASE 2 / CHANGE 3 可信事实来源契约', () => {
  it('每个可信事实只有一个允许来源，且请求/客户端/模型来源一律禁止', () => {
    expect(TRUSTED_FACT_SOURCE_REQUIREMENTS).toEqual(VALID_SOURCES);
    expect([...FORBIDDEN_TRUSTED_FACT_SOURCES]).toEqual([
      'REQUEST_PARAM',
      'CLIENT_INPUT',
      'MODEL_OUTPUT',
      'UNKNOWN',
    ]);
    expect(TRIAGE_TRUSTED_FACT_CONTRACT).toMatchObject({
      requiresDeclarationPerAdapter: true,
      verifiesAtWiringTime: true,
      snapshotNotAuthorization: true,
    });
  });

  it('合法声明通过校验', () => {
    expect(assertTrustedFactSources(VALID_SOURCES)).toEqual({ ok: true });
  });

  it.each([
    ['organizationIdResolved', 'REQUEST_PARAM'],
    ['authorizationActive', 'CLIENT_INPUT'],
    ['operationRecheck', 'MODEL_OUTPUT'],
    ['operationRecheck', 'UNKNOWN'],
  ] as const)('事实 %s 声明为禁止来源 %s ⇒ 违规并被点名', (fact, source) => {
    const declaration = { ...VALID_SOURCES, [fact]: source } as TrustedFactSourceDeclaration;
    const result = assertTrustedFactSources(declaration);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('FORBIDDEN_TRUSTED_FACT_SOURCE');
      expect(result.offending.some((entry) => entry.startsWith(`${fact}:`))).toBe(true);
    }
  });

  it('来源配对错位（合法种类但用错事实）⇒ 判为违规', () => {
    const result = assertTrustedFactSources({
      ...VALID_SOURCES,
      organizationIdResolved: 'SERVER_AUTHORIZATION_STATE',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.offending).toContain('organizationIdResolved:SERVER_AUTHORIZATION_STATE');
  });

  it('未声明的事实同样 fail-closed', () => {
    const result = assertTrustedFactSources({ organizationIdResolved: 'TRUSTED_PERSISTED_IDENTITY' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('FORBIDDEN_TRUSTED_FACT_SOURCE');
      expect(result.offending).toContain('authorizationActive:NOT_DECLARED');
    }
  });

  it('defineTrustedFactsResolver：合法声明可构造，违规声明在**创建时**抛错', async () => {
    const okResolver = defineTrustedFactsResolver(VALID_SOURCES, async () => ({
      organizationIdResolved: true,
      authorizationActive: true,
      operationRecheck: 'CONFIRMED_READ_ONLY',
    }));
    expect(okResolver.trustedFactSources).toEqual(VALID_SOURCES);
    await expect(okResolver.resolveTrustedFacts({ id: 'x', sourceRefs: {} })).resolves.toMatchObject({
      operationRecheck: 'CONFIRMED_READ_ONLY',
    });

    expect(() =>
      defineTrustedFactsResolver(
        { ...VALID_SOURCES, authorizationActive: 'REQUEST_PARAM' },
        async () => ({
          organizationIdResolved: true,
          authorizationActive: true,
          operationRecheck: 'NOT_CONFIRMED',
        }),
      ),
    ).toThrow(TrustedFactSourceContractError);
  });

  it('边界声明：适配器须声明来源、接线期校验、结果只是快照', () => {
    expect(FAULT_TRIAGE_SWEEP_BOUNDARY).toMatchObject({
      requiresTrustedFactDeclarationForAdapters: true,
      verifiesTrustedFactSourcesAtWiringTime: true,
      registrationIsSnapshotNotAuthorization: true,
      defaultTrustedFacts: 'FAIL_CLOSED',
    });
  });

  it('源码级边界：分流层不读取任何请求/客户端/模型对象', () => {
    const dir = path.resolve(__dirname, '../services/self-repair');
    for (const file of ['fault-triage.ts', 'fault-triage-sweep.ts']) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      // 契约只允许出现来源**种类**名字面量，不允许出现请求对象取值形态
      expect(/req\.(body|query|params)|request\.(body|query|params)|modelOutput/.test(source)).toBe(false);
      expect(source.includes('console.')).toBe(false);
    }
  });

  /**
   * MSG-20261009-10 / CHANGE 5 —— **声明不是运行时授权**（强制条款）。
   */
  it('CHANGE 5：契约明确「声明只约束解析器配置；执行前必须重新读取与校验」', () => {
    expect(TRIAGE_TRUSTED_FACT_CONTRACT).toMatchObject({
      declarationIsNotAuthorization: true,
      snapshotNotAuthorization: true,
    });
    const doc = readFileSync(
      'D:/crossclaim-ai/docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE2-TRUSTED-FACTS-CONTRACT.md',
      'utf8',
    );
    expect(doc).toContain('来源声明只约束解析器');
    expect(doc).toContain('执行前重新读取与校验');
    expect(doc).toContain('PHASE3_IMPLEMENTATION_PREREQUISITE');
  });

  /**
   * MSG-20261009-10 / CHANGE 6 —— 来源伪装负向断言（契约测试 + 静态边界审计）。
   */
  describe('CHANGE 6 来源伪装负向断言', () => {
    it('形态变体（大小写/空白/前缀后缀伪装）一律判为违规', () => {
      for (const bogus of [
        'trusted_persisted_identity',
        'TRUSTED_PERSISTED_IDENTITY ',
        'TRUSTED_PERSISTED_IDENTITY_FROM_CLIENT',
        'SERVER_AUTHORIZATION_STATE_VIA_MODEL',
      ]) {
        const result = assertTrustedFactSources({
          ...VALID_SOURCES,
          organizationIdResolved: bogus as TrustedFactSourceDeclaration['organizationIdResolved'],
        });
        expect(result.ok).toBe(false);
      }
    });

    it('静态边界：可信事实**绝不**从载荷/sourceRefs 合成（只来自注入的解析器）', () => {
      const source = readFileSync(path.resolve(__dirname, '../services/self-repair/fault-triage-sweep.ts'), 'utf8');
      // 三个事实键在扫描模块中只应各出现一次（fail-closed 默认值），不存在从 payload 反推事实的代码路径
      for (const fact of ['organizationIdResolved', 'authorizationActive', 'operationRecheck'] as const) {
        expect(source.split(`${fact}:`).length - 1).toBe(1);
      }
      // 扫描模块不 import 分流白名单解析器，也不读取 sourceRefs 字段来构造事实
      expect(source.includes('parsePersistedFaultPayload')).toBe(false);
      expect(/sourceRefs[^\n]{0,40}=\s*\{/.test(source)).toBe(false);
    });

    it('如实登记：本层没有运行时来源真实性隔离，属 PHASE 3 实现前置条件', () => {
      expect(TRIAGE_TRUSTED_FACT_CONTRACT.runtimeSourceIsolationImplemented).toBe(false);
      expect(TRIAGE_TRUSTED_FACT_CONTRACT.phase3ImplementationPrerequisite).toBe(
        'TRUSTED_ADAPTER_SOURCE_PROVENANCE_EXECUTION_TIME_RECHECK',
      );
    });
  });
});
