/**
 * APPEAL 提交载荷快照（CHANGE A，MSG-20261001-15 §3）
 * ---------------------------------------------------
 * 绑定对象 ID 不等于绑定实际提交载荷：审批必须以**版本化的服务端快照**为绑定对象。
 *   快照 = { version, appealId, caseId, claimId, round, bodyRule, bodyDigest }
 *   - bodyRule 为服务端**正文选择规则**（优先 finalText，否则 aiDraftText）；
 *   - bodyDigest 为所选正文的 sha256（正文为空/纯空白 → 快照为 null，提交失败关闭）；
 *   - digest = sha256(canonicalJson(snapshot))，审批创建与执行核验**共用**本函数，
 *     客户端无法仅凭自填摘要宣称绑定了服务端事实。
 */
import { createHash } from 'node:crypto';

export const APPEAL_SNAPSHOT_VERSION = 'appeal-submission/v1';

export interface AppealSnapshotInput {
  appealId: string;
  caseId: string;
  claimId: string;
  round: number;
  finalText?: string | null;
  aiDraftText?: string | null;
}

export interface AppealSubmissionSnapshot {
  version: string;
  appealId: string;
  caseId: string;
  claimId: string;
  round: number;
  bodyRule: 'FINAL_TEXT' | 'AI_DRAFT_TEXT';
  bodyDigest: string;
  bodyLength: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 规范化 JSON：键按字典序、无多余空白（审批创建与执行核验必须逐字一致） */
export function canonicalJson(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  return JSON.stringify(keys.map((key) => [key, value[key]]));
}

/** 构造快照；正文为空（缺失或纯空白）→ null（失败关闭） */
export function buildAppealSubmissionSnapshot(input: AppealSnapshotInput): AppealSubmissionSnapshot | null {
  const finalText = typeof input.finalText === 'string' ? input.finalText.trim() : '';
  const aiDraftText = typeof input.aiDraftText === 'string' ? input.aiDraftText.trim() : '';
  const bodyRule = finalText !== '' ? 'FINAL_TEXT' : aiDraftText !== '' ? 'AI_DRAFT_TEXT' : null;
  if (!bodyRule) return null;
  const body = bodyRule === 'FINAL_TEXT' ? finalText : aiDraftText;
  return {
    version: APPEAL_SNAPSHOT_VERSION,
    appealId: input.appealId,
    caseId: input.caseId,
    claimId: input.claimId,
    round: input.round,
    bodyRule,
    bodyDigest: sha256(body),
    bodyLength: body.length,
  };
}

/** 快照确定性摘要：审批绑定的 basisReference 即此值 */
export function appealSubmissionDigest(snapshot: AppealSubmissionSnapshot): string {
  return sha256(canonicalJson(snapshot as unknown as Record<string, unknown>));
}
