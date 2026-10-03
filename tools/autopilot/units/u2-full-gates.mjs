
/** u2：运行全量闸门并留档（证据单元）。 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export async function run({ root }) {
  const results = [];
  for (const [label, cmd, cwd] of [
    ['tsc api', 'npx tsc --noEmit', path.join(root, 'apps', 'api')],
    ['tsc web', 'npx tsc --noEmit', path.join(root, 'apps', 'web')],
    ['api-contract', 'node tools/api-contract/check-routes.mjs --root .', root],
    ['audit-coverage', 'node tools/audit-coverage/check-audit-actions.mjs --root .', root],
    ['autopilot-rules', 'node tools/autopilot/check-autopilot-rules.mjs --root .', root],
  ]) {
    try {
      execFileSync(cmd, { cwd, shell: true, stdio: 'ignore' });
      results.push(label + '=OK');
    } catch {
      results.push(label + '=FAIL');
    }
  }
  const ok = results.every((row) => row.endsWith('=OK'));
  const detail = results.join(' ');
  fs.appendFileSync(path.join(root, '.autopilot', 'RUN_LOG.md'), '\n## ' + new Date().toISOString() + ' — CONTINUOUS u2-full-gates\n- ' + detail + '\n', 'utf8');
  return { ok, detail };
}
