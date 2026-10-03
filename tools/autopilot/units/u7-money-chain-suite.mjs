/** u7：资金链（R45/R46）套件回归证据。 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FILTERS = [
  'settlement',
  'billing',
  'fee',
  'commission',
  'platform-write-ledger',
  'reconciliation',
];

export async function run({ root }) {
  let out = '';
  try {
    out = execFileSync('npx', ['vitest', 'run', ...FILTERS], { cwd: path.join(root, 'apps', 'api'), encoding: 'utf8', shell: true });
  } catch (error) {
    out = String(error.stdout ?? '') + String(error.stderr ?? '');
    const tail = out.split('\n').filter((line) => /Tests |FAIL/.test(line)).slice(-8).join(' | ');
    return { ok: false, detail: 'MONEY_CHAIN_SUITE_FAILED ' + tail };
  }
  const summary = out.split('\n').filter((line) => /Test Files|Tests /.test(line)).slice(-2).join(' | ');
  fs.appendFileSync(path.join(root, '.autopilot', 'RUN_LOG.md'), '\n## ' + new Date().toISOString() + ' — CONTINUOUS u7-money-chain-suite\n- ' + summary + '\n', 'utf8');
  return { ok: true, detail: summary };
}
