/** u4：空库迁移 + 触发器清单 + DB 约束守卫（发布证据单元）。 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export async function run({ root }) {
  const results = [];
  try {
    const out = execFileSync('node', ['tools/smoke/deploy-smoke.mjs'], { cwd: root, encoding: 'utf8', shell: true });
    results.push(/DEPLOY_SMOKE_OK/.test(out) ? 'deploy-smoke=OK' : 'deploy-smoke=UNEXPECTED_OUTPUT');
  } catch (error) {
    results.push('deploy-smoke=FAIL ' + String(error.stdout ?? error.message).slice(0, 160));
  }
  try {
    const sql = execFileSync('node', ['tools/tenant-triggers/emit-check-sql.mjs'], { cwd: root, encoding: 'utf8', shell: true });
    const envText = fs.readFileSync(path.join(root, 'apps', 'api', '.env'), 'utf8');
    const urlLine = envText.split(/\r?\n/).find((line) => line.trim().startsWith('DATABASE_URL=')) ?? '';
    const rawUrl = urlLine.slice(urlLine.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    const parsed = /postgresql:\/\/([^:]+):([^@]+)@[^:/]+:\d+\/([^?]+)/.exec(rawUrl);
    if (!parsed) {
      results.push('trigger-inventory=DATABASE_URL_UNPARSEABLE');
    } else {
      const res = spawnSync(
        'docker',
        ['exec', '-i', '-e', 'PGPASSWORD=' + parsed[2], 'crossclaim-postgres', 'psql', '-h', '127.0.0.1', '-U', parsed[1], '-d', parsed[3], '-v', 'ON_ERROR_STOP=1', '-f', '-'],
        { input: sql, encoding: 'utf8' },
      );
      const out = String(res.stdout ?? '') + String(res.stderr ?? '');
      results.push(
        res.status === 0 && /OK: required tenant triggers/.test(out)
          ? 'trigger-inventory=OK'
          : 'trigger-inventory=FAIL status=' + String(res.status) + ' ' + out.replace(/\s+/g, ' ').slice(0, 200),
      );
    }
  } catch (error) {
    const detailText = String(error.stderr ?? '') || String(error.message ?? '') || String(error.stdout ?? '');
    results.push('trigger-inventory=FAIL ' + detailText.replace(/\s+/g, ' ').slice(0, 200));
  }
  try {
    const out = execFileSync('npx', ['vitest', 'run', 'db-constraint-coverage'], { cwd: path.join(root, 'apps', 'api'), encoding: 'utf8', shell: true });
    results.push(/Tests\s+\d+ passed/.test(out) ? 'constraint-guard=OK' : 'constraint-guard=UNKNOWN');
  } catch {
    results.push('constraint-guard=FAIL');
  }
  const ok = results.every((row) => row.endsWith('=OK'));
  const detail = results.join(' | ');
  fs.appendFileSync(path.join(root, '.autopilot', 'RUN_LOG.md'), '\n## ' + new Date().toISOString() + ' — CONTINUOUS u4-fresh-db-verify\n- ' + detail + '\n', 'utf8');
  return { ok, detail };
}
