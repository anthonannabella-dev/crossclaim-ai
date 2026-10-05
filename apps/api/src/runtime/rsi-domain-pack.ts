/**
 * STEP_3 — ONE CrossClaim SI Runtime：Domain Capability Pack 合同与派发
 * ---------------------------------------------------------------
 * 授权：HOST AUTHORIZATION — STEP 3: CROSSCLAIM SI RUNTIME / POLICY WIRING
 * 依据：MSG-20261005-29（SI-RSI Unification = PASS / CLOSED，`OPTION_A_LOGICAL_UNIFICATION`）
 *      + `docs/releases/SI-RUNTIME-COMPONENT-REGISTRY.md`（唯一 owner 表）
 *
 * 目的：让 Recovery SI 作为 **domain capability pack** 被唯一产品运行时消费，
 *      而不是另起一个 Recovery runtime。
 *
 * 硬约束：
 *   · 唯一 runtime：本模块只做**派发**，不创建事件循环 / 控制器 / 调度器；
 *   · 未匹配任何 pack 的任务 → `BLOCK`（fail-closed；绝不 PASS、绝不 no-op 成功）；
 *   · pack 不得自报 `externalWritePerformed: true` 后仍判 PASS —— 一律降级为 BLOCK；
 *   · pack 不得自判 Action Guard / Control Plane / Kill Switch / HITL；这些由共享地基在
 *     pack 声明 guard action 之后统一裁决（`RECOVERY_GUARD_DRY_RUN_BOUNDARY`）。
 */

import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';
import type { RsiEvidenceRunner, RsiRunnerStatus } from './rsi-task-runner';

export interface RsiDomainPackContext {
  task: RsiSafeTask;
  packId: string;
}

export interface RsiDomainPackGuardAction {
  action: string;
  decision: string;
}

export interface RsiDomainPackEvidence {
  status: RsiRunnerStatus;
  /** 证据引用（必须是非 token 值，否则控制器不会接受 PASS） */
  evidenceRef: string;
  reasonCodes: readonly string[];
  /** 本轮真实 Model Gateway 调用次数（deterministic-first ⇒ 通常 0） */
  modelCallCount: number;
  /** pack 声明触及的 guard action 与其 dry-run 决策（授权仍由共享地基裁决） */
  guardActions: readonly RsiDomainPackGuardAction[];
  /** pack 自身**永不**执行外部写；声明为 true 会被派发层降级为 BLOCK */
  externalWritePerformed: boolean;
}

export interface RsiDomainCapabilityPack {
  readonly packId: string;
  readonly domain: string;
  matches(task: RsiSafeTask): boolean;
  run(context: RsiDomainPackContext): Promise<RsiDomainPackEvidence>;
}

export const RSI_DOMAIN_PACK_BOUNDARY = {
  createsRuntime: false,
  createsScheduler: false,
  createsSecondPolicyEngine: false,
  dynamicSelfRegistration: 'FORBIDDEN（静态组合；runtime mutable registry 禁止）',
  unmatchedTask: 'BLOCK（fail-closed；绝不 PASS）',
  packSelfGrantedExternalWrite: 'BLOCK（声明 externalWritePerformed=true 即降级）',
  guardDecisionOwner: 'services/action-guard（pack 只能声明 intent）',
  policyOwner: 'services/autonomy/rsi-policy-engine（唯一 Policy Core）',
  modelGatewayOwner: 'services/autonomy/rsi-model-router（唯一 Model Gateway）',
} as const;

export interface RsiDomainPackRunner extends RsiEvidenceRunner {
  /** 派发记录（只读；用于 E2E / 审计断言，不含客户数据） */
  dispatchLog(): readonly { taskId: string; packId: string; status: RsiRunnerStatus; guardActions: readonly RsiDomainPackGuardAction[] }[];
}

/**
 * 把一组 domain capability pack 组装成唯一 runner（供 `composeRsiRuntime` 注入）。
 * 选择规则：按 pack 声明顺序取第一个 `matches(task)` 为真的 pack；没有匹配 → `BLOCK`。
 */
export function createRsiDomainPackRunner(input: {
  packs: readonly RsiDomainCapabilityPack[];
  log?: (line: string) => void;
}): RsiDomainPackRunner {
  const dispatched: { taskId: string; packId: string; status: RsiRunnerStatus; guardActions: readonly RsiDomainPackGuardAction[] }[] = [];
  return {
    dispatchLog: () => dispatched,
    async run(task: RsiSafeTask) {
      const pack = input.packs.find((candidate) => candidate.matches(task));
      if (pack === undefined) {
        input.log?.(`RSI_DOMAIN_PACK_UNMATCHED task=${task.id} -> BLOCK`);
        dispatched.push({ taskId: task.id, packId: '(unmatched)', status: 'BLOCK', guardActions: [] });
        return { status: 'BLOCK', evidenceRef: 'domain-pack:unmatched' };
      }
      const evidence = await pack.run({ task, packId: pack.packId });
      if (evidence.externalWritePerformed !== false) {
        input.log?.(`RSI_DOMAIN_PACK_EXTERNAL_WRITE_REFUSED task=${task.id} pack=${pack.packId} -> BLOCK`);
        dispatched.push({ taskId: task.id, packId: pack.packId, status: 'BLOCK', guardActions: evidence.guardActions });
        return { status: 'BLOCK', evidenceRef: 'domain-pack:external-write-refused' };
      }
      if (evidence.status === 'PASS' && evidence.evidenceRef.trim() === '') {
        dispatched.push({ taskId: task.id, packId: pack.packId, status: 'BLOCK', guardActions: evidence.guardActions });
        return { status: 'BLOCK', evidenceRef: 'domain-pack:evidence-missing' };
      }
      dispatched.push({ taskId: task.id, packId: pack.packId, status: evidence.status, guardActions: evidence.guardActions });
      return { status: evidence.status, evidenceRef: evidence.evidenceRef };
    },
  };
}

/**
 * 运行时成员描述（用于架构回归断言「只有一个 runtime」）。
 * 只描述**产品运行时**成员；`tools/autopilot/**` 永远不在其中（DEV_SCOPE）。
 */
export function describeRsiRuntimeMembers(packs: readonly RsiDomainCapabilityPack[]): {
  runtimeOwner: string;
  eventLoopOwner: string;
  controllerOwner: string;
  domainPacks: readonly string[];
  secondRuntime: 0;
  devScopeMembers: readonly string[];
} {
  return {
    runtimeOwner: 'apps/api/src/runtime/rsi-run.ts',
    eventLoopOwner: 'apps/api/src/runtime/rsi-event-loop.ts',
    controllerOwner: 'apps/api/src/runtime/rsi-controller-continuation.ts',
    domainPacks: packs.map((pack) => pack.packId),
    secondRuntime: 0,
    devScopeMembers: ['tools/autopilot/**'],
  };
}
