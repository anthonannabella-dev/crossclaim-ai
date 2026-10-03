/**
 * EVIDENCE 只读动作 —— 受保护动作 `evidence.read`（Gate 7 / ② 下一小批次 · READ_ONLY）
 * ---------------------------------------------------------------------------------
 * 依据 MSG-20261001-13 §5：核对真实证据读取入口并接入既有 Action Guard 契约。
 *
 * 纪律：
 *   - 只读动作：**无人工审批**，也不套用 INTERNAL_WRITE 的控制面模式限制（READ_ONLY 风险类由
 *     `evaluateActionGuard` 单独判定：只需能力状态可用；缺 guard 与状态不可用一律失败关闭）；
 *   - 租户、当前主体权限、案件与证据归属检查由既有 `listCaseEvidence` 完成
 *     （跨租户 → 404 NOT_FOUND；无权限主体 → 403 FORBIDDEN）；
 *   - 拒绝响应不得包含证据内容、下载地址或存储引用；读取本身不推进任何业务状态，
 *     也不触发平台或资金动作。
 */

export const EVIDENCE_READ_ACTION = 'evidence.read';
