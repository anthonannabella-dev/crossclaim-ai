/** materialized by GLOBAL BACKLOG DISPATCHER（source_backlog_id=GAP G11（Customs G4 HTTP 接线）） */
import { run as templateRun } from "../../tools/autopilot/unit-templates/suite-evidence.mjs";
export const metadata = {
  "id": "BG-005-customs-g4-evidence-chain-verification",
  "source_backlog_id": "GAP G11（Customs G4 HTTP 接线）",
  "title": "Customs G4 证据链 HTTP/E2E 现状复核",
  "scope": "核对 customs 证据链只读路由与 E2E 现状（401/403/404/200 + 租户隔离）",
  "acceptance_criteria": "customs 证据链套件全绿；证据写入 RUN_LOG",
  "dependencies": [],
  "risk_class": "MEDIUM",
  "ARCH_REVIEW_REQUIRED": false,
  "HOST_ACTION_REQUIRED": false,
  "HOLD_EXTERNAL": true,
  "allowed_files": [
    "apps/api/src/**（只读测试）",
    ".autopilot/RUN_LOG.md"
  ],
  "boundary": "NO_FILING / NO_EXTERNAL_WRITE",
  "required_tests": [
    "customs-return-claim-evidence",
    "customs-claim-ready-http"
  ],
  "priority": "P1",
  "template": "suite-evidence",
  "filters": [
    "customs-return-claim-evidence",
    "customs-claim-ready-http"
  ]
};
export async function run(context) { return templateRun({ ...context, metadata }); }
