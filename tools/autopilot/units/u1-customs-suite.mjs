
/** u1：运行 Customs 全链测试套件并留档（证据单元）。 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export async function run({ root }) {
  const api = path.join(root, 'apps', 'api');
  const filters = [
    'customs-return-matching',
    'customs-return-fact-store-db',
    'customs-return-claim-evidence-db',
    'customs-return-claim-evidence-view',
    'customs-return-claim-evidence-http-e2e-db',
    'customer-qualification-gate',
    'recovery-qualification-store-db',
    'enterprise-trust-claims',
    'db-constraint-coverage',
  ];
  let out = '';
  try {
    out = execFileSync('npx', ['vitest', 'run', ...filters], { cwd: api, encoding: 'utf8', shell: true });
  } catch (error) {
    out = String(error.stdout ?? '') + String(error.stderr ?? '');
    const tail = out.split('\n').filter((line) => /Tests |FAIL/.test(line)).slice(-6).join(' | ');
    return { ok: false, detail: 'CUSTOMS_SUITE_FAILED ' + tail };
  }
  const summary = out.split('\n').filter((line) => /Test Files|Tests /.test(line)).slice(-2).join(' | ');
  fs.appendFileSync(
    path.join(root, '.autopilot', 'RUN_LOG.md'),
    '\n## ' + new Date().toISOString() + ' — CONTINUOUS u1-customs-suite\n- ' + summary + '\n',
    'utf8',
  );
  return { ok: true, detail: summary };
}
