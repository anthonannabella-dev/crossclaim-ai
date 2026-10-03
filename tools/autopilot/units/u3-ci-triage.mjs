
/** u3：CI 非阻塞巡检（记录 pending / 登记 red 至 SELF_RESOLVE 队列）。 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export async function run({ root }) {
  const statePath = path.join(root, '.autopilot', 'STATE.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  let shas = [];
  try {
    shas = execFileSync('git', ['-c', 'safe.directory=' + root, 'log', '--format=%h', '-5'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    shas = [];
  }
  const pending = [];
  const red = [];
  for (const sha of shas) {
    let line = '';
    try {
      line = execFileSync('node', ['work/scripts/b1-ci-status.mjs', sha], {
        cwd: root,
        encoding: 'utf8',
        shell: true,
      }).trim();
    } catch {
      line = '';
    }
    if (!line) continue;
    if (/completed \| success/.test(line)) continue;
    if (/failure/.test(line)) red.push(line);
    else pending.push(line);
  }
  state.ci_pending = pending;
  state.ci_red = red;
  state.ci_checked_at = new Date().toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  const detail = 'pending=' + pending.length + ' red=' + red.length;
  fs.appendFileSync(path.join(root, '.autopilot', 'RUN_LOG.md'), '\n## ' + new Date().toISOString() + ' — CONTINUOUS u3-ci-triage\n- ' + detail + '\n', 'utf8');
  return { ok: true, detail };
}
