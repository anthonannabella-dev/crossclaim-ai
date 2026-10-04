/**
 * RSI 证据校验（RSI-RT-05）：PASS 必须由**真实 CI/测试证据**支撑
 * ---------------------------------------------------------------
 * 上一轮已做到：无给证据的 PASS 会被降级为 BLOCK。本模块把「证据」具体化：
 * runner 返回的 `evidenceRef` 只有在**同时**满足下列条件时才被接受：
 *   1) 不是「没有证据」的占位 token（unconfigured/timeout/not-allowed/spawn-failed）；
 *   2) CI artifact 中存在**至少一条已完成且 success** 的运行，**或** 测试 artifact 中存在**至少一条通过**；
 *   3) 若 runner 的 evidenceRef 里带有 `head:<sha>` 前缀，则该 sha 必须能在上述成功记录中匹配。
 *
 * 已知边界（诚实记录，下一步补）：尚未把 CI 记录与「任务领取时刻」做时间相关性校验，
 * 因此陈旧的既有成功记录在理论上仍可满足条件 2；这需要事件源提供 `startedAt/head` 关联。
 *
 * 纯函数 + 只读 artifact，不写库、不外写、不读凭据。
 */

export interface RsiCiEvidenceRecord {
  runId: string;
  head: string;
  status: string;
  conclusion: string;
}

export interface RsiTestEvidenceRecord {
  suite?: string;
  status?: string;
  passed?: boolean;
}

export const RSI_NO_EVIDENCE_TOKENS: readonly string[] = ['unconfigured', 'timeout', 'not-allowed', 'spawn-failed'];

const HEAD_PREFIX = /head:([0-9a-f]{7,40})/i;

export interface RsiEvidenceInput {
  ciResults: readonly RsiCiEvidenceRecord[];
  testResults: readonly RsiTestEvidenceRecord[];
}

export interface RsiEvidenceVerdict {
  ok: boolean;
  reason:
    | 'EVIDENCE_OK'
    | 'EVIDENCE_MISSING_TOKEN'
    | 'NO_SUCCESSFUL_CI_OR_TEST'
    | 'HEAD_NOT_EVIDENCED';
}

/** 是否存在「已完成且 success」的 CI，或「通过」的测试。 */
export function hasSuccessfulCiOrTest(input: RsiEvidenceInput): boolean {
  const ciOk = input.ciResults.some(
    (run) => String(run.status).toLowerCase() === 'completed' && String(run.conclusion).toLowerCase() === 'success',
  );
  const testOk = input.testResults.some(
    (record) => record.passed === true || String(record.status ?? '').toLowerCase() === 'pass',
  );
  return ciOk || testOk;
}

export function verifyRunnerEvidence(
  evidenceRef: string | undefined,
  input: RsiEvidenceInput,
): RsiEvidenceVerdict {
  const ref = typeof evidenceRef === 'string' ? evidenceRef.trim() : '';
  if (ref === '' || RSI_NO_EVIDENCE_TOKENS.includes(ref)) {
    return { ok: false, reason: 'EVIDENCE_MISSING_TOKEN' };
  }
  if (!hasSuccessfulCiOrTest(input)) {
    return { ok: false, reason: 'NO_SUCCESSFUL_CI_OR_TEST' };
  }
  const headMatch = HEAD_PREFIX.exec(ref);
  if (headMatch !== null) {
    const head = headMatch[1]!.toLowerCase();
    const evidenced = input.ciResults.some(
      (run) =>
        String(run.head).toLowerCase().startsWith(head) &&
        String(run.status).toLowerCase() === 'completed' &&
        String(run.conclusion).toLowerCase() === 'success',
    );
    if (!evidenced) return { ok: false, reason: 'HEAD_NOT_EVIDENCED' };
  }
  return { ok: true, reason: 'EVIDENCE_OK' };
}

/** 供组合根注入的校验器工厂（只读 artifact）。 */
export function createEvidenceVerifier(
  loadEvidence: () => Promise<RsiEvidenceInput>,
): (evidenceRef: string | undefined) => Promise<RsiEvidenceVerdict> {
  return async (evidenceRef) => verifyRunnerEvidence(evidenceRef, await loadEvidence());
}

export const RSI_EVIDENCE_VERIFIER_BOUNDARY = {
  passRequiresRealEvidence: true,
  noEvidenceTokensRejected: true,
  headCorrelationWhenPresent: true,
  claimedAtCorrelation: 'NOT_YET（下一步：用事件源时间戳排除陈旧证据）',
  readsCredentials: false,
  writesDatabase: false,
  performsExternalWrite: false,
} as const;
