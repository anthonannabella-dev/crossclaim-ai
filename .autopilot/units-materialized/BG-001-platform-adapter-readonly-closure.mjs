/** materialized by GLOBAL BACKLOG DISPATCHER（source_backlog_id=REGISTER-A1（Platform Recovery PARTIAL）） */
import { run as templateRun } from "../../tools/autopilot/unit-templates/suite-evidence.mjs";
export const metadata = {
  "id": "BG-001-platform-adapter-readonly-closure",
  "source_backlog_id": "REGISTER-A1（Platform Recovery PARTIAL）",
  "title": "平台域只读 adapter 闭环证据（Amazon 只读 adapter + 连接/账号 lineage + opportunity 信号）",
  "scope": "核对平台域只读链当前实现状态并留档（adapter capability → connection/account lineage → opportunity signal）",
  "acceptance_criteria": "相关套件全绿；证据写入 RUN_LOG；零外写",
  "dependencies": [],
  "risk_class": "LOW",
  "ARCH_REVIEW_REQUIRED": false,
  "HOST_ACTION_REQUIRED": false,
  "HOLD_EXTERNAL": true,
  "allowed_files": [
    "apps/api/src/**（只读测试）",
    ".autopilot/RUN_LOG.md"
  ],
  "boundary": "READ_ONLY / NO_EXTERNAL_WRITE / NO_PRODUCTION_CREDENTIALS",
  "required_tests": [
    "adapter-capability",
    "amazon",
    "connection"
  ],
  "priority": "P1",
  "template": "suite-evidence",
  "filters": [
    "adapter-capability",
    "amazon",
    "connection"
  ]
};
export async function run(context) { return templateRun({ ...context, metadata }); }
