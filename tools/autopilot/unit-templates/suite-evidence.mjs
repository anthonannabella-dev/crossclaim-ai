/** 模板 suite-evidence：按 metadata.filters 运行对应测试套件并留档。 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export async function run({ root, metadata }) {
  const filters = metadata.filters ?? [];
  let out = "";
  try {
    out = execFileSync('npx', ['vitest', 'run', ...filters], { cwd: path.join(root, 'apps', 'api'), encoding: 'utf8', shell: true, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    out = String(error.stdout ?? '') + String(error.stderr ?? '');
    const tail = out.split('\n').filter((line) => /Tests |FAIL/.test(line)).slice(-6).join(' | ');
    return { ok: false, detail: metadata.id + ' FAILED ' + tail };
  }
  const summary = out.split('\n').filter((line) => /Test Files|Tests /.test(line)).slice(-2).join(' | ');
  fs.appendFileSync(path.join(root, '.autopilot', 'RUN_LOG.md'), '\n## ' + new Date().toISOString() + ' — BACKLOG ' + metadata.id + '\n- ' + metadata.title + '\n- ' + summary + '\n', 'utf8');
  return { ok: true, detail: summary };
}
