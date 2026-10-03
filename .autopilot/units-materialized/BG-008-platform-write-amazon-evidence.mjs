/** materialized by GLOBAL BACKLOG DISPATCHER（source_backlog_id=REGISTER-A1/A10（Platform Recovery + Action Guard PARTIAL）） */
import { run as templateRun } from "../../tools/autopilot/unit-templates/suite-evidence.mjs";
export const metadata = {
  "id": "BG-008-platform-write-amazon-evidence",
  "source_backlog_id": "REGISTER-A1/A10（Platform Recovery + Action Guard PARTIAL）",
  "title": "Platform write 账本与 Amazon 只读 adapter 证据核对",
  "scope": "核对 platform.write 账本（CAS/no-blind-retry）与 Amazon 只读 adapter 现状并留档",
  "acceptance_criteria": "platform-write / amazon 相关套件全绿；零外写",
  "dependencies": [],
  "risk_class": "MEDIUM",
  "ARCH_REVIEW_REQUIRED": false,
  "HOST_ACTION_REQUIRED": false,
  "HOLD_EXTERNAL": true,
  "allowed_files": [
    "apps/api/src/**（只读测试）",
    ".autopilot/RUN_LOG.md"
  ],
  "boundary": "NO_EXTERNAL_WRITE / NO_PRODUCTION_CREDENTIALS",
  "required_tests": [
    "platform-write",
    "amazon"
  ],
  "priority": "P2",
  "template": "suite-evidence",
  "filters": [
    "platform-write",
    "amazon"
  ]
};
export async function run(context) { return templateRun({ ...context, metadata }); }
