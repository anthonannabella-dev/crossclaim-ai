/** 模板 doc-sync：核对 README / API.md / STATE 与最新代码事实。 */
import fs from 'node:fs';
import path from 'node:path';

export async function run({ root, metadata }) {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'API.md'), 'utf8');
  const state = JSON.parse(fs.readFileSync(path.join(root, '.autopilot', 'STATE.json'), 'utf8'));

  const schemaText = fs.readFileSync(path.join(root, 'apps/api/prisma/schema.prisma'), 'utf8');
  const actualModels = (schemaText.match(/^model\s+\w+\s*\{/gm) ?? []).length;
  const actualMigrations = fs.readdirSync(path.join(root, 'apps/api/prisma/migrations'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;

  const checks = [
    ['readme_model_count', readme.includes('领域模型 **' + actualModels + ' 个')],
    ['readme_migrations', readme.includes('**' + actualMigrations + ' 条迁移**')],
    ['api_return_evidence_route', api.includes('/customs-entry-facts/:entryFactId/return-claim-evidence')],
    ['autopilot_mode_continuous', state.autopilot_mode === 'CONTINUOUS'],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  const ok = failed.length === 0;
  const detail = ok ? metadata.id + ' doc-sync=OK' : metadata.id + ' doc-sync=DRIFT ' + failed.join(',');
  fs.appendFileSync(path.join(root, '.autopilot', 'RUN_LOG.md'), '\n## ' + new Date().toISOString() + ' — BACKLOG ' + metadata.id + '\n- ' + detail + '\n', 'utf8');
  return { ok, detail };
}
