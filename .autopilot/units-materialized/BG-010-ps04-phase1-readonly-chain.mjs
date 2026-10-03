/** materialized by GLOBAL BACKLOG DISPATCHER（source_backlog_id=MSG-20261003-133 Q1 / Q2②（PS04 第一阶段）） */
import { run as templateRun } from "../../tools/autopilot/unit-templates/suite-evidence.mjs";
export const metadata = {
  "id": "BG-010-ps04-phase1-readonly-chain",
  "source_backlog_id": "MSG-20261003-133 Q1 / Q2②（PS04 第一阶段）",
  "title": "PS04 Phase 1：独立站/拒付内部只读链（事实 → 证据装配 → 资格输入 → claim-ready 证据包 → 只读查询）",
  "scope": "仅 fixture/CSV/FILE_UPLOAD；不接真实 PSP、不实现 dispute.submit；lineage/deadline fail-closed；金额口径互不等同",
  "acceptance_criteria": "事实可追溯、tenant/account lineage 完整、deadline fail-closed、证据包 deterministic、qualification 后端强制、零外调/零 submission/零 recovered-billable 自证",
  "dependencies": [
    "BG-011-ps04-enum-migration-d1-d3"
  ],
  "risk_class": "MEDIUM",
  "ARCH_REVIEW_REQUIRED": false,
  "HOST_ACTION_REQUIRED": false,
  "HOLD_EXTERNAL": true,
  "allowed_files": [
    "apps/api/src/services/**",
    "apps/api/src/__tests__/**"
  ],
  "boundary": "READ_ONLY / NO_EXTERNAL_PSP / NO_DISPUTE_SUBMIT",
  "required_tests": [
    "payment",
    "chargeback",
    "evidence"
  ],
  "priority": "P1",
  "template": "suite-evidence",
  "filters": [
    "settlement",
    "evidence"
  ]
};
export async function run(context) { return templateRun({ ...context, metadata }); }
