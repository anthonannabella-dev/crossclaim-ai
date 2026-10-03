/** materialized by GLOBAL BACKLOG DISPATCHER（source_backlog_id=MSG-20261003-133 Q2③（GAP G11）） */
import { run as templateRun } from "../../tools/autopilot/unit-templates/suite-evidence.mjs";
export const metadata = {
  "id": "BG-012-customs-g4-http-trigger-wiring",
  "source_backlog_id": "MSG-20261003-133 Q2③（GAP G11）",
  "title": "Customs G4 HTTP **内部触发**接线（受 Action Guard 保护；仍不 filing）",
  "scope": "内部触发端点 + RBAC/Action Guard；不接真实 filing、不 EXTERNAL_WRITE",
  "acceptance_criteria": "路由级 E2E（401/403/404/409/200）+ API.md 同步；filingSubmitted=false",
  "dependencies": [
    "BG-009-carrier-settlement-readonly-reconciliation"
  ],
  "risk_class": "MEDIUM",
  "ARCH_REVIEW_REQUIRED": true,
  "HOST_ACTION_REQUIRED": false,
  "HOLD_EXTERNAL": true,
  "allowed_files": [
    "apps/api/src/services/workflow/**",
    "apps/api/src/server.ts",
    "API.md"
  ],
  "boundary": "NO_FILING / NO_EXTERNAL_WRITE",
  "required_tests": [
    "customs-return-claim-evidence-http-e2e-db"
  ],
  "priority": "P2",
  "template": "suite-evidence",
  "filters": [
    "customs-return-claim-evidence-http-e2e-db"
  ]
};
export async function run(context) { return templateRun({ ...context, metadata }); }
