/** u5：文档同步守卫（README / API.md 与最新能力一致）。 */
import fs from 'node:fs';
import path from 'node:path';

export async function run({ root }) {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'API.md'), 'utf8');
  const state = JSON.parse(fs.readFileSync(path.join(root, '.autopilot', 'STATE.json'), 'utf8'));
  
const schemaText = fs.readFileSync(path.join(root, 'apps/api/prisma/schema.prisma'), 'utf8');
const actualModels = (schemaText.match(/^model\s+\w+\s*\{/gm) ?? []).length;
const actualMigrations = fs.readdirSync(path.join(root, 'apps/api/prisma/migrations'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;

const checks = [];
  checks.push(['readme_counts_delegated', readme.includes('由 CI/runtime 检测') && !/领域模型 \*\*\d+ 个/.test(readme)]);
  
  checks.push(['api_return_evidence_route', api.includes('/customs-entry-facts/:entryFactId/return-claim-evidence')]);
  checks.push(['api_customs_start_route', api.includes('/customs-opportunities/:id/start-recovery')]);
  checks.push(['autopilot_mode_recorded', state.autopilot_mode === 'CONTINUOUS' && state.heartbeat_role === 'LIVENESS_ONLY']);
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  const ok = failed.length === 0;
  const detail = ok ? 'doc-sync=OK (' + checks.length + ' checks)' : 'doc-sync=DRIFT ' + failed.join(',');
  fs.appendFileSync(path.join(root, '.autopilot', 'RUN_LOG.md'), '\n## ' + new Date().toISOString() + ' — CONTINUOUS u5-doc-sync-guard\n- ' + detail + '\n', 'utf8');
  return { ok, detail };
}
