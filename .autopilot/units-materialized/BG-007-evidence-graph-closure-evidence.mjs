/** materialized by GLOBAL BACKLOG DISPATCHER（source_backlog_id=REGISTER-A6（Evidence / Recovery Graph PARTIAL）） */
import { run as templateRun } from "../../tools/autopilot/unit-templates/suite-evidence.mjs";
export const metadata = {
  "id": "BG-007-evidence-graph-closure-evidence",
  "source_backlog_id": "REGISTER-A6（Evidence / Recovery Graph PARTIAL）",
  "title": "Evidence / Recovery Graph 证据层现状核对（evidence artifact / promotion / POD evidence）",
  "scope": "核对 evidence 层与图结构相关套件当前实现状态并留档",
  "acceptance_criteria": "evidence 相关套件全绿；证据写入 RUN_LOG",
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
    "evidence",
    "pod-evidence",
    "canonical"
  ],
  "priority": "P2",
  "template": "suite-evidence",
  "filters": [
    "evidence",
    "pod-evidence",
    "canonical"
  ]
};
export async function run(context) { return templateRun({ ...context, metadata }); }
