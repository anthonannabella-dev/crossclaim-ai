/** materialized by GLOBAL BACKLOG DISPATCHER（source_backlog_id=REGISTER-A13/A15（Settlement / Fee Preview PARTIAL）） */
import { run as templateRun } from "../../tools/autopilot/unit-templates/suite-evidence.mjs";
export const metadata = {
  "id": "BG-002-settlement-billing-linkage-evidence",
  "source_backlog_id": "REGISTER-A13/A15（Settlement / Fee Preview PARTIAL）",
  "title": "Settlement–Billing 联动与 fee guard 证据（资金真值链只读复核）",
  "scope": "核对 settlement/billing/fee 链与 fee guard 收口证据",
  "acceptance_criteria": "相关套件全绿；证据写入 RUN_LOG；HOLD_EXTERNAL 保持",
  "dependencies": [],
  "risk_class": "MEDIUM",
  "ARCH_REVIEW_REQUIRED": false,
  "HOST_ACTION_REQUIRED": false,
  "HOLD_EXTERNAL": true,
  "allowed_files": [
    "apps/api/src/**（只读测试）",
    ".autopilot/RUN_LOG.md"
  ],
  "boundary": "NO_REAL_MONEY / NO_AUTOPAY / NO_COLLECTION",
  "required_tests": [
    "settlement",
    "billing",
    "fee-guard"
  ],
  "priority": "P1",
  "template": "suite-evidence",
  "filters": [
    "settlement",
    "billing",
    "fee"
  ]
};
export async function run(context) { return templateRun({ ...context, metadata }); }
