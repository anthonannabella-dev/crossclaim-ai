#!/usr/bin/env node
/**
 * 查询当前 HEAD 的 GitHub Actions 结果并写入 STATE（供 final-status 的 full_ci_success_on_head 判定使用）。
 * · 仅读取；不触发任何写操作。凭证从 C:\\Users\\os\\.git-credentials 读取，绝不打印。
 * · 离线 / 无 token → 记 UNKNOWN（保守；不得自证 success）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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
let lastSuccessHead = '';
let lastSuccessRun = '';
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

// 追加：最近一次成功的 CI（用于「簿记提交不使产品实证失效」的验收规则）
if (sha && auth) {
  try {
    const res = await fetch('https://api.github.com/repos/' + REPO + '/actions/runs?branch=gate/7-commercial-validation&per_page=15', {
      headers: { Authorization: 'Bearer ' + auth, Accept: 'application/vnd.github+json', 'User-Agent': 'crossclaim-codex-ci' },
    });
    if (res.ok) {
      const json2 = await res.json();
      const successRun = (json2.workflow_runs ?? []).find((item) => item.status === 'completed' && item.conclusion === 'success');
      if (successRun) {
        lastSuccessHead = String(successRun.head_sha).slice(0, 7);
        lastSuccessRun = String(successRun.id);
      }
    }
  } catch {
    /* 保持既有值 */
  }
}

const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
state.ci_status_head = sha.slice(0, 7);
state.ci_status = status === "success" ? "success" : status;
state.ci_run_id = runId;
state.ci_checked_at = new Date().toISOString();
if (lastSuccessHead) state.ci_last_success_head = lastSuccessHead;
if (lastSuccessRun) state.ci_last_success_run = lastSuccessRun;
fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n", "utf8");
console.log("CI_STATUS=" + state.ci_status + " HEAD=" + state.ci_status_head + " RUN=" + runId);
