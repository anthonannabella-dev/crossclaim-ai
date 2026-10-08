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
  /** PHASE 2：唯一 Model Gateway capability port（缺省 = 本次调用不使用模型，deterministic-first） */
  modelGateway?: import('./rsi-si-model-gateway').RsiSiModelGatewayPort;
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

/** FINAL-6：Recovery 保留 namespace —— 只有保留 pack id 能消费该 namespace 的任务 */
export const RECOVERY_TASK_DEDUPE_PREFIX = 'task:recovery:';
export const RECOVERY_RESERVED_PACK_ID = 'recovery-si';

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
  /** FINAL-6：'task:recovery:' namespace 为保留路由，只允许 reserved pack（recovery-si）消费 */
  recoveryNamespace: 'RESERVED（generic pack 不得消费；无正式 pack → BLOCK，不 fallback）',
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
  /** PHASE 2：唯一 Model Gateway port（由 host 用共享 Gateway 组装后注入） */
  modelGateway?: import('./rsi-si-model-gateway').RsiSiModelGatewayPort;
  log?: (line: string) => void;
  /**
   * P0-B1（审计 MSG-20261008-20）：domain step 的**可审计持久记录**钩子（host 注入）。
   * 只有 resolved pack 路径会回调；抛出异常时本 runner **fail-closed 降级为 BLOCK**
   * （绝不允许「审计写失败但仍报 PASS」）。
   */
  onEvidence?: (record: {
    taskId: string;
    dedupeKey: string;
    packId: string;
    status: RsiRunnerStatus;
    evidenceRef: string;
    guardActions: readonly RsiDomainPackGuardAction[];
    /** BLOCK 时的原因码（用于 durable 记录与幂等键；不含客户数据） */
    reasonCodes: readonly string[];
    organizationId?: string;
  }) => Promise<void> | void;
}): RsiDomainPackRunner {
  const dispatched: { taskId: string; packId: string; status: RsiRunnerStatus; guardActions: readonly RsiDomainPackGuardAction[] }[] = [];
  return {
    dispatchLog: () => dispatched,
    async run(task: RsiSafeTask) {
      // STEP 3 FINAL-6 CHANGE B：Recovery namespace 保留路由 ——
      // 该 namespace 的任务只能由保留 pack（recovery-si）消费；否则 BLOCK，绝不 fallback 给 generic pack。
      const isRecoveryNamespace = task.dedupeKey.startsWith(RECOVERY_TASK_DEDUPE_PREFIX);
      const pack = isRecoveryNamespace
        ? input.packs.find(
            (candidate) => candidate.packId === RECOVERY_RESERVED_PACK_ID && candidate.matches(task),
          )
        : input.packs.find((candidate) => candidate.matches(task));
      if (isRecoveryNamespace && pack === undefined) {
        input.log?.(
          'RSI_DOMAIN_PACK_RECOVERY_NAMESPACE_RESERVED task=' +
            task.id +
            ' -> BLOCK（Recovery 任务只能由 reserved pack 消费）',
        );
        dispatched.push({
          taskId: task.id,
          packId: '(recovery-namespace-unclaimed)',
          status: 'BLOCK',
          guardActions: [],
        });
        return { status: 'BLOCK', evidenceRef: 'domain-pack:recovery-namespace-unclaimed' };
      }
      if (pack === undefined) {
        input.log?.(`RSI_DOMAIN_PACK_UNMATCHED task=${task.id} -> BLOCK`);
        dispatched.push({ taskId: task.id, packId: '(unmatched)', status: 'BLOCK', guardActions: [] });
        return { status: 'BLOCK', evidenceRef: 'domain-pack:unmatched' };
      }
      const evidence = await pack.run({
        task,
        packId: pack.packId,
        ...(input.modelGateway === undefined ? {} : { modelGateway: input.modelGateway }),
      });
      /**
       * P0-B1：把本轮的**最终结论**交给 host 的持久记录器（PASS 与 BLOCK 都要留痕）。
       * 记录失败 ⇒ BLOCK（fail-closed）：宁可让任务停在等待裁决，也不让审计断链。
       */
      const persistOutcome = async (
        status: RsiRunnerStatus,
        evidenceRef: string,
        guardActions: readonly RsiDomainPackGuardAction[],
        reasonCodes: readonly string[],
      ): Promise<boolean> => {
        if (input.onEvidence === undefined) return true;
        try {
          await input.onEvidence({
            taskId: task.id,
            dedupeKey: task.dedupeKey,
            packId: pack.packId,
            status,
            evidenceRef,
            guardActions,
            reasonCodes,
            ...(task.organizationId === undefined ? {} : { organizationId: task.organizationId }),
          });
          return true;
        } catch (error) {
          input.log?.(
            `RSI_DOMAIN_PACK_OUTCOME_RECORD_FAILED task=${task.id} pack=${pack.packId} -> BLOCK (${String(
              (error as Error)?.message ?? error,
            )})`,
          );
          return false;
        }
      };
      if (evidence.externalWritePerformed !== false) {
        input.log?.(`RSI_DOMAIN_PACK_EXTERNAL_WRITE_REFUSED task=${task.id} pack=${pack.packId} -> BLOCK`);
        const evidenceRef = 'domain-pack:external-write-refused';
        const ok = await persistOutcome('BLOCK', evidenceRef, evidence.guardActions, evidence.reasonCodes);
        dispatched.push({ taskId: task.id, packId: pack.packId, status: 'BLOCK', guardActions: evidence.guardActions });
        if (!ok) return { status: 'BLOCK', evidenceRef: 'domain-pack:outcome-record-failed' };
        return { status: 'BLOCK', evidenceRef };
      }
      if (evidence.status === 'PASS' && evidence.evidenceRef.trim() === '') {
        const evidenceRef = 'domain-pack:evidence-missing';
        const ok = await persistOutcome('BLOCK', evidenceRef, evidence.guardActions, evidence.reasonCodes);
        dispatched.push({ taskId: task.id, packId: pack.packId, status: 'BLOCK', guardActions: evidence.guardActions });
        if (!ok) return { status: 'BLOCK', evidenceRef: 'domain-pack:outcome-record-failed' };
        return { status: 'BLOCK', evidenceRef };
      }
      const ok = await persistOutcome(evidence.status, evidence.evidenceRef, evidence.guardActions, evidence.reasonCodes);
      dispatched.push({ taskId: task.id, packId: pack.packId, status: evidence.status, guardActions: evidence.guardActions });
      if (!ok) return { status: 'BLOCK', evidenceRef: 'domain-pack:outcome-record-failed' };
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
