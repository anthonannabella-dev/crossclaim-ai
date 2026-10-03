/** materialized by GLOBAL BACKLOG DISPATCHER（source_backlog_id=REGISTER-A16（Dashboard / Admin / Operations PARTIAL）） */
import { run as templateRun } from "../../tools/autopilot/unit-templates/suite-evidence.mjs";
export const metadata = {
  "id": "BG-003-dashboard-ops-readonly-evidence",
  "source_backlog_id": "REGISTER-A16（Dashboard / Admin / Operations PARTIAL）",
  "title": "Dashboard / Admin / Operations 只读面证据",
  "scope": "核对 admin/operations 只读面与 RBAC 现状并留档",
  "acceptance_criteria": "相关套件全绿；证据写入 RUN_LOG",
  "dependencies": [],
  "risk_class": "LOW",
  "ARCH_REVIEW_REQUIRED": false,
  "HOST_ACTION_REQUIRED": false,
  "HOLD_EXTERNAL": true,
  "allowed_files": [
    "apps/api/src/**（只读测试）",
    ".autopilot/RUN_LOG.md"
  ],
  "boundary": "READ_ONLY",
  "required_tests": [
    "admin",
    "operations"
  ],
  "priority": "P2",
  "template": "suite-evidence",
  "filters": [
    "admin",
    "operations"
  ]
};
export async function run(context) { return templateRun({ ...context, metadata }); }
