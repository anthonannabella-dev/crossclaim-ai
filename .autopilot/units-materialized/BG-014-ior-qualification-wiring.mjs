/** materialized by GLOBAL BACKLOG DISPATCHER（source_backlog_id=IOR 指令 ⑥ / I2） */
import { run as templateRun } from "../../tools/autopilot/unit-templates/suite-evidence.mjs";
export const metadata = {
  "id": "BG-014-ior-qualification-wiring",
  "source_backlog_id": "IOR 指令 ⑥ / I2",
  "title": "Enterprise IOR readiness 输入接入现有 Qualification / Economics Gate（复用，不建第二套）",
  "scope": "只增输入平面与判定接线；不改变既有 gate 语义",
  "acceptance_criteria": "IOR readiness 缺失/歧义 → INDETERMINATE/NOT_QUALIFIED；昂贵调用仍在 gate 之后",
  "dependencies": [],
  "risk_class": "MEDIUM",
  "ARCH_REVIEW_REQUIRED": false,
  "HOST_ACTION_REQUIRED": false,
  "HOLD_EXTERNAL": true,
  "allowed_files": [
    "apps/api/src/services/**"
  ],
  "boundary": "NO_EXTERNAL_CALL",
  "required_tests": [
    "customer-qualification-gate"
  ],
  "priority": "P1",
  "template": "suite-evidence",
  "filters": [
    "customer-qualification-gate"
  ]
};
export async function run(context) { return templateRun({ ...context, metadata }); }
