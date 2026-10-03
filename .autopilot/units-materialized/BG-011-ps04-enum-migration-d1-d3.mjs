/** materialized by GLOBAL BACKLOG DISPATCHER（source_backlog_id=MSG-20261003-133 Q1（仅批准 D1–D3 枚举）） */
import { run as templateRun } from "../../tools/autopilot/unit-templates/suite-evidence.mjs";
export const metadata = {
  "id": "BG-011-ps04-enum-migration-d1-d3",
  "source_backlog_id": "MSG-20261003-133 Q1（仅批准 D1–D3 枚举）",
  "title": "PS04 D1–D3 枚举迁移（RecoveryDomain += INDEPENDENT_SITE；Channel += SHOPIFY/STRIPE/PAYPAL；RouteTarget += PAYMENT_PROCESSOR）",
  "scope": "枚举迁移必须先独立落地；不含 D4；不改其它 Schema",
  "acceptance_criteria": "migration 可从空库执行；architecture-contract 通过；业务代码使用新值前先完成本项",
  "dependencies": [],
  "risk_class": "MEDIUM",
  "ARCH_REVIEW_REQUIRED": false,
  "HOST_ACTION_REQUIRED": false,
  "HOLD_EXTERNAL": true,
  "allowed_files": [
    "apps/api/prisma/migrations/**",
    "apps/api/prisma/schema.prisma"
  ],
  "boundary": "APPROVED_SCHEMA_ONLY_D1_D3",
  "required_tests": [
    "architecture-contract"
  ],
  "priority": "P0",
  "template": "suite-evidence",
  "filters": [
    "architecture-contract"
  ]
};
export async function run(context) { return templateRun({ ...context, metadata }); }
