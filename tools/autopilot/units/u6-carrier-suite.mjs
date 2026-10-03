/** u6：Carrier 全链套件回归证据。 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FILTERS = [
  'carrier-auth-account-discovery',
  'carrier-tracking-read',
  'carrier-invoice-pod-read',
  'carrier-evidence-bundle',
  'carrier-sla-eligibility',
  'carrier-recovery-estimate',
  'carrier-claim-package',
  'carrier-manual-submission',
  'carrier-claim-response',
  'carrier-connector-capability',
];

export async function run({ root }) {
  let out = '';
  try {
    out = execFileSync('npx', ['vitest', 'run', ...FILTERS], { cwd: path.join(root, 'apps', 'api'), encoding: 'utf8', shell: true });
  } catch (error) {
    out = String(error.stdout ?? '') + String(error.stderr ?? '');
    const tail = out.split('\n').filter((line) => /Tests |FAIL/.test(line)).slice(-6).join(' | ');
    return { ok: false, detail: 'CARRIER_SUITE_FAILED ' + tail };
  }
  const summary = out.split('\n').filter((line) => /Test Files|Tests /.test(line)).slice(-2).join(' | ');
  fs.appendFileSync(path.join(root, '.autopilot', 'RUN_LOG.md'), '\n## ' + new Date().toISOString() + ' — CONTINUOUS u6-carrier-suite\n- ' + summary + '\n', 'utf8');
  return { ok: true, detail: summary };
}
