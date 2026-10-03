#!/usr/bin/env node
/**
 * 查询当前 HEAD 的 GitHub Actions 结果并写入 STATE（供 final-status 的 full_ci_success_on_head 判定使用）。
 * · 仅读取；不触发任何写操作。凭证从 C:\\Users\\os\\.git-credentials 读取，绝不打印。
 * · 离线 / 无 token → 记 UNKNOWN（保守；不得自证 success）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..');
const STATE = path.join(ROOT, '.autopilot', 'STATE.json');
const REPO = 'anthonannabella-dev/crossclaim-ai';

function head() {
  try {
    return execFileSync('git', ['-c', 'safe.directory=' + ROOT, 'rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function token() {
  try {
    const raw = fs.readFileSync('C:\\Users\\os\\.git-credentials', 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^https?:\/\/[^:@/]+:([^@/]+)@github\.com/.exec(line.trim());
      if (m) return m[1];
    }
  } catch {
    return '';
  }
  return '';
}

const sha = head();
const auth = token();
let status = 'UNKNOWN';
let runId = '';
if (sha && auth) {
  try {
    const res = await fetch('https://api.github.com/repos/' + REPO + '/actions/runs?head_sha=' + sha + '&per_page=1', {
      headers: { Authorization: "Bearer " + auth, Accept: "application/vnd.github+json", "User-Agent": "crossclaim-codex-ci" },
    });
    if (res.ok) {
      const json = await res.json();
      const run = (json.workflow_runs ?? [])[0];
      if (run) {
        runId = String(run.id);
        status = run.status === 'completed' ? String(run.conclusion) : String(run.status);
      }
    }
  } catch {
    status = 'UNKNOWN';
  }
}

const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
state.ci_status_head = sha.slice(0, 7);
state.ci_status = status === "success" ? "success" : status;
state.ci_run_id = runId;
state.ci_checked_at = new Date().toISOString();
fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n", "utf8");
console.log("CI_STATUS=" + state.ci_status + " HEAD=" + state.ci_status_head + " RUN=" + runId);
