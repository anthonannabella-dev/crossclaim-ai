#!/usr/bin/env node
/**
 * 记录 Layer 1 实证（CHANGE A · MSG-20261003-135）。
 * ---------------------------------------------------------------
 * 每条实证都必须**绑定 acceptance HEAD**：final-status 只在 `evidence[key].head === HEAD` 时判 true。
 * 不是「跑过就永久有效」——换 HEAD 后必须重跑并重新记录。
 *
 * 用法：
 *   node tools/autopilot/record-evidence.mjs <key> "<detail>" [--skipped N] [--head <sha>]
 *   node tools/autopilot/record-evidence.mjs --list
 *
 * keys: pg_regression | fresh_db_migration | typecheck_api | typecheck_web |
 *       tests_no_skipped | docs_sync | schema_invariants | negative_paths | pg_e2e_real
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..');
const STATE = path.join(ROOT, '.autopilot', 'STATE.json');

const KNOWN_KEYS = [
  'pg_regression',
  'fresh_db_migration',
  'typecheck_api',
  'typecheck_web',
  'tests_no_skipped',
  'docs_sync',
  'schema_invariants',
  'negative_paths',
  'pg_e2e_real',
];

const argv = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));

if (argv.includes('--list') || argv.length === 0) {
  console.log(JSON.stringify({ known_keys: KNOWN_KEYS, recorded: state.evidence ?? {} }, null, 2));
  process.exit(0);
}

const key = argv[0];
if (!KNOWN_KEYS.includes(key)) {
  console.error('UNKNOWN_EVIDENCE_KEY=' + key + ' known=' + KNOWN_KEYS.join(','));
  process.exit(1);
}

const detail = argv[1] ?? '';
const skippedFlag = argv.indexOf('--skipped');
const headFlag = argv.indexOf('--head');
const short = (sha) => sha.slice(0, 7);
const head =
  headFlag >= 0
    ? short(String(argv[headFlag + 1] ?? ''))
    : short(execFileSync('git', ['-c', 'safe.directory=' + ROOT, '-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());

const entry = { head, at: new Date().toISOString(), detail };
if (skippedFlag >= 0) entry.skipped = Number(argv[skippedFlag + 1] ?? '0');

state.evidence = { ...(state.evidence ?? {}), [key]: entry };
fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n', 'utf8');
console.log('EVIDENCE_RECORDED=' + key + ' head=' + head + ' detail=' + detail);
