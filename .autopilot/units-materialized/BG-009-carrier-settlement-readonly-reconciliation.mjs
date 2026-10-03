/** materialized by GLOBAL BACKLOG DISPATCHER（source_backlog_id=MSG-20261003-133 Q2① / REGISTER-A13「结果事实 → 到账事实」断点） */
import { run as templateRun } from "../../tools/autopilot/unit-templates/suite-evidence.mjs";
export const metadata = {
  "id": "BG-009-carrier-settlement-readonly-reconciliation",
  "source_backlog_id": "MSG-20261003-133 Q2① / REGISTER-A13「结果事实 → 到账事实」断点",
  "title": "Carrier 结果 → Settlement 只读对账投影（APPROVED/PAID ≠ RECEIVED）",
  "scope": "只读 reconciliation projection / discrepancy；不创建 Settlement 事实、不改 Payment/Billing、无银行证据不得升级为 RECEIVED",
  "acceptance_criteria": "投影语义与边界测试全绿（APPROVED/PAID 无证据→AWAITING_SETTLEMENT_EVIDENCE；金额不一致→DISCREPANCY；币种不一致→INDETERMINATE；跨租户→拒绝）",
  "dependencies": [],
  "risk_class": "MEDIUM",
  "ARCH_REVIEW_REQUIRED": false,
  "HOST_ACTION_REQUIRED": false,
  "HOLD_EXTERNAL": true,
  "allowed_files": [
    "apps/api/src/services/settlement/**",
    "apps/api/src/__tests__/**"
  ],
  "boundary": "READ_ONLY / NO_MONEY_WRITE / NO_FX",
  "required_tests": [
    "carrier-settlement-reconciliation-readonly"
  ],
  "priority": "P0",
  "template": "suite-evidence",
  "filters": [
    "carrier-settlement-reconciliation-readonly"
  ]
};
export async function run(context) { return templateRun({ ...context, metadata }); }
