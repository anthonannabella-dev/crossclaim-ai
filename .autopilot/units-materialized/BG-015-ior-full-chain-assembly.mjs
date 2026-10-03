/** materialized by GLOBAL BACKLOG DISPATCHER（source_backlog_id=IOR 指令 ⑪ / I3） */
import { run as templateRun } from "../../tools/autopilot/unit-templates/suite-evidence.mjs";
export const metadata = {
  "id": "BG-015-ior-full-chain-assembly",
  "source_backlog_id": "IOR 指令 ⑪ / I3",
  "title": "Enterprise IOR 全链装配（Entry→IOR→claimant/right→remedy+deadline→qualification→evidence→estimate→claim-ready→broker authorization→filing provider→refund destination），fail-closed 零外写",
  "scope": "只读装配层 + 逐 stage 就绪报告；不新增外部调用、不改 Schema",
  "acceptance_criteria": "任一环节不明确 → 对应 stage 不 READY 且 claimPackageReady=false；autoSubmitAllowed 恒 false",
  "dependencies": [
    "BG-013-ior-facts-persistence-schema-delta"
  ],
  "risk_class": "MEDIUM",
  "ARCH_REVIEW_REQUIRED": false,
  "HOST_ACTION_REQUIRED": false,
  "HOLD_EXTERNAL": true,
  "allowed_files": [
    "apps/api/src/services/**"
  ],
  "boundary": "NO_EXTERNAL_CALL",
  "required_tests": [
    "enterprise-ior-layer"
  ],
  "priority": "P1",
  "template": "suite-evidence",
  "filters": [
    "enterprise-ior-layer"
  ]
};
export async function run(context) { return templateRun({ ...context, metadata }); }
