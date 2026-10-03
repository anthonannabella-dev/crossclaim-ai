/** 模板 host-required-register：只登记 HOST_ACTION_REQUIRED，不执行任何动作。 */
import fs from 'node:fs';
import path from 'node:path';

export async function run({ root, metadata }) {
  const statePath = path.join(root, '.autopilot', 'STATE.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.host_action_required = [...new Set([...(state.host_action_required ?? []), metadata.id])];
  state.host_action_required_note = metadata.scope;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.appendFileSync(path.join(root, '.autopilot', 'RUN_LOG.md'), '\n## ' + new Date().toISOString() + ' — HOST_ACTION_REQUIRED 登记 ' + metadata.id + '\n- ' + metadata.title + '（未执行任何动作）\n', 'utf8');
  return { ok: true, detail: 'HOST_ACTION_REQUIRED registered (no action taken)' };
}
