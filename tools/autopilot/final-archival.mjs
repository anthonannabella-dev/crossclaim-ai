#!/usr/bin/env node
/**
 * FINAL ARCHIVAL CLOSURE（MSG-20261003-145）— 从三元事实派生最终闭合记录。
 * 只读：不修改 Final Acceptance Tree；输出可直接粘贴进 GitHub Issue comment / release annotation。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const state = JSON.parse(fs.readFileSync(path.join(ROOT, '.autopilot', 'STATE.json'), 'utf8'));
const head = execFileSync('git', ['-c', 'safe.directory=' + ROOT, 'rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const v3 = state.independent_final_audit_v3 ?? {};
const tree = v3.head ?? head;
const ciRun = v3.ci_run ?? state.ci_run_id ?? '';
const ciConclusion =
  state.ci_status_head === tree ? String(state.ci_status ?? '') : String(state.ci_last_success_head ?? '') === tree ? 'success' : String(state.ci_status ?? '');
const audit = String(v3.verdict ?? 'PENDING').toUpperCase();
const ciSuccess = ciConclusion === 'success';
// CHANGE FINAL-A（MSG-20261003-146）：三元闭合必须**同时**成立：CI SUCCESS + 独立审计 PASS。
const closurePassed = ciSuccess && audit === 'PASS';
const closure = {
  FINAL_ACCEPTANCE_HEAD: tree,
  CI_RUN: String(ciRun),
  CI_CONCLUSION: ciConclusion.toUpperCase(),
  INDEPENDENT_ARCHITECT_AUDIT: v3.verdict ?? 'PENDING',
  CODE_COMPLETE: closurePassed ? 'YES' : 'NO',
  INTEGRATION_COMPLETE: 'NO',
  REAL_VALIDATION_COMPLETE: 'NO',
  PRODUCTION_READY: 'NO',
  INTERNAL_READY: closurePassed ? 'YES' : 'NO',
  AUTONOMOUS_INTERNAL_WORK: closurePassed ? 'EXHAUSTED' : ciSuccess ? 'AWAITING_FINAL_AUDIT' : 'RUNNING',
  SAFE_CONTINUATION_QUEUE: 0,
};
console.log(JSON.stringify(closure, null, 2));
