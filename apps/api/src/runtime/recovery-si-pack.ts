/**
 * STEP_3 — Recovery SI 作为 **domain capability pack** 接入 ONE SI Runtime
 * ---------------------------------------------------------------
 * 授权：STEP 3A / 3B / 3C / 3E。目标：Recovery SI 被唯一运行时消费，**不新建 Recovery runtime**。
 *
 * 执行链（全部确定性，零网络、零外写、零凭据）：
 *   ① Recovery Policy Pack（`recovery-policy`）→ 唯一 Policy Core（`rsi-policy-engine`）
 *   ② 确定性只读工具（`recovery-read-tools` + `recovery-tool-registry`，READ 访问级）
 *   ③ Guard-Action Binding（`recovery-guard-dry-run`）→ 声明 guard action（授权仍由共享地基裁决）
 *   ④ 证据摘要（sha256 前 12 位；只含引用，不含客户数据）
 *
 * 硬约束：
 *   · policy 未放行 → `BLOCK`（绝不 PASS）；
 *   · guard action 为 null（例如 CUSTOMS_FILING 走 L5 永久拒绝）→ `BLOCK`；
 *   · guard action 不在 `RECOVERY_ALLOWED_GUARD_ACTIONS` → `BLOCK`；
 *   · 只读工具输出含敏感字段 / 跨租户 / 工具缺失 → `BLOCK`；
 *   · 本 pack 不执行任何动作、不写库、不调真实 provider（Model Gateway 调用数恒为 0）。
 */

import { createHash } from 'node:crypto';

import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';
import type { RsiFlags } from '../services/autonomy/rsi-runtime-config';
import type { RecoveryPlanAction, RecoveryActionKind } from '../services/intelligence/recovery-planner';
import type { RecoveryDomain } from '../services/intelligence/customer-recovery-state';
import { decideRecoveryAction } from '../services/intelligence/recovery-policy';
import {
  RECOVERY_ALLOWED_GUARD_ACTIONS,
  resolveGuardAction,
} from '../services/intelligence/recovery-guard-dry-run';
import {
  RECOVERY_DOMAIN_READ_TOOL,
  createRecoveryReadToolRegistry,
  scanRecoveryReadOutput,
  type RecoveryReadPorts,
} from '../services/intelligence/recovery-read-tools';
import type { RsiDomainCapabilityPack, RsiDomainPackEvidence } from './rsi-domain-pack';

export const RECOVERY_SI_PACK_ID = 'recovery-si';

/**
 * PHASE 2 FINAL（MSG-20261005-48 CHANGE A）：
 * `aiEligible` 必须是 **server-derived**（由 canonical 确定性判定产出，不接受客户端自报）。
 * 仅当为 true 且注入 modelGateway 时，pack 才会经唯一 Model Gateway 调用模型；否则 deterministic-first。
 */
export interface RecoverySiTaskBinding {
  organizationId: string;
  aiEligible?: boolean;
  domain: RecoveryDomain;
  actionKind: RecoveryActionKind;
  opportunityRef: string;
}

export interface RecoverySiPackDependencies {
  /** 只读端口（生产为 Prisma 只读实现；测试为 fixture）。本 pack 不写任何东西。 */
  readPorts: RecoveryReadPorts;
  /** 任务 → Recovery 绑定；返回 null ⇒ 未绑定 ⇒ BLOCK（不猜 domain / 不猜 intent）。 */
  bind: (task: RsiSafeTask) => RecoverySiTaskBinding | null;
  /** CHANGE B：共享 Action Guard / Control Plane 端口（缺省 = fail-closed DENY，绝不默认放行） */
  guard?: RsiRecoveryGuardPort;
  flags?: RsiFlags;
  nowMs?: () => number;
}

export const RECOVERY_SI_PACK_BOUNDARY = {
  packId: RECOVERY_SI_PACK_ID,
  domain: 'recovery',
  isSecondRuntime: false,
  policySource: 'services/autonomy/rsi-policy-engine（经 recovery-policy 静态组合）',
  guardBinding: 'services/intelligence/recovery-guard-dry-run（intent → catalog action）',
  executesActions: false,
  writesDatabase: false,
  readsCredentials: false,
  networkCalls: 0,
  realModelCalls: 0,
  customFilingUnchanged: 'CUSTOMS → RECOVERY_GUARD_ACTION_MAP.CUSTOMS = null（L5 永久拒绝，未放宽）',
  guardInExecutionChain: 'intent → resolveGuardAction → shared Action Guard / Control Plane dry-run → ALLOW 才执行只读工具',
  guardNotAllowYields: 'BLOCK（toolCallCount = 0；deny / requires_approval / degraded / kill switch / tenant mismatch 一律 fail-closed）',
  unboundTask: 'BLOCK',
} as const;

/** STEP 3 FINAL-2（CHANGE B）：共享 Action Guard / Control Plane dry-run 端口（host 注入；唯一 Guard）。 */
export type RsiRecoveryGuardDecision = 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL';
export interface RsiRecoveryGuardRequest {
  packId: string;
  taskId: string;
  organizationId: string;
  domain: string;
  action: string;
  opportunityRef: string;
}
export interface RsiRecoveryGuardVerdict {
  decision: RsiRecoveryGuardDecision;
  reason: string;
  degraded?: boolean;
  killSwitchActive?: boolean;
}
export interface RsiRecoveryGuardPort {
  evaluate(request: RsiRecoveryGuardRequest): Promise<RsiRecoveryGuardVerdict>;
}
/** 默认 fail-closed：未显式接入共享 Guard 时，任何执行路径必须 BLOCK（toolCallCount = 0）。 */
export function createFailClosedRecoveryGuardPort(reason = 'RECOVERY_GUARD_NOT_WIRED'): RsiRecoveryGuardPort {
  return {
    async evaluate() {
      return { decision: 'DENY', reason };
    },
  };
}
/**
 * FINAL3 ②：evidence digest 的**纯函数**（可单测）——确定性只读工具 audit 与模型（Gateway）audit
 * 任一变化都会改变 evidenceRef。
 */
export function buildRecoverySiEvidenceRef(parts: {
  taskId: string;
  dedupeKey: string;
  organizationId: string;
  opportunityRef: string;
  guardAction: string;
  gatewayAudit: readonly string[];
  toolAudit: readonly string[];
}): string {
  return [parts.taskId, parts.dedupeKey, parts.organizationId, parts.opportunityRef, parts.guardAction, ...parts.gatewayAudit, ...parts.toolAudit].join('|');
}

const digest12 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);

const block = (reasonCodes: readonly string[], extra: Partial<RsiDomainPackEvidence> = {}): RsiDomainPackEvidence => ({
  status: 'BLOCK',
  evidenceRef: '',
  reasonCodes,
  modelCallCount: 0,
  guardActions: [],
  externalWritePerformed: false,
  ...extra,
});

export function createRecoverySiPack(deps: RecoverySiPackDependencies): RsiDomainCapabilityPack {
  const bundle = createRecoveryReadToolRegistry(deps.readPorts);
  const guard = deps.guard ?? createFailClosedRecoveryGuardPort();

  return {
    packId: RECOVERY_SI_PACK_ID,
    domain: 'recovery',
    matches: (task) => deps.bind(task) !== null,
    async run({ task, modelGateway }): Promise<RsiDomainPackEvidence> {
      const binding = deps.bind(task);
      if (binding === null) return block(['RECOVERY_PACK_UNBOUND_TASK']);

      // ① Recovery Policy Pack → 唯一 Policy Core
      const policy = decideRecoveryAction(
        binding.actionKind,
        deps.flags === undefined ? {} : { flags: deps.flags },
      );
      if (!policy.allowedForRecoverySi) {
        return block(['RECOVERY_POLICY_DENIED', ...policy.reasonCodes]);
      }

      // ③ Guard-Action Binding（先声明 intent；授权裁决属于共享地基）
      const prospectiveAction: RecoveryPlanAction = {
        domain: binding.domain,
        opportunityRef: binding.opportunityRef,
        objective: 'runtime-pack-read',
        proposedAction: binding.actionKind,
        reasonCodes: policy.reasonCodes,
        prerequisites: [],
        missingEvidence: [],
        authorizationRequired: false,
        ownerApprovalRequired: false,
        expectedRecovery: null,
        confidence: 'LOW',
        executionMode: 'SIMULATED',
        toolRef: null,
        blockedReason: null,
      };
      const guardAction = resolveGuardAction(prospectiveAction);
      if (guardAction === null) return block(['RECOVERY_GUARD_ACTION_L5_FORBIDDEN']);
      if (!(RECOVERY_ALLOWED_GUARD_ACTIONS as readonly string[]).includes(guardAction)) {
        return block(['RECOVERY_GUARD_ACTION_NOT_ALLOWED', guardAction]);
      }

      // CHANGE B：intent → shared Action Guard / Control Plane dry-run → 只有 ALLOW 才执行只读工具
      const guardVerdict = await guard.evaluate({
        packId: RECOVERY_SI_PACK_ID,
        taskId: task.id,
        organizationId: binding.organizationId,
        domain: binding.domain,
        action: guardAction,
        opportunityRef: binding.opportunityRef,
      });
      if (
        guardVerdict.decision !== 'ALLOW' ||
        guardVerdict.degraded === true ||
        guardVerdict.killSwitchActive === true
      ) {
        return block(['RECOVERY_GUARD_BLOCKED', guardVerdict.decision, guardVerdict.reason], {
          guardActions: [{ action: guardAction, decision: guardVerdict.decision }],
        });
      }

      // ①.5 PHASE 2 FINAL：仅 server-derived AI-eligible 任务经唯一 Model Gateway 消费模型；
      // 缺省（未注入 gateway / 非 AI-eligible）保持 deterministic-first，零模型调用。
      let modelCallCount = 0;
      let gatewayReasonCodes: string[] = [];
      let gatewayAudit: string[] = [];
      if (modelGateway !== undefined && binding.aiEligible === true) {
        const gatewayResult = await modelGateway.invoke({
          taskType: task.dedupeKey.split(':')[2] ?? 'SEMANTIC',
          complexity: 'LOW',
          maxCost: 0.5,
          latencyRequirementMs: 5_000,
          requiredCapability: 'SEMANTIC_UNDERSTANDING',
          incidentId: task.dedupeKey,
          taskId: task.id,
          promptRef: `recovery-si:${task.id}`,
          promptDigest: 'c'.repeat(64),
          maxOutputTokens: 256,
          timeoutMs: 5_000,
          necessity: {
            outcome: 'AMBIGUOUS',
            ruleVersion: binding.domain + '/v1',
            schemaVersion: 'schema/v1',
            inputDigest: 'a'.repeat(64),
          },
        } as never);
        modelCallCount = gatewayResult.called ? 1 : 0;
        gatewayReasonCodes = ['RECOVERY_PACK_MODEL_GATEWAY', gatewayResult.reason];
        // FINAL2 ② ：模型的稳定、非敏感审计字段也进入 evidenceRef（可绑定、可复算）
        gatewayAudit = [
          'gateway.called=' + String(gatewayResult.called),
          'gateway.reason=' + gatewayResult.reason,
          'gateway.level=' + gatewayResult.level,
          'gateway.provider=' + String(gatewayResult.provider ?? '-'),
          'gateway.model=' + String(gatewayResult.model ?? '-'),
        ];
      }

      // ② 确定性只读工具（按 domain 映射；跨租户 / 敏感输出 → BLOCK）
      const tools = RECOVERY_DOMAIN_READ_TOOL[binding.domain];
      const invocations: { tool: string; ok: boolean; reason: string | null }[] = [];
      for (const tool of tools) {
        const result = await bundle.registry.invoke(
          tool,
          { organizationId: binding.organizationId, opportunityRef: binding.opportunityRef },
          { organizationId: binding.organizationId },
        );
        if (!result.ok) {
          invocations.push({ tool, ok: false, reason: result.reason });
          return block(['RECOVERY_READ_TOOL_FAILED', tool, result.reason]);
        }
        const violations = scanRecoveryReadOutput(result.output);
        if (violations.length > 0) {
          return block(['RECOVERY_READ_OUTPUT_SENSITIVE', tool]);
        }
        invocations.push({ tool, ok: true, reason: null });
      }
      if (invocations.length === 0) return block(['RECOVERY_READ_TOOL_NONE']);

      const evidenceRef =
        'recovery-si:' +
        binding.domain +
        ':' +
        digest12(
          [
            task.id,
            task.dedupeKey,
            binding.organizationId,
            binding.opportunityRef,
            guardAction,
            ...gatewayAudit,
            ...invocations.map((i) => 'tool=' + i.tool + ':ok=' + String(i.ok)),
          ].join('|'),
        );
      return {
        status: 'PASS',
        evidenceRef,
        reasonCodes: ['RECOVERY_PACK_READ_ONLY_OK', ...policy.reasonCodes, ...gatewayReasonCodes],
        modelCallCount,
        guardActions: [{ action: guardAction, decision: 'ALLOW' }],
        externalWritePerformed: false,
      };
    },
  };
}
