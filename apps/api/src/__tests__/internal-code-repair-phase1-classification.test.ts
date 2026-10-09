/**
 * INTERNAL CODE REPAIR V1 / PHASE 1 —— 确定性故障分类中心（纯函数验收）
 * ---------------------------------------------------------------
 * 覆盖 HOST 指令第四节要求：
 *   · 12 类故障逐类可达；· 优先确定性分类（同一输入必然同一输出）；
 *   · 模型只能辅助归因（不能宣布事实 / 权限，不能改变分类、风险等级与重试资格）；
 *   · 故障数据脱敏（Token / 授权串 / 密钥 / 邮箱 / 绝对路径不进摘要与落库载荷）；
 *   · 无法由证据判定的一律 UNKNOWN_ERROR（不猜）。
 *
 * 本文件**不连数据库**（纯函数层；持久化与并发在
 * `internal-code-repair-phase1-incident-db.test.ts` 用真实 PostgreSQL 验收）。
 */

import { describe, expect, it } from 'vitest';

import {
  FAULT_CLASSES,
  FAULT_CLASSIFICATION_BOUNDARY,
  FAULT_REQUIRED_ACTIONS,
  INTERNAL_FAULT_INCIDENT_KIND,
  annotateUntrustedModelHint,
  buildFaultIncidentIntent,
  classifyFault,
  redactFaultText,
  type FaultClass,
  type FaultObservation,
  type FaultRequiredAction,
} from '../services/self-repair/fault-classification';
import {
  RSI_INCIDENT_STATES,
  RSI_RISK_CLASSES,
  requiresOwnerApproval,
} from '../services/autonomy/rsi-lifecycle';
import { CUSTOMER_GOAL_QUEUE_INCIDENT_KIND } from '../runtime/rsi-durable-task-source';

const BASE: FaultObservation = {
  sourceModule: 'services/autonomy/rsi-si-model-gateway',
  environment: 'TEST',
};

interface Case {
  readonly label: string;
  readonly observation: FaultObservation;
  readonly faultClass: FaultClass;
  readonly ruleId: string;
  readonly requiredAction: FaultRequiredAction;
}

const CASES: readonly Case[] = [
  {
    label: 'API 超时（模型网关 provider 超时）',
    observation: { ...BASE, errorCode: 'PROVIDER_TIMEOUT', durationMs: 30_000, timeoutMs: 30_000 },
    faultClass: 'API_TIMEOUT',
    ruleId: 'R_TIMEOUT',
    requiredAction: 'AUTO_RECOVER',
  },
  {
    label: 'API 限流（HTTP 429 / RATE_LIMITED）',
    observation: { ...BASE, httpStatus: 429, adapterErrorCode: 'RATE_LIMITED', providerRef: 'AMAZON' },
    faultClass: 'API_RATE_LIMIT',
    ruleId: 'R_RATE_LIMIT',
    requiredAction: 'AUTO_RECOVER',
  },
  {
    label: '凭据过期（HTTP 401 / AUTH_FAILED）',
    observation: { ...BASE, httpStatus: 401, errorCode: 'AUTH_FAILED', providerRef: 'AMAZON' },
    faultClass: 'TOKEN_EXPIRED',
    ruleId: 'R_EXPIRED_CREDENTIAL',
    requiredAction: 'OWNER_ACTION',
  },
  {
    label: 'Provider 契约/结构漂移（OUTPUT_SCHEMA_INVALID）',
    observation: { ...BASE, errorCode: 'OUTPUT_SCHEMA_INVALID', providerRef: 'DHL' },
    faultClass: 'PROVIDER_SCHEMA_CHANGED',
    ruleId: 'R_PROVIDER_SCHEMA_CHANGED',
    requiredAction: 'CODE_REPAIR_CANDIDATE',
  },
  {
    label: '解析失败（AdapterMappingError）',
    observation: { ...BASE, errorName: 'AdapterMappingError', stage: 'PARSER' },
    faultClass: 'PARSER_FAILURE',
    ruleId: 'R_PARSER_FAILURE',
    requiredAction: 'CODE_REPAIR_CANDIDATE',
  },
  {
    label: '工作流规划错误（GOAL_UNSUPPORTED_INTENT）',
    observation: { ...BASE, sourceModule: 'services/agent-goal/goal-compiler', errorCode: 'GOAL_UNSUPPORTED_INTENT' },
    faultClass: 'WORKFLOW_PLANNING_ERROR',
    ruleId: 'R_WORKFLOW_PLANNING',
    requiredAction: 'CODE_REPAIR_CANDIDATE',
  },
  {
    label: '数据冲突（Prisma P2002 唯一约束）',
    observation: { ...BASE, prismaCode: 'P2002' },
    faultClass: 'DATA_CONFLICT',
    ruleId: 'R_DATA_CONFLICT',
    requiredAction: 'INVESTIGATE',
  },
  {
    label: '数据库事务错误（Prisma P2034 事务冲突）',
    observation: { ...BASE, prismaCode: 'P2034' },
    faultClass: 'DATABASE_TRANSACTION_ERROR',
    ruleId: 'R_DATABASE_TRANSACTION',
    requiredAction: 'AUTO_RECOVER',
  },
  {
    label: '运行时异常（TypeError）',
    observation: { ...BASE, errorName: 'TypeError', message: 'Cannot read properties of undefined' },
    faultClass: 'RUNTIME_EXCEPTION',
    ruleId: 'R_RUNTIME_EXCEPTION',
    requiredAction: 'CODE_REPAIR_CANDIDATE',
  },
  {
    label: '集成契约不匹配（AdapterCapabilityError）',
    observation: { ...BASE, errorName: 'AdapterCapabilityError' },
    faultClass: 'INTEGRATION_CONTRACT_MISMATCH',
    ruleId: 'R_INTEGRATION_CONTRACT',
    requiredAction: 'CODE_REPAIR_CANDIDATE',
  },
  {
    label: '回归失败（测试阶段）',
    observation: { ...BASE, errorCode: 'TEST_FAILURE', stage: 'TEST' },
    faultClass: 'REGRESSION_FAILURE',
    ruleId: 'R_REGRESSION',
    requiredAction: 'CODE_REPAIR_CANDIDATE',
  },
  {
    label: '无法由证据判定（未识别错误）',
    observation: { ...BASE, errorName: 'WibbleFault' },
    faultClass: 'UNKNOWN_ERROR',
    ruleId: 'R_UNCLASSIFIED',
    requiredAction: 'HUMAN_REVIEW',
  },
];

describe('PHASE 1 确定性故障分类 —— 12 类逐类可达', () => {
  it.each(CASES)('$label ⇒ $faultClass', ({ observation, faultClass, ruleId, requiredAction }) => {
    const diagnosis = classifyFault(observation);
    expect(diagnosis.faultClass).toBe(faultClass);
    expect(diagnosis.ruleId).toBe(ruleId);
    expect(diagnosis.requiredAction).toBe(requiredAction);
    expect(FAULT_CLASSES).toContain(diagnosis.faultClass);
    expect(FAULT_REQUIRED_ACTIONS).toContain(diagnosis.requiredAction);
  });

  it('全部 12 类都在覆盖矩阵里（漏一类即失败）', () => {
    expect(new Set(CASES.map((entry) => entry.faultClass)).size).toBe(FAULT_CLASSES.length);
  });
});

describe('PHASE 1 确定性 —— 同一证据必然同一结论', () => {
  it('反复分类结果逐字相同（含去重键）', () => {
    const observation: FaultObservation = { ...BASE, errorName: 'AdapterMappingError', message: 'row 3 unparsable' };
    const at = new Date('2026-10-09T03:00:00.000Z');
    expect(classifyFault(observation)).toEqual(classifyFault(observation));
    expect(buildFaultIncidentIntent(observation, { now: at }).intent).toEqual(
      buildFaultIncidentIntent(observation, { now: at }).intent,
    );
  });

  it('Occurrence 次数不参与去重键（同因聚合、异因分离）', () => {
    const first = classifyFault({ ...BASE, errorName: 'AdapterMappingError', occurrenceCount: 1 });
    const second = classifyFault({ ...BASE, errorName: 'AdapterMappingError', occurrenceCount: 9 });
    const other = classifyFault({ ...BASE, errorName: 'TypeError' });
    expect(first.dedupeKey).toBe(second.dedupeKey);
    expect(first.dedupeKey).not.toBe(other.dedupeKey);
  });

  it('HTTP 403 不冒充"凭据过期"（无证据 ⇒ UNKNOWN_ERROR，保守不猜）', () => {
    const diagnosis = classifyFault({ ...BASE, httpStatus: 403, errorCode: 'NOT_AUTHORIZED' });
    expect(diagnosis.faultClass).not.toBe('TOKEN_EXPIRED');
    expect(diagnosis.faultClass).toBe('UNKNOWN_ERROR');
    expect(diagnosis.requiredAction).toBe('HUMAN_REVIEW');
  });
});

describe('PHASE 1 模型仅有辅助归因权（不能宣布事实 / 权限）', () => {
  it('模型声称的类别既不改变分类、也不改变风险与重试资格', () => {
    const observation: FaultObservation = {
      ...BASE,
      errorName: 'AdapterMappingError',
      modelHint: { claimedClass: 'TOKEN_EXPIRED', rationale: 'looks like an expired token' },
    };
    const withHint = classifyFault(observation);
    const withoutHint = classifyFault({ ...observation, modelHint: null });
    expect(withHint.faultClass).toBe('PARSER_FAILURE');
    expect(withHint.faultClass).toBe(withoutHint.faultClass);
    expect(withHint.riskClass).toBe(withoutHint.riskClass);
    expect(withHint.retryEligibility).toBe(withoutHint.retryEligibility);
    expect(withHint.requiredAction).toBe(withoutHint.requiredAction);
    expect(withHint.ownerGatedAction).toBe(withoutHint.ownerGatedAction);
    expect(withHint.untrustedModelHint).toMatchObject({
      source: 'MODEL',
      authority: 'NONE',
      claimedClass: 'TOKEN_EXPIRED',
      agreesWithDeterministicClass: false,
    });
  });

  it('即使模型"猜对"类别，权限仍为 NONE（一致 ≠ 授权）', () => {
    const annotation = annotateUntrustedModelHint({ claimedClass: 'PARSER_FAILURE' }, 'PARSER_FAILURE');
    expect(annotation).toMatchObject({ authority: 'NONE', agreesWithDeterministicClass: true });
  });

  it('模型提示文本同样脱敏后归档', () => {
    const annotation = annotateUntrustedModelHint(
      { claimedClass: 'API_TIMEOUT', rationale: 'Authorization: Bearer sk-live-9f8e7d6c5b4a3210' },
      'API_TIMEOUT',
    );
    expect(annotation?.rationale ?? '').not.toContain('sk-live-9f8e7d6c5b4a3210');
    expect(annotation?.rationale ?? '').not.toContain('Bearer');
  });
});

describe('PHASE 1 安全 / 权限边界：只允许更保守', () => {
  it('触及权限语义 ⇒ HIGH + 人工，且禁止自动重试', () => {
    const diagnosis = classifyFault({ ...BASE, adapterErrorCode: 'RATE_LIMITED', privilegeAffecting: true });
    expect(diagnosis.riskClass).toBe('HIGH');
    expect(diagnosis.requiredAction).toBe('HUMAN_REVIEW');
    expect(diagnosis.retryEligibility).toBe('NOT_RETRYABLE');
  });

  it('触及安全边界 ⇒ 风险升到 HIGH，自动恢复被收回', () => {
    const normal = classifyFault({ ...BASE, errorCode: 'PROVIDER_TIMEOUT' });
    const flagged = classifyFault({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', securityAffecting: true });
    expect(normal.requiredAction).toBe('AUTO_RECOVER');
    expect(flagged.riskClass).toBe('HIGH');
    expect(flagged.requiredAction).toBe('HUMAN_REVIEW');
  });

  it('AUTO_RECOVER 只可能出现在确定性可重试类别上', () => {
    for (const entry of CASES) {
      const diagnosis = classifyFault(entry.observation);
      if (diagnosis.requiredAction === 'AUTO_RECOVER') {
        expect(diagnosis.retryEligibility).toBe('AUTO_RETRY_BACKOFF');
      }
    }
  });

  it('需要 OWNER 的动作必须来自既有 OWNER-gated 清单（RSI 不能自我授权）', () => {
    const diagnosis = classifyFault({ ...BASE, httpStatus: 401 });
    expect(diagnosis.requiredAction).toBe('OWNER_ACTION');
    expect(diagnosis.ownerGatedAction).not.toBeNull();
    expect(requiresOwnerApproval(String(diagnosis.ownerGatedAction))).toBe(true);
  });
});

describe('PHASE 1 脱敏：故障数据不进模型也不落库', () => {
  it('Token / 授权串 / 密钥 / 邮箱 / 绝对路径在摘要与落库载荷中均不可见', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.abc123XYZ';
    const observation: FaultObservation = {
      ...BASE,
      environment: 'PRODUCTION',
      errorName: 'AdapterMappingError',
      message: `failed for buyer@example.test Bearer sk-live-9f8e7d6c5b4a3210 jwt=${jwt} path C:\\Users\\os\\secret\\token.txt order 1234567890`,
      organizationRef: 'org-secret-tenant',
      providerRef: 'AMAZON',
      taskRefs: ['task:recovery:LOGISTICS:1234567890'],
      evidenceRefs: ['file:C:\\Users\\os\\secret\\token.txt'],
    };
    const { diagnosis, intent } = buildFaultIncidentIntent(observation, { now: new Date('2026-10-09T00:00:00.000Z') });
    const serialized = JSON.stringify(intent) + JSON.stringify(diagnosis);

    for (const secret of ['sk-live-9f8e7d6c5b4a3210', jwt, 'buyer@example.test', 'C:\\Users\\os\\secret', 'org-secret-tenant']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('[redacted');
    expect(diagnosis.summary).not.toContain('Bearer');
  });

  it('组织 / Provider 只以不可逆引用落库（可关联、不可还原）', () => {
    const { intent } = buildFaultIncidentIntent({
      ...BASE,
      organizationRef: 'org-raw-tenant-id',
      providerRef: 'amazon',
    });
    expect(intent.sourceRefs.organizationRef).toMatch(/^org-[0-9a-f]{16}$/);
    expect(intent.sourceRefs.providerRef).toMatch(/^provider-[0-9a-f]{16}$/);
    expect(JSON.stringify(intent)).not.toContain('org-raw-tenant-id');
    // 同一输入 ⇒ 同一引用（可跨次关联）；不同输入 ⇒ 不同引用
    const other = buildFaultIncidentIntent({ ...BASE, organizationRef: 'org-other-tenant', providerRef: 'amazon' });
    expect(other.intent.sourceRefs.organizationRef).not.toBe(intent.sourceRefs.organizationRef);
    expect(other.intent.sourceRefs.providerRef).toBe(intent.sourceRefs.providerRef);
  });
});

describe('PHASE 1 可信 Incident 意图（复用既有容器契约）', () => {
  it('kind 与客户执行面严格区分，状态 / 风险等级落在既有值域内', () => {
    const { intent } = buildFaultIncidentIntent({ ...BASE, errorName: 'TypeError' }, { now: new Date('2026-10-09T02:00:00.000Z') });
    expect(intent.kind).toBe(INTERNAL_FAULT_INCIDENT_KIND);
    expect(intent.kind).not.toBe(CUSTOMER_GOAL_QUEUE_INCIDENT_KIND);
    expect(RSI_INCIDENT_STATES).toContain(intent.status);
    expect(RSI_RISK_CLASSES).toContain(intent.riskClass);
    expect(intent.status).toBe('DIAGNOSED');
    expect(intent.detectedAt).toBe('2026-10-09T02:00:00.000Z');
  });

  it('指令要求的 Incident 字段齐备（incidentId 由持久化层回填）', () => {
    const { intent } = buildFaultIncidentIntent(
      {
        ...BASE,
        errorCode: 'OUTPUT_SCHEMA_INVALID',
        providerRef: 'DHL',
        organizationRef: 'org-1',
        domain: 'CUSTOMS',
        taskRefs: ['task:recovery:CUSTOMS:abc'],
        evidenceRefs: ['run:123'],
        occurrenceCount: 7,
        stage: 'SCHEMA_VALIDATION',
      },
      { now: new Date('2026-10-09T02:00:00.000Z') },
    );
    for (const key of [
      'faultClass',
      'ruleId',
      'severity',
      'retryEligibility',
      'requiredAction',
      'summary',
      'errorCode',
      'sourceModule',
      'organizationRef',
      'providerRef',
      'domain',
      'affectedTaskRefs',
      'evidenceRefs',
      'occurrenceCount',
      'environment',
      'detectedAt',
    ]) {
      expect(Object.keys(intent.sourceRefs)).toContain(key);
    }
    expect(intent.sourceRefs.classificationAuthority).toBe('DETERMINISTIC_RULES_ONLY');
    expect(intent.sourceRefs.occurrenceCount).toBe(7);
  });

  it('边界声明：纯函数、确定性、模型无分类权 / 无授权权', () => {
    expect(FAULT_CLASSIFICATION_BOUNDARY).toMatchObject({
      pure: true,
      deterministicRulesOnly: true,
      modelMayClassify: false,
      modelMayGrantPermission: false,
      modelMayDeclareRootCauseVerified: false,
      redactsBeforePersistOrModel: true,
      unknownStaysUnknown: true,
    });
  });

  it('redactFaultText 对非字符串与空串返回空串（不抛异常、不发明内容）', () => {
    expect(redactFaultText(undefined)).toBe('');
    expect(redactFaultText(null)).toBe('');
    expect(redactFaultText('   ')).toBe('');
    expect(redactFaultText(42)).toBe('');
  });
});
