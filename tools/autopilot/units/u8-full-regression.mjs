/** u8：Full Regression —— 全量 API 套件（TRACK A 具名项）。 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export async function run({ root }) {
  const api = path.join(root, 'apps', 'api');
  const started = Date.now();
  let out = '';
  let ok = true;
  try {
    out = execFileSync('npx', ['vitest', 'run'], { cwd: api, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    ok = false;
    out = String(error.stdout ?? '') + String(error.stderr ?? '');
  }
  const lines = out.split('\n');
  const summary = lines.filter((line) => /Test Files|Tests /.test(line)).slice(-2).join(' | ');
  const failures = lines.filter((line) => /^\s*FAIL /.test(line)).slice(0, 10);
  const durationMs = Date.now() - started;
  const detail = (ok ? 'FULL_REGRESSION_PASS ' : 'FULL_REGRESSION_FAIL ') + summary + ' durationMs=' + durationMs + (failures.length ? ' failures=' + failures.join(' ; ') : '');
  fs.appendFileSync(path.join(root, '.autopilot', 'RUN_LOG.md'), '\n## ' + new Date().toISOString() + ' — CONTINUOUS u8-full-regression\n- ' + detail + '\n', 'utf8');
  return { ok, detail };
}
