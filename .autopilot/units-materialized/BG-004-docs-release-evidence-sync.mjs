/** materialized by GLOBAL BACKLOG DISPATCHER（source_backlog_id=REGISTER-A20（HTTP/DB/Schema/Frontend/Tests/CI/Docs PARTIAL）） */
import { run as templateRun } from "../../tools/autopilot/unit-templates/doc-sync.mjs";
export const metadata = {
  "id": "BG-004-docs-release-evidence-sync",
  "source_backlog_id": "REGISTER-A20（HTTP/DB/Schema/Frontend/Tests/CI/Docs PARTIAL）",
  "title": "文档与发布证据同步守卫（README / API.md / 差集登记表 ↔ 代码）",
  "scope": "核对文档声明与最新代码事实",
  "acceptance_criteria": "doc-sync 守卫全绿",
  "dependencies": [],
  "risk_class": "LOW",
  "ARCH_REVIEW_REQUIRED": false,
  "HOST_ACTION_REQUIRED": false,
  "HOLD_EXTERNAL": true,
  "allowed_files": [
    "README.md",
    "API.md",
    "docs/releases/**"
  ],
  "boundary": "DOC_ONLY",
  "required_tests": [
    "doc-sync-guard"
  ],
  "priority": "P2",
  "template": "doc-sync",
  "filters": []
};
export async function run(context) { return templateRun({ ...context, metadata }); }
